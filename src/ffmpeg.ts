import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Writable } from 'node:stream'

import type { StreamRequestCallback } from 'homebridge'

import type { Logger } from './logger'
import type { StreamingDelegate } from './streamingDelegate'

import { spawn } from 'node:child_process'
import os from 'node:os'
import { env } from 'node:process'
import readline from 'node:readline'

interface FfmpegProgress {
  frame: number
  fps: number
  stream_q: number
  bitrate: number
  total_size: number
  out_time_us: number
  out_time: string
  dup_frames: number
  drop_frames: number
  speed: number
  progress: string
}

export class FfmpegProcess {
  private readonly process: ChildProcessWithoutNullStreams
  private killTimeout?: NodeJS.Timeout
  readonly stdin: Writable

  constructor(cameraName: string, sessionId: string, videoProcessor: string, ffmpegArgs: string, log: Logger, debug = false, delegate: StreamingDelegate, callback?: StreamRequestCallback) {
    log.debug(`Stream command: ${videoProcessor} ${ffmpegArgs}`, cameraName, debug)

    let started = false
    const startTime = Date.now()
    this.process = spawn(videoProcessor, ffmpegArgs.split(/\s+/), { env })
    this.stdin = this.process.stdin

    this.process.stdout.on('data', (data) => {
      const progress = this.parseProgress(data)
      if (progress) {
        if (!started && progress.frame > 0) {
          started = true
          const runtime = (Date.now() - startTime) / 1000
          const message = `Getting the first frames took ${runtime} seconds.`
          if (runtime < 5) {
            log.debug(message, cameraName, debug)
          } else if (runtime < 22) {
            log.warn(message, cameraName)
          } else {
            log.error(message, cameraName)
          }
        }
      }
    })
    const stderr = readline.createInterface({
      input: this.process.stderr,
      terminal: false,
    })
    stderr.on('line', (line: string) => {
      if (callback) {
        callback()
        callback = undefined
      }
      if (debug && line.match(/\[(panic|fatal|error)\]/)) { // For now only write anything out when debug is set
        log.error(line, cameraName)
      } else if (debug) {
        log.debug(line, cameraName, true)
      }
    })
    this.process.on('error', (error: Error) => {
      log.error(`FFmpeg process creation failed: ${error.message}`, cameraName)
      if (callback) {
        callback(new Error('FFmpeg process creation failed'))
      }
      delegate.stopStream(sessionId)
    })
    this.process.on('exit', (code: number, signal: NodeJS.Signals) => {
      if (this.killTimeout) {
        clearTimeout(this.killTimeout)
      }

      const message = `FFmpeg exited with code: ${code} and signal: ${signal}`

      if (this.killTimeout && code === 0) {
        log.debug(`${message} (Expected)`, cameraName, debug)
      } else if (code == null || code === 255) {
        if (this.process.killed) {
          log.debug(`${message} (Forced)`, cameraName, debug)
        } else {
          log.error(`${message} (Unexpected)`, cameraName)
        }
      } else {
        log.error(`${message} (Error)`, cameraName)
        delegate.stopStream(sessionId)
        if (!started && callback) {
          callback(new Error(message))
        } else {
          delegate.controller.forceStopStreamingSession(sessionId)
        }
      }
    })
  }

  parseProgress(data: Uint8Array): FfmpegProgress | undefined {
    const input = data.toString()

    if (input.indexOf('frame=') === 0) {
      try {
        const progress = new Map<string, string>()
        input.split(/\r?\n/).forEach((line) => {
          const split = line.split('=', 2)
          progress.set(split[0], split[1])
        })

        return {
          frame: Number.parseInt(progress.get('frame')!),
          fps: Number.parseFloat(progress.get('fps')!),
          stream_q: Number.parseFloat(progress.get('stream_0_0_q')!),
          bitrate: Number.parseFloat(progress.get('bitrate')!),
          total_size: Number.parseInt(progress.get('total_size')!),
          out_time_us: Number.parseInt(progress.get('out_time_us')!),
          out_time: progress.get('out_time')!.trim(),
          dup_frames: Number.parseInt(progress.get('dup_frames')!),
          drop_frames: Number.parseInt(progress.get('drop_frames')!),
          speed: Number.parseFloat(progress.get('speed')!),
          progress: progress.get('progress')!.trim(),
        }
      } catch {
        return undefined
      }
    } else {
      return undefined
    }
  }

  public stop(): void {
    this.process.stdin.write(`q${os.EOL}`)
    this.killTimeout = setTimeout(() => {
      this.process.kill('SIGKILL')
    }, 2 * 1000)
  }
}
