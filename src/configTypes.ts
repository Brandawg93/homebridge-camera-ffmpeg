import type { PlatformIdentifier, PlatformName } from 'homebridge'

export interface FfmpegPlatformConfig {
  platform: PlatformName | PlatformIdentifier
  name?: string
  videoProcessor?: string
  mqtt?: string
  portmqtt?: number
  tlsmqtt?: boolean
  usermqtt?: string
  passmqtt?: string
  porthttp?: number
  localhttp?: boolean
  cameras?: Array<CameraConfig>
}

export interface CameraConfig {
  name?: string
  manufacturer?: string
  model?: string
  serialNumber?: string
  firmwareRevision?: string
  motion?: boolean
  doorbell?: boolean
  switches?: boolean
  motionTimeout?: number
  motionDoorbell?: boolean
  mqtt?: MqttCameraConfig
  unbridge?: boolean
  videoConfig?: VideoConfig
}

export interface VideoConfig {
  source?: string
  stillImageSource?: string
  returnAudioTarget?: string
  maxStreams?: number
  maxWidth?: number
  maxHeight?: number
  maxFPS?: number
  maxBitrate?: number
  forceMax?: boolean
  vcodec?: string
  packetSize?: number
  videoFilter?: string
  encoderOptions?: string
  mapvideo?: string
  mapaudio?: string
  audio?: boolean
  debug?: boolean
  debugReturn?: boolean
  recording?: boolean
  prebuffer?: boolean
}

export interface MqttCameraConfig {
  motionTopic?: string
  motionMessage?: string
  motionResetTopic?: string
  motionResetMessage?: string
  doorbellTopic?: string
  doorbellMessage?: string
}
