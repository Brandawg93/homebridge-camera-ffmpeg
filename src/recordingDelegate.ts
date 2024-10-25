import type { ChildProcess } from 'node:child_process'
import type { Server, Socket } from 'node:net'
import type { Readable } from 'node:stream'

import type { API, CameraController, CameraRecordingConfiguration, CameraRecordingDelegate, HAP, HDSProtocolSpecificErrorReason, RecordingPacket } from 'homebridge'

import type { VideoConfig } from './configTypes.js'
import type { Logger } from './logger.js'
import type { Mp4Session } from './prebuffer.js'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { env } from 'node:process'

import ffmpegPath from 'ffmpeg-for-homebridge'
import { APIEvent, AudioRecordingCodecType, H264Level, H264Profile } from 'homebridge'

import { PreBuffer } from './prebuffer.js'

const ffmpegPathString = ffmpegPath as unknown as string

export interface MP4Atom {
  header: Buffer
  length: number
  type: string
  data: Buffer
}

export interface FFMpegFragmentedMP4Session {
  socket: Socket
  cp: ChildProcess
  generator: AsyncGenerator<MP4Atom>
}

export const PREBUFFER_LENGTH = 4000
export const FRAGMENTS_LENGTH = 4000

export async function listenServer(server: Server, log: Logger): Promise<number> {
  let isListening = false
  while (!isListening) {
    const port = 10000 + Math.round(Math.random() * 30000)
    server.listen(port)
    try {
      await once(server, 'listening')
      isListening = true
      const address = server.address()
      if (address && typeof address === 'object' && 'port' in address) {
        return address.port
      }
      throw new Error('Failed to get server address')
    } catch (e: any) {
      log.error('Error while listening to the server:', e)
    }
  }
  // Add a return statement to ensure the function always returns a number
  return 0
}

export async function readLength(readable: Readable, length: number): Promise<Buffer> {
  if (!length) {
    return Buffer.alloc(0)
  }

  {
    const ret = readable.read(length)
    if (ret) {
      return ret
    }
  }

  return new Promise((resolve, reject) => {
    const r = (): void => {
      const ret = readable.read(length)
      if (ret) {
        // eslint-disable-next-line ts/no-use-before-define
        cleanup()
        resolve(ret)
      }
    }

    const e = (): void => {
      // eslint-disable-next-line ts/no-use-before-define
      cleanup()
      reject(new Error(`stream ended during read for minimum ${length} bytes`))
    }

    const cleanup = (): void => {
      readable.removeListener('readable', r)
      readable.removeListener('end', e)
    }

    readable.on('readable', r)
    readable.on('end', e)
  })
}

export async function* parseFragmentedMP4(readable: Readable): AsyncGenerator<MP4Atom> {
  while (true) {
    const header = await readLength(readable, 8)
    const length = header.readInt32BE(0) - 8
    const type = header.slice(4).toString()
    const data = await readLength(readable, length)

    yield {
      header,
      length,
      type,
      data,
    }
  }
}

export class RecordingDelegate implements CameraRecordingDelegate {
  updateRecordingActive(active: boolean): Promise<void> {
    this.log.info(`Recording active status changed to: ${active}`, this.cameraName)
    return Promise.resolve()
  }

  updateRecordingConfiguration(): Promise<void> {
    this.log.info('Recording configuration updated', this.cameraName)
    return Promise.resolve()
  }

  async *handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket, any, any> {
    this.log.info(`Recording stream request received for stream ID: ${streamId}`, this.cameraName)
    // Implement the logic to handle the recording stream request here
    // For now, just yield an empty RecordingPacket
    yield {} as RecordingPacket
  }

  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    this.log.info(`Recording stream closed for stream ID: ${streamId}, reason: ${reason}`, this.cameraName)
  }

  private readonly hap: HAP
  private readonly log: Logger
  private readonly cameraName: string
  private readonly videoConfig!: VideoConfig
  private process!: ChildProcess

  private readonly videoProcessor: string
  readonly controller!: CameraController
  private preBufferSession!: Mp4Session
  private preBuffer!: PreBuffer

  constructor(log: Logger, cameraName: string, videoConfig: VideoConfig, api: API, hap: HAP, videoProcessor?: string) {
    this.log = log
    this.hap = hap
    this.cameraName = cameraName
    this.videoProcessor = videoProcessor || ffmpegPathString || 'ffmpeg'

    api.on(APIEvent.SHUTDOWN, () => {
      if (this.preBufferSession) {
        this.preBufferSession.process?.kill()
        this.preBufferSession.server?.close()
      }
    })
  }

  async startPreBuffer(): Promise<void> {
    if (this.videoConfig.prebuffer) {
      // looks like the setupAcessory() is called multiple times during startup. Ensure that Prebuffer runs only once
      if (!this.preBuffer) {
        this.preBuffer = new PreBuffer(this.log, this.videoConfig.source ?? '', this.cameraName, this.videoProcessor)
        if (!this.preBufferSession) {
          this.preBufferSession = await this.preBuffer.startPreBuffer()
        }
      }
    }
  }

  async * handleFragmentsRequests(configuration: CameraRecordingConfiguration): AsyncGenerator<Buffer, void, unknown> {
    this.log.debug('video fragments requested', this.cameraName)

    const iframeIntervalSeconds = 4

    const audioArgs: Array<string> = [
      '-acodec',
      'libfdk_aac',
      ...(configuration.audioCodec.type === AudioRecordingCodecType.AAC_LC
        ? ['-profile:a', 'aac_low']
        : ['-profile:a', 'aac_eld']),
      '-ar',
      `${configuration.audioCodec.samplerate}k`,
      '-b:a',
      `${configuration.audioCodec.bitrate}k`,
      '-ac',
      `${configuration.audioCodec.audioChannels}`,
    ]

    const profile = configuration.videoCodec.parameters.profile === H264Profile.HIGH
      ? 'high'
      : configuration.videoCodec.parameters.profile === H264Profile.MAIN ? 'main' : 'baseline'

    const level = configuration.videoCodec.parameters.level === H264Level.LEVEL4_0
      ? '4.0'
      : configuration.videoCodec.parameters.level === H264Level.LEVEL3_2 ? '3.2' : '3.1'

    const videoArgs: Array<string> = [
      '-an',
      '-sn',
      '-dn',
      '-codec:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',

      '-profile:v',
      profile,
      '-level:v',
      level,
      '-b:v',
      `${configuration.videoCodec.parameters.bitRate}k`,
      '-force_key_frames',
      `expr:eq(t,n_forced*${iframeIntervalSeconds})`,
      '-r',
      configuration.videoCodec.resolution[2].toString(),
    ]

    const ffmpegInput: Array<string> = []

    if (this.videoConfig.prebuffer) {
      const input: Array<string> = await this.preBuffer.getVideo(configuration.mediaContainerConfiguration.fragmentLength ?? PREBUFFER_LENGTH)
      ffmpegInput.push(...input)
    } else {
      ffmpegInput.push(...(this.videoConfig.source ?? '').split(' '))
    }

    this.log.debug('Start recording...', this.cameraName)

    const session = await this.startFFMPegFragmetedMP4Session(this.videoProcessor, ffmpegInput, audioArgs, videoArgs)
    this.log.info('Recording started', this.cameraName)

    const { socket, cp, generator } = session
    let pending: Array<Buffer> = []
    let filebuffer: Buffer = Buffer.alloc(0)
    try {
      for await (const box of generator) {
        const { header, type, length, data } = box

        pending.push(header, data)

        if (type === 'moov' || type === 'mdat') {
          const fragment = Buffer.concat(pending)
          filebuffer = Buffer.concat([filebuffer, Buffer.concat(pending)])
          pending = []
          yield fragment
        }
        this.log.debug(`mp4 box type ${type} and lenght: ${length}`, this.cameraName)
      }
    } catch (e) {
      this.log.info(`Recoding completed. ${e}`, this.cameraName)
      /*
            const homedir = require('os').homedir();
            const path = require('path');
            const writeStream = fs.createWriteStream(homedir+path.sep+Date.now()+'_video.mp4');
            writeStream.write(filebuffer);
            writeStream.end();
            */
    } finally {
      socket.destroy()
      cp.kill()
      // this.server.close;
    }
  }

  async startFFMPegFragmetedMP4Session(ffmpegPath: string, ffmpegInput: Array<string>, audioOutputArgs: Array<string>, videoOutputArgs: Array<string>): Promise<FFMpegFragmentedMP4Session> {
    return new Promise((resolve) => {
      const server = createServer((socket) => {
        server.close()
        async function* generator(): AsyncGenerator<MP4Atom> {
          while (true) {
            const header = await readLength(socket, 8)
            const length = header.readInt32BE(0) - 8
            const type = header.slice(4).toString()
            const data = await readLength(socket, length)

            yield {
              header,
              length,
              type,
              data,
            }
          }
        }
        const cp = this.process
        resolve({
          socket,
          cp,
          generator: generator(),
        })
      })

      listenServer(server, this.log).then((serverPort) => {
        const args: Array<string> = []

        args.push(...ffmpegInput)

        // args.push(...audioOutputArgs);

        args.push('-f', 'mp4')
        args.push(...videoOutputArgs)
        args.push('-fflags', '+genpts', '-reset_timestamps', '1')
        args.push(
          '-movflags',
          'frag_keyframe+empty_moov+default_base_moof',
          `tcp://127.0.0.1:${serverPort}`,
        )

        this.log.debug(`${ffmpegPath} ${args.join(' ')}`, this.cameraName)

        const debug = false

        const stdioValue = debug ? 'pipe' : 'ignore'
        this.process = spawn(ffmpegPath, args, { env, stdio: stdioValue })
        const cp = this.process

        if (debug) {
          if (cp.stdout) {
            cp.stdout.on('data', (data: Buffer) => this.log.debug(data.toString(), this.cameraName))
          }
          if (cp.stderr) {
            cp.stderr.on('data', (data: Buffer) => this.log.debug(data.toString(), this.cameraName))
          }
        }
      })
    })
  }
}
