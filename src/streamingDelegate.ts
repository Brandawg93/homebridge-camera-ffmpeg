import {
  API,
  APIEvent,
  CameraController,
  CameraStreamingDelegate,
  HAP,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes,
  StreamSessionIdentifier,
  VideoInfo,
  AudioInfo
} from 'homebridge';
import ip from 'ip';
import { FfmpegProcess } from './ffmpeg';
import { spawn } from 'child_process';
import getPort from 'get-port';
const pathToFfmpeg = require('ffmpeg-for-homebridge'); // eslint-disable-line @typescript-eslint/no-var-requires

type SessionInfo = {
  address: string; // address of the HAP controller

  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites; // should be saved if multiple suites are supported
  videoSRTP: Buffer; // key and salt concatenated
  videoSSRC: number; // rtp synchronisation source

  audioPort: number;
  audioReturnPort: number;
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;
};

export class StreamingDelegate implements CameraStreamingDelegate {
  private readonly hap: HAP;
  private readonly log: Logging;
  private readonly debug = false;
  private readonly ffmpegOpt: any;
  private readonly videoProcessor: string;
  private readonly audio = false;
  private readonly vcodec: string;
  private readonly packetSize: number;
  private readonly fps: number;
  private readonly maxBitrate: number;
  private readonly minBitrate: number;
  private readonly vflip = false;
  private readonly hflip = false;
  private readonly mapvideo: string;
  private readonly mapaudio: string;
  private readonly videoFilter: string;
  private readonly additionalCommandline: string;
  private readonly interfaceName: string;
  private readonly name = '';
  controller?: CameraController;

  // keep track of sessions
  pendingSessions: Record<string, SessionInfo> = {};
  ongoingSessions: Record<string, FfmpegProcess> = {};

  constructor(hap: HAP, cameraConfig: any, log: Logging, videoProcessor: string, interfaceName: string, api: API) { // eslint-disable-line @typescript-eslint/explicit-module-boundary-types
    this.hap = hap;
    this.log = log;
    this.ffmpegOpt = cameraConfig.videoConfig;
    this.name = cameraConfig.name;
    this.videoProcessor = videoProcessor || pathToFfmpeg || 'ffmpeg';
    this.audio = this.ffmpegOpt.audio;
    this.vcodec = this.ffmpegOpt.vcodec || 'libx264';
    this.packetSize = this.ffmpegOpt.packetSize || 1316;
    this.fps = this.ffmpegOpt.maxFPS;
    this.maxBitrate = this.ffmpegOpt.maxBitrate;
    this.minBitrate = this.ffmpegOpt.minBitrate;
    if (this.maxBitrate && this.minBitrate > this.maxBitrate) {
      this.minBitrate = this.maxBitrate;
    }
    this.additionalCommandline = this.ffmpegOpt.additionalCommandline || '-preset ultrafast -tune zerolatency';
    this.vflip = this.ffmpegOpt.vflip;
    this.hflip = this.ffmpegOpt.hflip;
    this.mapvideo = this.ffmpegOpt.mapvideo || '0:0';
    this.mapaudio = this.ffmpegOpt.mapaudio || '0:1';
    this.videoFilter = this.ffmpegOpt.videoFilter || null; // null is a valid discrete value
    this.debug = this.ffmpegOpt.debug;
    this.interfaceName = interfaceName || 'public';

    if (!this.ffmpegOpt.source) {
      throw new Error('Missing source for camera.');
    }

    api.on(APIEvent.SHUTDOWN, () => {
      for (const session in this.ongoingSessions) {
        this.stopStream(session);
      }
    });
  }

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const width = request.width > this.ffmpegOpt.maxWidth ? this.ffmpegOpt.maxWidth : request.width;
    const height = request.height > this.ffmpegOpt.maxHeight ? this.ffmpegOpt.maxHeight : request.height;
    const filter = this.videoFilter;
    const vflip = this.vflip;
    const hflip = this.hflip;

    let resolution: string;
    switch (this.ffmpegOpt.preserveRatio) {
      case 'W': {
        resolution = width + ':-1';
        break;
      }
      case 'H': {
        resolution = '-1:' + height;
        break;
      }
      default: {
        resolution = width + ':' + height;
        break;
      }
    }

    const vf = [];
    const videoFilter = filter === '' || filter === null ? 'scale=' + resolution : filter; // empty string or null indicates default
    // In the case of null, skip entirely
    if (videoFilter !== null && videoFilter !== 'none') {
      if (hflip) {
        vf.push('hflip');
      }

      if (vflip) {
        vf.push('vflip');
      }

      vf.push(videoFilter); // vflip and hflip filters must precede the scale filter to work
    }
    const imageSource = this.ffmpegOpt.stillImageSource || this.ffmpegOpt.source;

    try {
      const ffmpeg = spawn(
        this.videoProcessor,
        (imageSource + ' -frames:v 1' + (vf.length > 0 ? ' -vf ' + vf.join(',') : '') + ' -f image2 -').split(/\s+/),
        { env: process.env }
      );
      let imageBuffer = Buffer.alloc(0);
      this.log(`Snapshot from ${this.name} at ${resolution}`);
      if (this.debug) {
        this.log(`${this.name} snapshot command: ffmpeg ${imageSource} -frames:v 1${vf.length > 0 ? ' -vf ' + vf.join(',') : ''} -f image2 -`);
      }
      ffmpeg.stdout.on('data', function(data: any) {
        imageBuffer = Buffer.concat([imageBuffer, data]);
      });
      const log = this.log;
      const debug = this.debug;
      ffmpeg.on('error', function(error: any) {
        log('An error occurred while making snapshot request');
        debug ? log(error) : null;
      });
      ffmpeg.on(
        'close',
        function(): void {
          callback(undefined, imageBuffer);
        }.bind(this)
      );
    } catch (err) {
      this.log.error(err);
      callback(err);
    }
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    const sessionId: StreamSessionIdentifier = request.sessionID;
    const targetAddress = request.targetAddress;

    //video stuff
    const video = request.video;
    const videoPort = video.port;
    const videoReturnPort = await getPort();

    const videoCryptoSuite = video.srtpCryptoSuite; // could be used to support multiple crypto suite (or support no suite for debugging)
    const videoSrtpKey = video.srtp_key;
    const videoSrtpSalt = video.srtp_salt;

    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();

    //audio stuff
    const audio = request.audio;
    const audioPort = audio.port;
    const audioReturnPort = await getPort();

    const audioCryptoSuite = audio.srtpCryptoSuite; // could be used to support multiple crypto suite (or support no suite for debugging)
    const audioSrtpKey = audio.srtp_key;
    const audioSrtpSalt = audio.srtp_salt;

    const audioSSRC = this.hap.CameraController.generateSynchronisationSource();

    const sessionInfo: SessionInfo = {
      address: targetAddress,

      videoPort: videoPort,
      videoReturnPort: videoReturnPort,
      videoCryptoSuite: videoCryptoSuite,
      videoSRTP: Buffer.concat([videoSrtpKey, videoSrtpSalt]),
      videoSSRC: videoSSRC,

      audioPort: audioPort,
      audioReturnPort: audioReturnPort,
      audioCryptoSuite: audioCryptoSuite,
      audioSRTP: Buffer.concat([audioSrtpKey, audioSrtpSalt]),
      audioSSRC: audioSSRC
    };

    let currentAddress: string;
    try {
      currentAddress = ip.address(this.interfaceName, request.addressVersion); // ipAddress version must match
    } catch {
      this.log.error(`Unable to get ${request.addressVersion} address for ${this.interfaceName}! Falling back to public.`);
      currentAddress = ip.address('public', request.addressVersion); // ipAddress version must match
    }

    const response: PrepareStreamResponse = {
      address: currentAddress,
      video: {
        port: videoReturnPort,
        ssrc: videoSSRC,

        srtp_key: videoSrtpKey,
        srtp_salt: videoSrtpSalt
      },
      audio: {
        port: audioReturnPort,
        ssrc: audioSSRC,

        srtp_key: audioSrtpKey,
        srtp_salt: audioSrtpSalt
      }
    };

    this.pendingSessions[sessionId] = sessionInfo;
    callback(void 0, response);
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    const sessionId = request.sessionID;

    switch (request.type) {
      case StreamRequestTypes.START: {
        const vcodec = this.vcodec;
        const additionalCommandline = this.additionalCommandline;
        const mapvideo = this.mapvideo;
        const mapaudio = this.mapaudio;

        const sessionInfo = this.pendingSessions[sessionId];
        const video: VideoInfo = request.video;
        const audio: AudioInfo = request.audio;

        const width = video.width > this.ffmpegOpt.maxWidth ? this.ffmpegOpt.maxWidth : video.width;
        const height = video.height > this.ffmpegOpt.maxHeight ? this.ffmpegOpt.maxHeight : video.height;
        const fps = video.fps > this.fps ? this.fps : video.fps;
        const vflip = this.vflip;
        const hflip = this.hflip;

        let resolution: string;
        switch (this.ffmpegOpt.preserveRatio) {
          case 'W': {
            resolution = width + ':-1';
            break;
          }
          case 'H': {
            resolution = '-1:' + height;
            break;
          }
          default: {
            resolution = width + ':' + height;
            break;
          }
        }

        const videoPayloadType = video.pt;
        const audioPayloadType = audio.pt;
        let videoBitrate = video.max_bit_rate;
        if (this.maxBitrate && videoBitrate > this.maxBitrate) {
          videoBitrate = this.maxBitrate;
        } else if (this.minBitrate && videoBitrate < this.minBitrate) {
          videoBitrate = this.minBitrate;
        }
        let audioBitrate = audio.max_bit_rate;
        if (this.maxBitrate && audioBitrate > this.maxBitrate) {
          audioBitrate = this.maxBitrate;
        }
        const sampleRate = audio.sample_rate;
        const mtu = this.packetSize || video.mtu; // maximum transmission unit

        const address = sessionInfo.address;
        const videoPort = sessionInfo.videoPort;
        const audioPort = sessionInfo.audioPort;
        const returnPort = sessionInfo.videoReturnPort;
        const videoSsrc = sessionInfo.videoSSRC;
        const audioSsrc = sessionInfo.audioSSRC;
        const videoSRTP = sessionInfo.videoSRTP.toString('base64');
        const audioSRTP = sessionInfo.audioSRTP.toString('base64');
        const filter = this.videoFilter;
        const vf = [];

        const videoFilter = filter === '' || filter === null ? 'scale=' + resolution : filter; // empty string or null indicates default
        // In the case of null, skip entirely
        if (videoFilter !== null && videoFilter !== 'none' && vcodec !== 'copy') {
          // Filters cannot be set if the copy vcodec is used.
          vf.push(videoFilter);

          if (hflip) vf.push('hflip');

          if (vflip) vf.push('vflip');
        }

        let fcmd = this.ffmpegOpt.source;

        this.log(`Starting ${this.name} video stream (${width}x${height}, ${fps} fps, ${videoBitrate} kbps, ${mtu} mtu)...`, this.debug ? 'debug enabled' : '');

        const ffmpegVideoArgs =
          ' -map ' + mapvideo +
          ' -vcodec ' + vcodec +
          ' -pix_fmt yuv420p' +
          ' -r ' + fps +
          ' -f rawvideo' +
          ' ' + additionalCommandline +
          (vf.length > 0 ? ' -vf ' + vf.join(',') : '') +
          ' -b:v ' + videoBitrate + 'k' +
          ' -bufsize ' + 2 * videoBitrate + 'k' +
          ' -maxrate ' + videoBitrate + 'k' +
          ' -payload_type ' + videoPayloadType;

        const ffmpegVideoStream =
          ' -ssrc ' + videoSsrc +
          ' -f rtp' +
          ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
          ' -srtp_out_params ' + videoSRTP +
          ' srtp://' + address + ':' + videoPort +
          '?rtcpport=' + videoPort +'&localrtcpport=' + videoPort + '&pkt_size=' + mtu;

        // build required video arguments
        fcmd += ffmpegVideoArgs;
        fcmd += ffmpegVideoStream;

        // build optional audio arguments
        if (this.audio) {
          const ffmpegAudioArgs =
            ' -map ' + mapaudio +
            ' -acodec libfdk_aac' +
            ' -profile:a aac_eld' +
            ' -flags +global_header' +
            ' -f null' +
            ' -ar ' + sampleRate + 'k' +
            ' -b:a ' + audioBitrate + 'k' +
            ' -bufsize ' + audioBitrate + 'k' +
            ' -ac 1' +
            ' -payload_type ' + audioPayloadType;

          const ffmpegAudioStream =
            ' -ssrc ' + audioSsrc +
            ' -f rtp' +
            ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
            ' -srtp_out_params ' + audioSRTP +
            ' srtp://' + address + ':' + audioPort +
            '?rtcpport=' + audioPort + '&localrtcpport=' + audioPort + '&pkt_size=188';

          fcmd += ffmpegAudioArgs;
          fcmd += ffmpegAudioStream;
        }

        if (this.debug) {
          fcmd += ' -loglevel level+verbose';
        }

        const ffmpeg = new FfmpegProcess(
          this.name,
          fcmd,
          this.log,
          callback,
          this,
          sessionId,
          returnPort,
          this.debug,
          this.videoProcessor
        );

        this.ongoingSessions[sessionId] = ffmpeg;
        delete this.pendingSessions[sessionId];
        break;
      }
      case StreamRequestTypes.RECONFIGURE: {
        // not implemented
        this.log.debug('Received (unsupported) request to reconfigure to: ' + JSON.stringify(request.video));
        callback();
        break;
      }
      case StreamRequestTypes.STOP: {
        this.stopStream(sessionId);
        callback();
        break;
      }
    }
  }

  public stopStream(sessionId: string): void {
    try {
      if (this.ongoingSessions[sessionId]) {
        const ffmpegProcess = this.ongoingSessions[sessionId];
        if (ffmpegProcess) {
          ffmpegProcess.stop();
        }
      }
      delete this.ongoingSessions[sessionId];
      this.log(`Stopped ${this.name} video stream!`);
    } catch (e) {
      this.log.error('Error occurred terminating the video process!');
      this.log.error(e);
    }
  }
}
