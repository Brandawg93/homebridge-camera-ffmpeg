import type { Socket } from 'node:dgram'

import type {
  API,
  AudioRecordingCodec,
  CameraController,
  CameraControllerOptions,
  CameraStreamingDelegate,
  HAP,
  PlatformAccessory,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
  VideoInfo,
} from 'homebridge'
import type { pickPortOptions } from 'pick-port'

import type { CameraConfig, VideoConfig } from './configTypes.js'
import type { Logger } from './logger.js'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { env } from 'node:process'

import ffmpegPath from 'ffmpeg-for-homebridge'
import {
  APIEvent,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  StreamRequestTypes,
} from 'homebridge'
import pickPort from 'pick-port'

import { FfmpegProcess } from './ffmpeg.js'
import { FRAGMENTS_LENGTH, PREBUFFER_LENGTH, RecordingDelegate } from './recordingDelegate.js'

interface SessionInfo {
  address: string // address of the HAP controller
  ipv6: boolean

  videoPort: number
  videoReturnPort: number
  videoCryptoSuite: SRTPCryptoSuites // should be saved if multiple suites are supported
  videoSRTP: Buffer // key and salt concatenated
  videoSSRC: number // rtp synchronisation source

  audioPort: number
  audioReturnPort: number
  audioCryptoSuite: SRTPCryptoSuites
  audioSRTP: Buffer
  audioSSRC: number
}

interface ResolutionInfo {
  width: number
  height: number
  videoFilter?: string
  snapFilter?: string
  resizeFilter?: string
}

interface ActiveSession {
  mainProcess?: FfmpegProcess
  returnProcess?: FfmpegProcess
  timeout?: NodeJS.Timeout
  socket?: Socket
}

export class StreamingDelegate implements CameraStreamingDelegate {
  private readonly hap: HAP
  private readonly log: Logger
  private readonly cameraName: string
  private readonly unbridge: boolean
  private readonly videoConfig!: VideoConfig
  private readonly videoProcessor: string
  readonly controller: CameraController
  private snapshotPromise?: Promise<Buffer>
  private readonly api: API
  private recording: boolean
  private prebuffer: boolean
  recordingDelegate: RecordingDelegate | null = null

  // keep track of sessions
  pendingSessions: Map<string, SessionInfo> = new Map()
  ongoingSessions: Map<string, ActiveSession> = new Map()
  timeouts: Map<string, NodeJS.Timeout> = new Map()

  constructor(log: Logger, cameraConfig: CameraConfig, videoConfig: VideoConfig, api: API, hap: HAP, accessory: PlatformAccessory, videoProcessor?: string) {
    this.log = log
    this.hap = hap
    this.api = api

    this.cameraName = cameraConfig.name!
    this.unbridge = cameraConfig.unbridge ?? true
    this.videoProcessor = videoProcessor || ffmpegPath as unknown as string || 'ffmpeg'
    this.recording = cameraConfig.videoConfig?.recording ?? false
    this.prebuffer = this.recording && (cameraConfig.videoConfig?.prebuffer ?? false)

    this.log.debug(this.recording ? 'Recording on' : 'recording off')
    this.log.debug(this.prebuffer ? 'Prebuffering on' : 'prebuffering off')

    api.on(APIEvent.SHUTDOWN, () => {
      for (const session in this.ongoingSessions) {
        this.stopStream(session)
      }
    })

    const recordingCodecs: AudioRecordingCodec[] = []

    const samplerate: AudioRecordingSamplerate[] = []
    for (const sr of [AudioRecordingSamplerate.KHZ_32]) {
      samplerate.push(sr)
    }

    for (const type of [AudioRecordingCodecType.AAC_LC]) {
      const entry: AudioRecordingCodec = {
        type,
        bitrateMode: 0,
        samplerate,
        audioChannels: 1,
      }
      recordingCodecs.push(entry)
    }
    this.recordingDelegate = this.recording ? new RecordingDelegate(this.log, this.cameraName, videoConfig, this.api, this.hap, this.videoProcessor) : null

    const options: CameraControllerOptions = {
      cameraStreamCount: videoConfig.maxStreams ?? 2, // HomeKit requires at least 2 streams, but 1 is also just fine
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 30],
            [320, 240, 15], // Apple Watch requires this configuration
            [320, 240, 30],
            [480, 270, 30],
            [480, 360, 30],
            [640, 360, 30],
            [640, 480, 30],
            [1280, 720, 30],
            [1280, 960, 30],
            [1920, 1080, 30],
            [1600, 1200, 30],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
        audio: {
          twoWayAudio: !!videoConfig.returnAudioTarget,
          codecs: [
            {
              type: AudioStreamingCodecType.AAC_ELD,
              samplerate: AudioStreamingSamplerate.KHZ_16,
              /* type: AudioStreamingCodecType.OPUS,
              samplerate: AudioStreamingSamplerate.KHZ_24 */
            },
          ],
        },
      },
      recording: /*! this.recording ? undefined : */ {
        options: {
          prebufferLength: PREBUFFER_LENGTH,
          overrideEventTriggerOptions: [hap.EventTriggerOption.MOTION, hap.EventTriggerOption.DOORBELL],
          mediaContainerConfiguration: [{
            type: 0,
            fragmentLength: FRAGMENTS_LENGTH,
          }],
          video: {
            type: hap.VideoCodecType.H264,
            parameters: {
              levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
              profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            },
            resolutions: [
              [320, 180, 30],
              [320, 240, 15], // Apple Watch requires this configuration
              [320, 240, 30],
              [480, 270, 30],
              [480, 360, 30],
              [640, 360, 30],
              [640, 480, 30],
              [1280, 720, 30],
              [1280, 960, 30],
              [1920, 1080, 30],
              [1600, 1200, 30],
            ],
          },
          audio: {
            codecs: recordingCodecs,

          },
        },
        delegate: this.recordingDelegate!,
      },
    }
    this.controller = new hap.CameraController(options)
    // if(this.prebuffer) this.recordingDelegate.startPreBuffer();
  }

  private determineResolution(request: SnapshotRequest | VideoInfo, isSnapshot: boolean): ResolutionInfo {
    const resInfo: ResolutionInfo = {
      width: request.width,
      height: request.height,
    }
    if (!isSnapshot) {
      if (this.videoConfig.maxWidth !== undefined
        && (this.videoConfig.forceMax || request.width > this.videoConfig.maxWidth)) {
        resInfo.width = this.videoConfig.maxWidth
      }
      if (this.videoConfig.maxHeight !== undefined
        && (this.videoConfig.forceMax || request.height > this.videoConfig.maxHeight)) {
        resInfo.height = this.videoConfig.maxHeight
      }
    }

    const filters: Array<string> = this.videoConfig.videoFilter?.split(',') || []
    const noneFilter = filters.indexOf('none')
    if (noneFilter >= 0) {
      filters.splice(noneFilter, 1)
    }
    resInfo.snapFilter = filters.join(',')
    if ((noneFilter < 0) && (resInfo.width > 0 || resInfo.height > 0)) {
      resInfo.resizeFilter = `scale=${resInfo.width > 0 ? `'min(${resInfo.width},iw)'` : 'iw'}:${resInfo.height > 0 ? `'min(${resInfo.height},ih)'` : 'ih'
      }:force_original_aspect_ratio=decrease`
      filters.push(resInfo.resizeFilter)
      filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2') // Force to fit encoder restrictions
    }

    if (filters.length > 0) {
      resInfo.videoFilter = filters.join(',')
    }

    return resInfo
  }

  fetchSnapshot(snapFilter?: string): Promise<Buffer> {
    this.snapshotPromise = new Promise((resolve, reject) => {
      const startTime = Date.now()
      const ffmpegArgs = `${this.videoConfig.stillImageSource || this.videoConfig.source! // Still
      } -frames:v 1${snapFilter ? ` -filter:v ${snapFilter}` : ''
      } -f image2 -`
      + ` -hide_banner`
      + ` -loglevel error`

      this.log.debug(`Snapshot command: ${this.videoProcessor} ${ffmpegArgs}`, this.cameraName, this.videoConfig.debug)
      const ffmpeg = spawn(this.videoProcessor, ffmpegArgs.split(/\s+/), { env })

      let snapshotBuffer = Buffer.alloc(0)
      ffmpeg.stdout.on('data', (data) => {
        snapshotBuffer = Buffer.concat([snapshotBuffer, data])
      })
      ffmpeg.on('error', (error: Error) => {
        reject(new Error(`FFmpeg process creation failed: ${error.message}`))
      })
      ffmpeg.stderr.on('data', (data) => {
        data.toString().split('\n').forEach((line: string) => {
          if (this.videoConfig.debug && line.length > 0) { // For now only write anything out when debug is set
            this.log.error(line, `${this.cameraName}] [Snapshot`)
          }
        })
      })
      ffmpeg.on('close', () => {
        if (snapshotBuffer.length > 0) {
          resolve(snapshotBuffer)
        } else {
          reject(new Error('Failed to fetch snapshot.'))
        }

        setTimeout(() => {
          this.snapshotPromise = undefined
        }, 3 * 1000) // Expire cached snapshot after 3 seconds

        const runtime = (Date.now() - startTime) / 1000
        let message = `Fetching snapshot took ${runtime} seconds.`
        if (runtime < 5) {
          this.log.debug(message, this.cameraName, this.videoConfig.debug)
        } else {
          if (!this.unbridge) {
            message += ' It is highly recommended you switch to unbridge mode.'
          }
          if (runtime < 22) {
            this.log.warn(message, this.cameraName)
          } else {
            message += ' The request has timed out and the snapshot has not been refreshed in HomeKit.'
            this.log.error(message, this.cameraName)
          }
        }
      })
    })
    return this.snapshotPromise
  }

  resizeSnapshot(snapshot: Buffer, resizeFilter?: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const ffmpegArgs = `-i pipe:` // Resize
        + ` -frames:v 1${resizeFilter ? ` -filter:v ${resizeFilter}` : ''
        } -f image2 -`

      this.log.debug(`Resize command: ${this.videoProcessor} ${ffmpegArgs}`, this.cameraName, this.videoConfig.debug)
      const ffmpeg = spawn(this.videoProcessor, ffmpegArgs.split(/\s+/), { env })

      let resizeBuffer = Buffer.alloc(0)
      ffmpeg.stdout.on('data', (data) => {
        resizeBuffer = Buffer.concat([resizeBuffer, data])
      })
      ffmpeg.on('error', (error: Error) => {
        reject(new Error(`FFmpeg process creation failed: ${error.message}`))
      })
      ffmpeg.on('close', () => {
        resolve(resizeBuffer)
      })
      ffmpeg.stdin.end(snapshot)
    })
  }

  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    const resolution = this.determineResolution(request, true)

    try {
      const cachedSnapshot = !!this.snapshotPromise

      this.log.debug(`Snapshot requested: ${request.width} x ${request.height}`, this.cameraName, this.videoConfig.debug)

      const snapshot = await (this.snapshotPromise || this.fetchSnapshot(resolution.snapFilter))

      this.log.debug(`Sending snapshot: ${resolution.width > 0 ? resolution.width : 'native'} x ${resolution.height > 0 ? resolution.height : 'native'
      }${cachedSnapshot ? ' (cached)' : ''}`, this.cameraName, this.videoConfig.debug)

      const resized = await this.resizeSnapshot(snapshot, resolution.resizeFilter)
      callback(undefined, resized)
    } catch (err) {
      this.log.error(err as string, this.cameraName)
      callback(err as Error)
    }
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    const ipv6 = request.addressVersion === 'ipv6'

    const options: pickPortOptions = {
      type: 'udp',
      ip: ipv6 ? '::' : '0.0.0.0',
      reserveTimeout: 15,
    }
    const videoReturnPort = await pickPort(options)
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource()
    const audioReturnPort = await pickPort(options)
    const audioSSRC = this.hap.CameraController.generateSynchronisationSource()

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,
      ipv6,

      videoPort: request.video.port,
      videoReturnPort,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC,

      audioPort: request.audio.port,
      audioReturnPort,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC,
    }

    const response: PrepareStreamResponse = {
      video: {
        port: videoReturnPort,
        ssrc: videoSSRC,

        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: {
        port: audioReturnPort,
        ssrc: audioSSRC,

        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    }

    this.pendingSessions.set(request.sessionID, sessionInfo)
    callback(undefined, response)
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const sessionInfo = this.pendingSessions.get(request.sessionID)
    if (sessionInfo) {
      const vcodec = this.videoConfig.vcodec || 'libx264'
      const mtu = this.videoConfig.packetSize || 1316 // request.video.mtu is not used
      let encoderOptions = this.videoConfig.encoderOptions
      if (!encoderOptions && vcodec === 'libx264') {
        encoderOptions = '-preset ultrafast -tune zerolatency'
      }

      const resolution = this.determineResolution(request.video, false)

      let fps = (this.videoConfig.maxFPS !== undefined
        && (this.videoConfig.forceMax || request.video.fps > this.videoConfig.maxFPS))
        ? this.videoConfig.maxFPS
        : request.video.fps
      let videoBitrate = (this.videoConfig.maxBitrate !== undefined
        && (this.videoConfig.forceMax || request.video.max_bit_rate > this.videoConfig.maxBitrate))
        ? this.videoConfig.maxBitrate
        : request.video.max_bit_rate

      if (vcodec === 'copy') {
        resolution.width = 0
        resolution.height = 0
        resolution.videoFilter = undefined
        fps = 0
        videoBitrate = 0
      }

      this.log.debug(`Video stream requested: ${request.video.width} x ${request.video.height}, ${request.video.fps} fps, ${request.video.max_bit_rate} kbps`, this.cameraName, this.videoConfig.debug)
      this.log.info(`Starting video stream: ${resolution.width > 0 ? resolution.width : 'native'} x ${resolution.height > 0 ? resolution.height : 'native'}, ${fps > 0 ? fps : 'native'
      } fps, ${videoBitrate > 0 ? videoBitrate : '???'} kbps${this.videoConfig.audio ? (` (${request.audio.codec})`) : ''}`, this.cameraName)

      let ffmpegArgs = this.videoConfig.source!

      ffmpegArgs // Video
        += `${this.videoConfig.mapvideo ? ` -map ${this.videoConfig.mapvideo}` : ' -an -sn -dn'
        } -codec:v ${vcodec
        } -pix_fmt yuv420p`
        + ` -color_range mpeg${fps > 0 ? ` -r ${fps}` : ''
        } -f rawvideo${encoderOptions ? ` ${encoderOptions}` : ''
        }${resolution.videoFilter ? ` -filter:v ${resolution.videoFilter}` : ''
        }${videoBitrate > 0 ? ` -b:v ${videoBitrate}k` : ''
        } -payload_type ${request.video.pt}`

      ffmpegArgs // Video Stream
        += ` -ssrc ${sessionInfo.videoSSRC
        } -f rtp`
        + ` -srtp_out_suite AES_CM_128_HMAC_SHA1_80`
        + ` -srtp_out_params ${sessionInfo.videoSRTP.toString('base64')
        } srtp://${sessionInfo.address}:${sessionInfo.videoPort
        }?rtcpport=${sessionInfo.videoPort}&pkt_size=${mtu}`

      if (this.videoConfig.audio) {
        if (request.audio.codec === AudioStreamingCodecType.OPUS || request.audio.codec === AudioStreamingCodecType.AAC_ELD) {
          ffmpegArgs // Audio
            += `${(this.videoConfig.mapaudio ? ` -map ${this.videoConfig.mapaudio}` : ' -vn -sn -dn')
            + (request.audio.codec === AudioStreamingCodecType.OPUS
              ? ' -codec:a libopus'
              + ' -application lowdelay'
              : ' -codec:a libfdk_aac'
                + ' -profile:a aac_eld')
            } -flags +global_header`
            + ` -f null`
            + ` -ar ${request.audio.sample_rate}k`
            + ` -b:a ${request.audio.max_bit_rate}k`
            + ` -ac ${request.audio.channel
            } -payload_type ${request.audio.pt}`

          ffmpegArgs // Audio Stream
            += ` -ssrc ${sessionInfo.audioSSRC
            } -f rtp`
            + ` -srtp_out_suite AES_CM_128_HMAC_SHA1_80`
            + ` -srtp_out_params ${sessionInfo.audioSRTP.toString('base64')
            } srtp://${sessionInfo.address}:${sessionInfo.audioPort
            }?rtcpport=${sessionInfo.audioPort}&pkt_size=188`
        } else {
          this.log.error(`Unsupported audio codec requested: ${request.audio.codec}`, this.cameraName)
        }
      }

      ffmpegArgs += ` -loglevel level${this.videoConfig.debug ? '+verbose' : ''
      } -progress pipe:1`

      const activeSession: ActiveSession = {}

      activeSession.socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4')
      activeSession.socket.on('error', (err: Error) => {
        this.log.error(`Socket error: ${err.message}`, this.cameraName)
        this.stopStream(request.sessionID)
      })
      activeSession.socket.on('message', () => {
        if (activeSession.timeout) {
          clearTimeout(activeSession.timeout)
        }
        activeSession.timeout = setTimeout(() => {
          this.log.info('Device appears to be inactive. Stopping stream.', this.cameraName)
          this.controller.forceStopStreamingSession(request.sessionID)
          this.stopStream(request.sessionID)
        }, request.video.rtcp_interval * 5 * 1000)
      })
      activeSession.socket.bind(sessionInfo.videoReturnPort)

      activeSession.mainProcess = new FfmpegProcess(this.cameraName, request.sessionID, this.videoProcessor, ffmpegArgs, this.log, this.videoConfig.debug, this, callback)

      if (this.videoConfig.returnAudioTarget) {
        const ffmpegReturnArgs
          = `-hide_banner`
          + ` -protocol_whitelist pipe,udp,rtp,file,crypto`
          + ` -f sdp`
          + ` -c:a libfdk_aac`
          + ` -i pipe:`
          + ` ${this.videoConfig.returnAudioTarget
          } -loglevel level${this.videoConfig.debugReturn ? '+verbose' : ''}`

        const ipVer = sessionInfo.ipv6 ? 'IP6' : 'IP4'

        const sdpReturnAudio
          = `v=0\r\n`
          + `o=- 0 0 IN ${ipVer} ${sessionInfo.address}\r\n`
          + `s=Talk\r\n`
          + `c=IN ${ipVer} ${sessionInfo.address}\r\n`
          + `t=0 0\r\n`
          + `m=audio ${sessionInfo.audioReturnPort} RTP/AVP 110\r\n`
          + `b=AS:24\r\n`
          + `a=rtpmap:110 MPEG4-GENERIC/16000/1\r\n`
          + `a=rtcp-mux\r\n` // FFmpeg ignores this, but might as well
          + `a=fmtp:110 `
          + `profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; `
          + `config=F8F0212C00BC00\r\n`
          + `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${sessionInfo.audioSRTP.toString('base64')}\r\n`
        activeSession.returnProcess = new FfmpegProcess(`${this.cameraName}] [Two-way`, request.sessionID, this.videoProcessor, ffmpegReturnArgs, this.log, this.videoConfig.debugReturn, this)
        activeSession.returnProcess.stdin.end(sdpReturnAudio)
      }

      this.ongoingSessions.set(request.sessionID, activeSession)
      this.pendingSessions.delete(request.sessionID)
    } else {
      this.log.error('Error finding session information.', this.cameraName)
      callback(new Error('Error finding session information'))
    }
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback)
        break
      case StreamRequestTypes.RECONFIGURE:
        this.log.debug(`Received request to reconfigure: ${request.video.width} x ${request.video.height}, ${request.video.fps} fps, ${request.video.max_bit_rate} kbps (Ignored)`, this.cameraName, this.videoConfig.debug)
        callback()
        break
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID)
        callback()
        break
    }
  }

  public stopStream(sessionId: string): void {
    const session = this.ongoingSessions.get(sessionId)
    if (session) {
      if (session.timeout) {
        clearTimeout(session.timeout)
      }
      try {
        session.socket?.close()
      } catch (err) {
        this.log.error(`Error occurred closing socket: ${err}`, this.cameraName)
      }
      try {
        session.mainProcess?.stop()
      } catch (err) {
        this.log.error(`Error occurred terminating main FFmpeg process: ${err}`, this.cameraName)
      }
      try {
        session.returnProcess?.stop()
      } catch (err) {
        this.log.error(`Error occurred terminating two-way FFmpeg process: ${err}`, this.cameraName)
      }
    }
    this.ongoingSessions.delete(sessionId)
    this.log.info('Stopped video stream.', this.cameraName)
  }
}
