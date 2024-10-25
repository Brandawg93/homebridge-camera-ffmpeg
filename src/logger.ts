import type { Logging } from 'homebridge'

import { argv } from 'node:process'

export class Logger {
  private readonly log: Logging
  private readonly debugMode: boolean

  constructor(log: Logging) {
    this.log = log
    this.debugMode = argv.includes('-D') || argv.includes('--debug')
  }

  private formatMessage(message: string, device?: string): string {
    let formatted = ''
    if (device) {
      formatted += `[${device}] `
    }
    formatted += message
    return formatted
  }

  public info(message: string, device?: string): void {
    this.log.info(this.formatMessage(message, device))
  }

  public warn(message: string, device?: string): void {
    this.log.warn(this.formatMessage(message, device))
  }

  public error(message: string, device?: string): void {
    this.log.error(this.formatMessage(message, device))
  }

  public debug(message: string, device?: string, alwaysLog = false): void {
    if (this.debugMode) {
      this.log.debug(this.formatMessage(message, device))
    } else if (alwaysLog) {
      this.info(message, device)
    }
  }
}
