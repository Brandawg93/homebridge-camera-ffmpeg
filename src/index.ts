import type { Buffer } from 'node:buffer'

import type {
  API,
  CharacteristicSetCallback,
  CharacteristicValue,
  DynamicPlatformPlugin,
  HAP,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge'

import type { AutomationReturn } from './autoTypes'
import type { CameraConfig, FfmpegPlatformConfig } from './configTypes'

import { readFileSync } from 'node:fs'
import http from 'node:http'

import {
  APIEvent,
  CharacteristicEventTypes,
  PlatformAccessoryEvent,
} from 'homebridge'
import mqtt from 'mqtt'

import { Logger } from './logger'
import { StreamingDelegate } from './streamingDelegate'

const version = getVersion()

let hap: HAP
let Accessory: typeof PlatformAccessory

const PLUGIN_NAME = 'homebridge-camera-ffmpeg'
const PLATFORM_NAME = 'Camera-ffmpeg'

interface MqttAction {
  accessory: PlatformAccessory
  active: boolean
  doorbell: boolean
}

class FfmpegPlatform implements DynamicPlatformPlugin {
  private readonly log: Logger
  private readonly api: API
  private readonly config: FfmpegPlatformConfig
  private readonly cameraConfigs: Map<string, CameraConfig> = new Map()
  private readonly cachedAccessories: Array<PlatformAccessory> = []
  private readonly accessories: Array<PlatformAccessory> = []
  private readonly motionTimers: Map<string, NodeJS.Timeout> = new Map()
  private readonly doorbellTimers: Map<string, NodeJS.Timeout> = new Map()
  private readonly mqttActions: Map<string, Map<string, Array<MqttAction>>> = new Map()

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = new Logger(log)
    this.api = api
    this.config = config as FfmpegPlatformConfig

    this.config.cameras?.forEach((cameraConfig: CameraConfig) => {
      let error = false

      if (!cameraConfig.name) {
        this.log.error('One of your cameras has no name configured. This camera will be skipped.')
        error = true
      }
      if (!cameraConfig.videoConfig) {
        this.log.error('The videoConfig section is missing from the config. This camera will be skipped.', cameraConfig.name)
        error = true
      } else {
        if (!cameraConfig.videoConfig.source) {
          this.log.error('There is no source configured for this camera. This camera will be skipped.', cameraConfig.name)
          error = true
        } else {
          const sourceArgs = cameraConfig.videoConfig.source.split(/\s+/)
          if (!sourceArgs.includes('-i')) {
            this.log.warn('The source for this camera is missing "-i", it is likely misconfigured.', cameraConfig.name)
          }
        }
        if (cameraConfig.videoConfig.stillImageSource) {
          const stillArgs = cameraConfig.videoConfig.stillImageSource.split(/\s+/)
          if (!stillArgs.includes('-i')) {
            this.log.warn('The stillImageSource for this camera is missing "-i", it is likely misconfigured.', cameraConfig.name)
          }
        }
        if (cameraConfig.videoConfig.vcodec === 'copy' && cameraConfig.videoConfig.videoFilter) {
          this.log.warn('A videoFilter is defined, but the copy vcodec is being used. This will be ignored.', cameraConfig.name)
        }
      }

      if (!error) {
        const uuid = hap.uuid.generate(cameraConfig.name!)
        if (this.cameraConfigs.has(uuid)) {
          // Camera names must be unique
          this.log.warn('Multiple cameras are configured with this name. Duplicate cameras will be skipped.', cameraConfig.name)
        } else {
          this.cameraConfigs.set(uuid, cameraConfig)
        }
      }
    })

    api.on(APIEvent.DID_FINISH_LAUNCHING, this.didFinishLaunching.bind(this))
  }

  addMqttAction(topic: string, message: string, details: MqttAction): void {
    const messageMap = this.mqttActions.get(topic) || new Map()
    const actionArray = messageMap.get(message) || []
    actionArray.push(details)
    messageMap.set(message, actionArray)
    this.mqttActions.set(topic, messageMap)
  }

  setupAccessory(accessory: PlatformAccessory, cameraConfig: CameraConfig): void {
    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log.info('Identify requested.', accessory.displayName)
    })

    const accInfo = accessory.getService(hap.Service.AccessoryInformation)
    if (accInfo) {
      accInfo.setCharacteristic(hap.Characteristic.Manufacturer, cameraConfig.manufacturer || 'Homebridge')
      accInfo.setCharacteristic(hap.Characteristic.Model, cameraConfig.model || 'Camera FFmpeg')
      accInfo.setCharacteristic(hap.Characteristic.SerialNumber, cameraConfig.serialNumber || 'SerialNumber')
      accInfo.setCharacteristic(hap.Characteristic.FirmwareRevision, cameraConfig.firmwareRevision || version)
    }

    const motionSensor = accessory.getService(hap.Service.MotionSensor)
    const doorbell = accessory.getService(hap.Service.Doorbell)
    const doorbellTrigger = accessory.getServiceById(hap.Service.Switch, 'DoorbellTrigger')
    const motionTrigger = accessory.getServiceById(hap.Service.Switch, 'MotionTrigger')
    const doorbellSwitch = accessory.getServiceById(hap.Service.StatelessProgrammableSwitch, 'DoorbellSwitch')

    if (motionSensor) {
      accessory.removeService(motionSensor)
    }
    if (doorbell) {
      accessory.removeService(doorbell)
    }
    if (doorbellTrigger) {
      accessory.removeService(doorbellTrigger)
    }
    if (motionTrigger) {
      accessory.removeService(motionTrigger)
    }
    if (doorbellSwitch) {
      accessory.removeService(doorbellSwitch)
    }

    const delegate = new StreamingDelegate(this.log, cameraConfig, this.api, hap, accessory, this.config.videoProcessor)

    accessory.configureController(delegate.controller)

    if (cameraConfig.videoConfig?.prebuffer) {
      this.log.debug('Start prebuffering...', cameraConfig.name)
      if (delegate.recordingDelegate) {
        delegate.recordingDelegate.startPreBuffer()
      }
    }

    // add motion sensor after accessory.configureController. Secure Video creates it own linked motion service
    if (cameraConfig.motion) {
      this.log.debug('add motion stuff', cameraConfig.name)
      const motionSensor = new hap.Service.MotionSensor(cameraConfig.name)

      if (!accessory.getService(hap.Service.MotionSensor)) {
        accessory.addService(motionSensor)
      } else {
        this.log.debug('found motion sensor service', cameraConfig.name)
      }
      if (cameraConfig.switches) {
        const motionTrigger = new hap.Service.Switch(`${cameraConfig.name} Motion Trigger`, 'MotionTrigger')
        motionTrigger
          .getCharacteristic(hap.Characteristic.On)
          .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            this.motionHandler(accessory, state as boolean, 1)
            callback()
          })
        accessory.addService(motionTrigger)
      }
    }

    // add doorbell  after accessory.configureController. Secure Video creates it own linked doorbell service
    if (cameraConfig.doorbell) {
      const doorbell = new hap.Service.Doorbell(`${cameraConfig.name} Doorbell`)
      if (!accessory.getService(hap.Service.Doorbell)) {
        accessory.addService(doorbell)
      } else {
        this.log.debug('found doorbell sensor service', cameraConfig.name)
      }
      if (cameraConfig.switches) {
        const doorbellTrigger = new hap.Service.Switch(`${cameraConfig.name} Doorbell Trigger`, 'DoorbellTrigger')
        doorbellTrigger
          .getCharacteristic(hap.Characteristic.On)
          .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            this.doorbellHandler(accessory, state as boolean)
            callback()
          })
        accessory.addService(doorbellTrigger)
      }
    }
    /*
    for (let rtp of delegate.controller.streamManagements) {
      this.log.debug("StreamMngt: "+rtp.getService().getCharacteristic(hap.Characteristic.Active).value.toString());
    }
    this.log.debug("recMngt:"+ accessory.getService(hap.Service.CameraRecordingManagement).getCharacteristic(hap.Characteristic.Active).value.toString());
*/
    if (this.config.mqtt) {
      if (cameraConfig.mqtt) {
        if (cameraConfig.mqtt.motionTopic) {
          this.addMqttAction(cameraConfig.mqtt.motionTopic, cameraConfig.mqtt.motionMessage || cameraConfig.name!, { accessory, active: true, doorbell: false })
        }
        if (cameraConfig.mqtt.motionResetTopic) {
          this.addMqttAction(cameraConfig.mqtt.motionResetTopic, cameraConfig.mqtt.motionResetMessage || cameraConfig.name!, { accessory, active: false, doorbell: false })
        }
        if (cameraConfig.mqtt.doorbellTopic) {
          this.addMqttAction(cameraConfig.mqtt.doorbellTopic, cameraConfig.mqtt.doorbellMessage || cameraConfig.name!, { accessory, active: true, doorbell: true })
        }
      }
    }
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Configuring cached bridged accessory...', accessory.displayName)

    const cameraConfig = this.cameraConfigs.get(accessory.UUID)

    if (cameraConfig) {
      this.setupAccessory(accessory, cameraConfig)
    }

    this.cachedAccessories.push(accessory)
  }

  private doorbellHandler(accessory: PlatformAccessory, active = true): AutomationReturn {
    const doorbell = accessory.getService(hap.Service.Doorbell)
    if (doorbell) {
      this.log.debug(`Switch doorbell ${active ? 'on.' : 'off.'}`, accessory.displayName)
      const timeout = this.doorbellTimers.get(accessory.UUID)
      if (timeout) {
        clearTimeout(timeout)
        this.doorbellTimers.delete(accessory.UUID)
      }
      const doorbellTrigger = accessory.getServiceById(hap.Service.Switch, 'DoorbellTrigger')
      if (active) {
        doorbell.updateCharacteristic(hap.Characteristic.ProgrammableSwitchEvent, hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS)
        if (doorbellTrigger) {
          doorbellTrigger.updateCharacteristic(hap.Characteristic.On, true)
          let timeoutConfig = this.cameraConfigs.get(accessory.UUID)?.motionTimeout
          timeoutConfig = timeoutConfig && timeoutConfig > 0 ? timeoutConfig : 1
          const timer = setTimeout(() => {
            this.log.debug('Doorbell handler timeout.', accessory.displayName)
            this.doorbellTimers.delete(accessory.UUID)
            doorbellTrigger.updateCharacteristic(hap.Characteristic.On, false)
          }, timeoutConfig * 1000)
          this.doorbellTimers.set(accessory.UUID, timer)
        }
        return {
          error: false,
          message: 'Doorbell switched on.',
        }
      } else {
        if (doorbellTrigger) {
          doorbellTrigger.updateCharacteristic(hap.Characteristic.On, false)
        }
        return {
          error: false,
          message: 'Doorbell switched off.',
        }
      }
    } else {
      return {
        error: true,
        message: 'Doorbell is not enabled for this camera.',
      }
    }
  }

  private motionHandler(accessory: PlatformAccessory, active = true, minimumTimeout = 0): AutomationReturn {
    const motionSensor = accessory.getService(hap.Service.MotionSensor)
    if (motionSensor) {
      this.log.debug(`Switch motion detect ${active ? 'on.' : 'off.'}`, accessory.displayName)
      const timeout = this.motionTimers.get(accessory.UUID)
      if (timeout) {
        clearTimeout(timeout)
        this.motionTimers.delete(accessory.UUID)
      }
      const motionTrigger = accessory.getServiceById(hap.Service.Switch, 'MotionTrigger')
      const config = this.cameraConfigs.get(accessory.UUID)
      if (active) {
        motionSensor.updateCharacteristic(hap.Characteristic.MotionDetected, true)
        if (motionTrigger) {
          motionTrigger.updateCharacteristic(hap.Characteristic.On, true)
        }
        if (!timeout && config?.motionDoorbell) {
          this.doorbellHandler(accessory, true)
        }
        let timeoutConfig = config?.motionTimeout ?? 1
        if (timeoutConfig < minimumTimeout) {
          timeoutConfig = minimumTimeout
        }
        if (timeoutConfig > 0) {
          const timer = setTimeout(() => {
            this.log.debug('Motion handler timeout.', accessory.displayName)
            this.motionTimers.delete(accessory.UUID)
            motionSensor.updateCharacteristic(hap.Characteristic.MotionDetected, false)
            if (motionTrigger) {
              motionTrigger.updateCharacteristic(hap.Characteristic.On, false)
            }
          }, timeoutConfig * 1000)
          this.motionTimers.set(accessory.UUID, timer)
        }
        return {
          error: false,
          message: 'Motion switched on.',
          cooldownActive: !!timeout,
        }
      } else {
        motionSensor.updateCharacteristic(hap.Characteristic.MotionDetected, false)
        if (motionTrigger) {
          motionTrigger.updateCharacteristic(hap.Characteristic.On, false)
        }
        if (config?.motionDoorbell) {
          this.doorbellHandler(accessory, false)
        }
        return {
          error: false,
          message: 'Motion switched off.',
        }
      }
    } else {
      return {
        error: true,
        message: 'Motion is not enabled for this camera.',
      }
    }
  }

  private httpHandler(fullpath: string, name: string): AutomationReturn {
    const accessory = this.accessories.find((curAcc: PlatformAccessory) => {
      return curAcc.displayName === name
    })
    if (accessory) {
      const path = fullpath.split('/').filter(value => value.length > 0)
      switch (path[0]) {
        case 'motion':
          return this.motionHandler(accessory, path[1] !== 'reset')
          break
        case 'doorbell':
          return this.doorbellHandler(accessory)
          break
        default:
          return {
            error: true,
            message: `First directory level must be "motion" or "doorbell", got "${path[0]}".`,
          }
      }
    } else {
      return {
        error: true,
        message: `Camera "${name}" not found.`,
      }
    }
  }

  didFinishLaunching(): void {
    for (const [uuid, cameraConfig] of this.cameraConfigs) {
      if (cameraConfig.unbridge) {
        const accessory = new Accessory(cameraConfig.name!, uuid)
        this.log.info('Configuring unbridged accessory...', accessory.displayName)
        this.setupAccessory(accessory, cameraConfig)
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory])
        this.accessories.push(accessory)
      } else {
        const cachedAccessory = this.cachedAccessories.find((curAcc: PlatformAccessory) => curAcc.UUID === uuid)
        if (!cachedAccessory) {
          const accessory = new Accessory(cameraConfig.name!, uuid)
          this.log.info('Configuring bridged accessory...', accessory.displayName)
          this.setupAccessory(accessory, cameraConfig)
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
          this.accessories.push(accessory)
        } else {
          this.accessories.push(cachedAccessory)
        }
      }
    }

    if (this.config.mqtt) {
      const portmqtt = this.config.portmqtt || '1883'
      this.log.info('Setting up MQTT connection...')
      const client = mqtt.connect(`${(this.config.tlsmqtt ? 'mqtts://' : 'mqtt://') + this.config.mqtt}:${portmqtt}`, {
        username: this.config.usermqtt,
        password: this.config.passmqtt,
      })
      client.on('connect', () => {
        this.log.info('MQTT connected.')
        for (const [topic] of this.mqttActions) {
          this.log.debug(`Subscribing to MQTT topic: ${topic}`)
          client.subscribe(topic)
        }
      })
      client.on('message', (topic: string, message: Buffer) => {
        const messageMap = this.mqttActions.get(topic)
        if (messageMap) {
          const actionArray = messageMap.get(message.toString())
          if (actionArray) {
            for (const action of actionArray) {
              if (action.doorbell) {
                this.doorbellHandler(action.accessory, action.active)
              } else {
                this.motionHandler(action.accessory, action.active)
              }
            }
          }
        }
      })
    }
    if (this.config.porthttp) {
      this.log.info(`Setting up ${this.config.localhttp ? 'localhost-only ' : ''
      }HTTP server on port ${this.config.porthttp}...`)
      const server = http.createServer()
      const hostname = this.config.localhttp ? 'localhost' : undefined
      server.listen(this.config.porthttp, hostname)
      server.on('request', (request: http.IncomingMessage, response: http.ServerResponse) => {
        let results: AutomationReturn = {
          error: true,
          message: 'Malformed URL.',
        }
        if (request.url) {
          const spliturl = request.url.split('?')
          if (spliturl.length === 2) {
            const name = decodeURIComponent(spliturl[1]).split('=')[0]
            results = this.httpHandler(spliturl[0], name)
          }
        }
        response.writeHead(results.error ? 500 : 200)
        response.write(JSON.stringify(results))
        response.end()
      })
    }

    this.cachedAccessories.forEach((accessory: PlatformAccessory) => {
      const cameraConfig = this.cameraConfigs.get(accessory.UUID)
      if (!cameraConfig || cameraConfig.unbridge) {
        this.log.info('Removing bridged accessory...', accessory.displayName)
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      }
    })
  }
}

function getVersion() {
  const json = JSON.parse(
    readFileSync(
      new URL('../package.json', import.meta.url),
      'utf-8',
    ),
  )
  const version = json.version
  return version
}

// Register our platform with homebridge.
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, FfmpegPlatform)
}
