import type { Frame, StreamName } from './index'
import type { MappedStream } from './mapping'
import type { ImageOptions } from './images'
import { readCatalog } from './catalog'
import { encodeNativeControls, type NativeControl } from './control-values'
import { native as n, ptr, check, CameraError, type Pointer } from './ffi'
export type RequestPhase = 'pre' | 'post'
export interface RequestFrame extends Pick<
  Frame,
  | 'sequence'
  | 'timestampNs'
  | 'width'
  | 'height'
  | 'referenceCount'
  | 'metadata'
  | 'metadataCatalog'
  | 'synchronization'
  | 'copyRGB'
  | 'copyRGB16'
  | 'copyRaw16'
  | 'copyStream'
  | 'copyStreams'
  | 'retain'
  | 'mapStream'
  | 'withMappedStream'
  | 'saveJPEG'
  | 'saveDNG'
  | 'saveFile'
  | 'encodeImage'
  | 'makeImage'
  | 'colorSpace'
> {
  controls(): ReturnType<typeof readCatalog>
  setNativeControls(controls: readonly NativeControl[]): bigint
}
export type RequestCallback = (request: RequestFrame) => void
export interface RequestCallbacks {
  pre?: RequestCallback
  post?: RequestCallback
}
export class RequestCallbackError extends Error {
  readonly code = -6
  constructor(
    readonly phase: RequestPhase,
    readonly sequence: bigint,
    cause: unknown,
    readonly unclosedMappings: readonly MappedStream[] = [],
  ) {
    super(`${phase} request callback failed at frame ${sequence}`, { cause })
    this.name = 'RequestCallbackError'
  }
}
let active = 0
export function guardRequestCallback() {
  if (active)
    throw new CameraError(
      -4,
      'camera ownership operation inside request callback; retain the request for deferred work',
    )
}
class ScopedRequest implements RequestFrame {
  private frame?: Frame
  private maps = new Set<MappedStream>()
  constructor(
    frame: Frame,
    private owner: Pointer,
    private reserve: bigint,
  ) {
    this.frame = frame
  }
  private current() {
    if (!this.frame) throw new CameraError(-5, 'expired request callback view')
    return this.frame
  }
  get sequence() {
    return this.current().sequence
  }
  get timestampNs() {
    return this.current().timestampNs
  }
  get width() {
    return this.current().width
  }
  get height() {
    return this.current().height
  }
  get referenceCount() {
    return this.current().referenceCount
  }
  metadata() {
    return this.current().metadata()
  }
  metadataCatalog() {
    return this.current().metadataCatalog()
  }
  synchronization() {
    return this.current().synchronization()
  }
  copyRGB(stream: 'main' | 'lores' = 'main') {
    return this.current().copyRGB(stream)
  }
  copyRGB16(stream: 'main' | 'lores' = 'main') {
    return this.current().copyRGB16(stream)
  }
  copyRaw16() {
    return this.current().copyRaw16()
  }
  colorSpace(stream: StreamName = 'main') {
    return this.current().colorSpace(stream)
  }
  copyStream(stream: StreamName = 'main') {
    return this.current().copyStream(stream)
  }
  copyStreams(streams: readonly StreamName[] = ['main']) {
    return this.current().copyStreams(streams)
  }
  retain() {
    return this.current().retain()
  }
  saveJPEG(path: string, quality = 98) {
    this.current().saveJPEG(path, quality)
  }
  saveDNG(path: string) {
    this.current().saveDNG(path)
  }
  saveFile(path: string, options: ImageOptions = {}) {
    this.current().saveFile(path, options)
  }
  encodeImage(options: ImageOptions = {}) {
    return this.current().encodeImage(options)
  }
  makeImage(options: Parameters<Frame['makeImage']>[0] = {}) {
    return this.current().makeImage(options)
  }
  controls() {
    this.current()
    return readCatalog((out) => n.zc_camera_controls(this.owner, out))
  }
  setNativeControls(controls: readonly NativeControl[]) {
    this.current()
    const bytes = encodeNativeControls(controls),
      revision = new BigUint64Array(1)
    this.current()
    if (this.reserve) {
      const count = new Uint32Array(1)
      check(n.zc_get_controls(this.owner, null, 0, ptr(count), ptr(revision)))
      if (revision[0] >= 0xffffffffffffffffn - this.reserve)
        throw new CameraError(
          -2,
          'callback restoration revision budget exhausted',
        )
    }
    check(
      n.zc_set_native_controls(
        this.owner,
        ptr(bytes),
        BigInt(bytes.length),
        ptr(revision),
      ),
    )
    return revision[0]
  }
  mapStream(stream: StreamName = 'main') {
    for (const map of this.maps) if (map.closed) this.maps.delete(map)
    const mapped = this.current().mapStream(stream)
    this.maps.add(mapped)
    return mapped
  }
  withMappedStream<T>(
    operation: (stream: MappedStream) => T,
    stream: StreamName = 'main',
  ): T {
    using mapped = this.mapStream(stream)
    const result = operation(mapped)
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => {})
      throw new TypeError('mapped callback must be synchronous')
    }
    return result
  }
  retire() {
    this.frame = undefined
    const errors: unknown[] = []
    for (const map of this.maps)
      try {
        map.close()
      } catch (error) {
        errors.push(error)
      }
    for (const map of this.maps) if (map.closed) this.maps.delete(map)
    if (errors.length)
      throw new AggregateError(errors, 'request mapping cleanup failed')
  }
  unclosed() {
    return Object.freeze([...this.maps])
  }
}
/** Consumer-thread scope. Successful scopes retire maps before worker/encoder
 * progress; failures preserve unclosed owners for explicit cleanup retry. */
export function invokeRequestCallback(
  callback: RequestCallback,
  phase: RequestPhase,
  frame: Frame,
  owner: Pointer,
  reserve = 0n,
) {
  const scope = new ScopedRequest(frame, owner, reserve)
  active++
  let failed = false,
    failure: unknown
  try {
    const result: unknown = callback(scope)
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => {})
      throw new TypeError(
        'request callback must be synchronous; retain the request for asynchronous work',
      )
    }
  } catch (error) {
    failed = true
    failure = error
  } finally {
    try {
      scope.retire()
    } catch (error) {
      failure = failed
        ? new AggregateError(
            [failure, error],
            'request callback and cleanup failed',
          )
        : error
      failed = true
    }
    active--
  }
  if (failed)
    throw new RequestCallbackError(
      phase,
      frame.sequence,
      failure,
      scope.unclosed(),
    )
}
