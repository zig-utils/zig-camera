import type { CustomOutput, OutputPacket, OutputStreams } from './outputs'
import type { TransportSink } from './transport-sink'
import { CameraError } from './ffi'

/** Shared raw video contract for managed byte sinks. The native recorder
 * supplies JPEG/Annex B and parameter sets; this wrapper owns session gating. */
export class ElementaryOutput<Sink extends TransportSink> implements CustomOutput, AsyncDisposable {
  readonly format = 'packets' as const
  private first = true
  private codec?:number
  constructor(readonly sink:Sink) {}
  resources() { return [this.sink]}
  async start() {await this.sink.start(); this.first = true; this.codec = undefined}
  streams(info:OutputStreams) {
    if(this.sink.stats().phase!=='prepared'||this.codec!==undefined)throw new CameraError(-2, 'elementary streams unavailable')
    const codec = info.codec, audio = info.audio
    if(audio)throw new RangeError('raw output is video-only')
    if(![3, 1, 2].includes(codec))throw new RangeError('unsupported elementary codec')
    if(this.sink.stats().phase!=='prepared')throw new CameraError(-2, 'elementary stream admission interrupted')
    this.codec = codec
  }
  commit() { if(this.codec===undefined)throw new CameraError(-2, 'elementary streams unavailable'); this.sink.commit()}
  async outputframe(packet:OutputPacket) {
    if(this.sink.stats().phase!=='active')throw new CameraError(-2, 'elementary output inactive')
    const {audio, codec, annexB, keyframe, data} = packet
    if(this.sink.stats().phase!=='active')throw new CameraError(-2, 'elementary packet admission interrupted')
    if(typeof audio!=='boolean'||typeof annexB!=='boolean'||typeof keyframe!=='boolean'||audio||codec!==this.codec||(codec!==3&&!annexB))throw new RangeError('invalid elementary packet')
    if(this.first&&!keyframe)return
    await this.sink.write(data); this.first = false
  }
  stop(reason?:{discard:boolean}) { return this.sink.stop(reason)}
  close() { return this.sink.close()}
  async [Symbol.asyncDispose]() {await this.close()}
}
