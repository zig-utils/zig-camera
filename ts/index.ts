import {
  prepareApng,
  runApng,
  apngSettings,
  apngInteger,
  apngDelay,
  type PngAnimationLimits,
  type PngAnimationFrame,
} from './apng'
export {
  encodePngAnimationAsync,
  savePngAnimationAsync,
  type PngRaster,
  type PngAnimationFrame,
  type PngAnimation,
  type PngAnimationLimits,
} from './apng'
import {
  processedFormatCode,
  isYuv,
  type ProcessedFormat,
} from './processed-format'
export type { ProcessedFormat } from './processed-format'
import { qualityTierCode, type RecordingQuality } from './quality'
export {
  QualityTier,
  planRecordingQuality,
  type RecordingQuality,
  type QualityTierName,
} from './quality'
import {
  CaptureFilesJob,
  CaptureFilesState,
  prepareCaptureFiles,
  waitCaptureInterval,
  type CaptureFileTargets,
  type CaptureFilesOptions,
} from './capture-series'
import { preparePreviewConfiguration } from './preview-options'
import {
  encodeEncoderLimits,
  snapshotEncoderLimits,
  readEncoderLimits,
  type EncoderLimits,
} from './encoder-limits'
export type { EncoderLimits } from './encoder-limits'
import {
  encodeEncoderOptions,
  snapshotEncoderOptions,
  readEncoderOptions,
  type EncoderOptions,
} from './encoder-options'
export {
  EncoderProfile,
  EncoderPreset,
  type EncoderOptions,
} from './encoder-options'
import {
  readDeviceState,
  pollDisconnected,
  DisconnectObserver,
  type DeviceState,
} from './device-state'
export type { DeviceState } from './device-state'
import {
  loadTuningFile,
  findTuningAlgorithm,
  TuningSession,
  TuningCleanupError,
  getTuningState,
  type TuningSource,
  type TuningDocument,
  type LoadTuningOptions,
} from './tuning'
export {
  TuningSession,
  TuningCleanupError,
  getTuningState,
  cleanupTuning,
  type TuningSource,
  type TuningState,
  type TuningBackend,
  TuningDocument,
  loadTuningFile,
  findTuningAlgorithm,
  TUNING_MAX_BYTES,
  type TuningValue,
  type LoadTuningOptions,
} from './tuning'
import {
  alignStream,
  alignConfiguration,
  type StreamGeometry,
  type AlignmentOptions,
} from './alignment'
export {
  alignStream,
  alignConfiguration,
  type StreamGeometry,
  type AlignmentOptions,
  type AlignedStream,
} from './alignment'
import {
  readFrameSynchronization,
  synchronizationControls,
  synchronizationOptions,
  type SynchronizationMode,
  type SynchronizationOptions,
} from './synchronization'
export type {
  FrameSynchronization,
  SynchronizationMode,
  SynchronizationOptions,
} from './synchronization'
export {
  CaptureFilesJob,
  type CaptureFilesOptions,
  type CaptureFilePattern,
  type CaptureFileTargets,
  type CaptureFileRecord,
  type CaptureFilesProgress,
} from './capture-series'
import {
  streamNames,
  copyNativeStreams,
  type StreamName,
  type PackedStream,
  type CapturedStreams,
} from './streams'
export type { StreamName, PackedStream, CapturedStreams } from './streams'
import { withStagedImageFile } from './staged-image'
import { copyNativeImage, resizeImageSnapshot } from './image-capture'
import { exportNativeFrame, type FrameExportOptions } from './frame-export'
export { FrameExport, type FrameExportOptions } from './frame-export'
export { FrameChannel, RemoteFrame, type RemoteArray } from './frame-channel'
export { ProcessPool, ProcessRemoteError, ProcessWorkerError, type ProcessPoolOptions, type ProcessSubmitOptions, type ProcessWorkerContext, type ProcessModule, type ProcessCameraSnapshot, type ProcessValue } from './processes'
import { CapturedImage, adoptImageSnapshot, snapshotCaptureImageOptions, type CaptureImageOptions } from './image-object'
export { CapturedImage, type ImageResample, type ImageResizeOptions, type CaptureImageOptions, type ImageRaster, type ImageObjectOptions, type RasterFormat, type RasterEndian, type ImageSourceMetadata } from './image-object'
import {
  readColorNegotiation,
  encodeColorSpace,
  snapshotColorSpace,
  type ColorSpaceRequest,
} from './color-config'
export type {
  ImageExif,
  ExifOptions,
  ExifTag,
  ExifRational,
  ExifGroup,
  ExifType,
} from './exif'
export type {
  ColorSpacePreset,
  ColorSpaceDescription,
  ColorSpaceRequest,
  ColorNegotiation,
} from './color-config'
import {
  snapshotPreviewStream,
  readPreviewInput,
  copyPreviewStreamInfo,
  type PreviewStream,
  type PreviewStreamInfo,
  type PreparedPreviewInput,
} from './preview-stream'
export type { PreviewStream, PreviewStreamInfo } from './preview-stream'
import { text } from './ffi'
import {
  preparePreviewView,
  validatePreviewView,
  copyPreviewViewOptions,
  type PreviewViewOptions,
  type PreviewConfiguration,
} from './preview-view'
export type {
  PreviewViewOptions,
  PreviewTransform,
  PreviewWindow,
  PreviewRectangle,
} from './preview-view'
import { RestartGroup, type GroupRestartMember } from './restart-group'
import {
  SharedAudio,
  type AudioConsumerStats,
  type SharedAudioStats,
  type NativeAudioBatch,
} from './shared-audio'
export type { AudioConsumerStats, SharedAudioStats } from './shared-audio'
import {
  FrameFanout,
  type CaptureConsumerStats,
  type RecordingBackpressure,
} from './fanout'
export type { CaptureConsumerStats, RecordingBackpressure } from './fanout'
import {
  encodeNativeControls,
  encodeNativeSnapshot,
  nativeAppIds,
  type NativeControl,
  type NativeControlSnapshot,
} from './control-values'
export type { NativeControl, NativeControlSnapshot } from './control-values'
import { decodeFrameConfiguration } from './request-configuration'
export type { ImageJobLimits } from './native-image-job'
export type { FrameConfiguration } from './request-configuration'
import { readCatalog, cameraDescriptors } from './catalog'
export type {
  TypedCatalog,
  CatalogRecord,
  CatalogValue,
  CatalogKind,
  ValueKind,
  CatalogScalar,
  CameraDescriptor,
} from './catalog'
import { CameraWatch, type CameraWatchOptions } from './hotplug'
import {
  RecoveryRetry,
  ReconnectJob,
  reconnectOptions,
  type ReconnectOptions,
} from './recovery'
export {
  ReconnectJob,
  type ReconnectOptions,
  type ReconnectState,
} from './recovery'
export {
  CameraWatch,
  type CameraWatchOptions,
  type CameraEvent,
  type CameraWatchState,
} from './hotplug'
import {
  invokeRequestCallback,
  guardRequestCallback,
  RequestCallbackError,
  type RequestCallback,
  type RequestCallbacks,
  type RequestPhase,
} from './request-hooks'
export {
  RequestCallbackError,
  type RequestFrame,
  type RequestCallback,
  type RequestCallbacks,
  type RequestPhase,
} from './request-hooks'
import { decodeMetadata } from './metadata'
import {
  prepareImage,
  stageNativeImage,
  encodeNativeImage,
  saveNativeImage,
  imageStreamId,
  readStreamColorSpace,
  decodeStreamColorSpace,
  processedImageStream,
  type PreparedImage,
  type ImageOptions,
} from './images'
export type {
  ImageOptions,
  ImageProfile,
  ImageFormat,
  PngFilter,
  StreamColorSpace,
} from './images'
import { MappedStream } from './mapping'
export { MappedStream, type MappedPlane } from './mapping'
import {
  OutputBridge,
  invokeOutputFactory,
  discardFactoryOutput,
  PtsOutput,
  PtsStream,
  MuxedOutput,
  guardOutputHook,
  guardHostPath,
  type CustomOutput,
  type OutputStreams,
  type OutputScope,
  type HostOutputQueueStats,
  type OutputCapacityOptions,
} from './outputs'
export {
  FileOutput,
  FileSink,
  MuxedOutput,
  PtsStream,
  PtsOutput,
  type CustomOutput,
  type OutputPacket,
  type OutputStreams,
  type ByteSink,
  type HostOutputQueueStats,
  type OutputCapacityOptions,
} from './outputs'
import {
  BunJob,
  JobCancelledError,
  snapshotJobOptions,
  type JobOptions,
} from './jobs'
import {
  cameraConfiguration,
  copyConfiguration,
  cameraIdentity,
} from './config'
import type { ModeRequest, ModeResponse, ModeRequestHook } from './mode-worker'
export { BunJob, JobCancelledError, type JobOptions } from './jobs'
import {
  native as n,
  ptr,
  storage,
  view,
  handle,
  outPointer,
  check,
  cstring,
  CameraError,
  cameraError,
  CameraDisconnectedError,
  type Pointer,
} from './ffi'
export { CameraError, CameraDisconnectedError } from './ffi'
const recordingOwner = Symbol('recordingOwner')
const consumerState = Symbol('consumerState')
const audioState = Symbol('audioState')
const audioGroupView = Symbol('audioGroupView')
const recordingAudioState = Symbol('recordingAudioState')
const recordingTimestamp = Symbol('recordingTimestamp')
const prepareRecordingAudio = Symbol('prepareRecordingAudio')
const writeSharedAudio = Symbol('writeSharedAudio')
const coordinateRecorder = Symbol('coordinateRecorder')
const coordinatedFlush = Symbol('coordinatedFlush')
const adoptCoordinatedFlush = Symbol('adoptCoordinatedFlush')
const recordingRecovery = Symbol('recordingRecovery')
const readableFrame = Symbol('readableFrame')
const recorderInput = Symbol('recorderInput')
const rgbMainFrame = Symbol('rgbMainFrame')
const legacyRgbInput = Symbol('legacyRgbInput')
const savePreparedImage = Symbol('savePreparedImage')
const encodePreparedImage = Symbol('encodePreparedImage')
export interface CaptureOptions<T = unknown> extends JobOptions<T> {
  /** true captures the clock at admission; bigint supplies an exact clock-domain threshold. */
  flush?: boolean | bigint
  /** Skip this many distinct delivered requests before selecting a result. */
  dropFrames?: number
  /** Select only requests with explicitly true backend SyncReady metadata. */
  syncReady?: boolean
}
export type PngAnimationMetadata = Readonly<
  Omit<ReturnType<Frame['metadata']>, 'crop'>
> & { readonly crop: Readonly<ReturnType<Frame['metadata']>['crop']> }
export interface CapturedPngAnimation {
  readonly data: Uint8Array
  readonly metadata: readonly PngAnimationMetadata[]
}
export interface CapturedPngAnimationFile {
  readonly path: string
  readonly metadata: readonly PngAnimationMetadata[]
}
export interface CapturePngAnimationOptions<T = CapturedPngAnimation>
  extends CaptureOptions<T>, PngAnimationLimits {
  stream?: 'main' | 'lores'
  /** Defaults to native RGB precision; 16 rejects 8-bit/YUV sources. */
  bits?: 8 | 16
  intervalMs?: number
  delayMs?: number
  onFrame?: (frame: {
    readonly index: number
    readonly metadata: PngAnimationMetadata
  }) => void
}
export function captureClockNs(): bigint {
  const out = new BigUint64Array(1)
  check(n.zc_capture_clock_ns(ptr(out)), 'capture clock')
  return out[0]
}
function captureSelection<T>(
  source: CaptureOptions<T>,
  requireSyncReady = false,
) {
  const options = snapshotJobOptions(source, 5000)
  const drop = uint(source.dropFrames ?? 0),
    flush = source.flush,
    syncReady = source.syncReady
  if (syncReady !== undefined && typeof syncReady !== 'boolean')
    throw new RangeError('invalid synchronization selection')
  const readiness = requireSyncReady || syncReady === true
  if (
    flush !== undefined &&
    typeof flush !== 'boolean' &&
    typeof flush !== 'bigint'
  )
    throw new RangeError('invalid capture flush threshold')
  const timestamp =
    typeof flush === 'bigint'
      ? flush
      : flush === true
        ? captureClockNs()
        : undefined
  if (
    timestamp !== undefined &&
    (timestamp < 0n || timestamp > 0xffffffffffffffffn)
  )
    throw new RangeError('invalid capture timestamp')
  if (timestamp === undefined && drop === 0 && !readiness)
    return { options, filter: undefined }
  const filter = storage(32)
  check(
    n.zc_capture_filter_init(
      ptr(filter),
      drop,
      (timestamp === undefined ? 0 : 3) | (readiness ? 4 : 0),
      timestamp ?? 0n,
    ),
  )
  return { options, filter }
}
function focusCaptureSelection<T>(options: FocusLockedOptions<T>) {
  const immediateOption = options.immediate,
    focusedOption = options.requireFocused
  for (const value of [immediateOption, focusedOption])
    if (value !== undefined && typeof value !== 'boolean')
      throw new RangeError('invalid focus-lock option')
  const immediate = immediateOption ?? false,
    requireFocused = focusedOption ?? true,
    restoreTimeout = options.restoreTimeoutMs ?? 5000
  if (!Number.isFinite(restoreTimeout) || restoreTimeout < 0)
    throw new RangeError('invalid restoration deadline')
  return {
    immediate, requireFocused, restoreTimeout,
    selection: captureSelection(options),
  }
}
export interface ModeJobOptions<T = unknown> extends JobOptions<T> {
  dropFrames?: number
  /** Resolve the existing scan before transferring camera ownership. Default: cancel. */
  autofocusPolicy?: 'cancel' | 'wait' | 'reject'
  /** Require a fresh successful scan in the target mode before capture/publication. */
  autofocus?: boolean
}
export interface RecordingModeMember {
  recording: Recording
  settings?: RecorderSessionOptions
  output?: string | CustomOutput | null
  /** Omitted keeps the current microphone when audio remains enabled; null detaches it. */
  audio?: AudioCapture | null
  backpressure?: RecordingBackpressure
}
export interface RecoveredRecordingSession {
  readonly camera: Camera
  readonly recordings: readonly Recording[]
}
export interface RecordingModeOptions extends ModeJobOptions<Recording> {
  audio?: AudioCapture
}
export const Codec = { h264: 1, hevc: 2, mjpeg: 3 } as const
export const Control = {
  aeEnable: 1,
  exposureTime: 2,
  analogueGain: 3,
  exposureValue: 4,
  awbEnable: 5,
  colourGains: 6,
  brightness: 7,
  contrast: 8,
  saturation: 9,
  sharpness: 10,
  frameDurationLimits: 11,
  lensPosition: 12,
  afMode: 13,
  afTrigger: 14,
  afRange: 15,
  afSpeed: 16,
  afMetering: 17,
  afWindows: 18,
  scalerCrop: 19,
  noiseReduction: 20,
  aeMetering: 21,
  aeExposure: 22,
  awbMode: 23,
  exposureTimeMode: 24,
  analogueGainMode: 25,
  afPause: 26,
  aeConstraint: 27,
  colourTemperature: 28,
  aeFlickerMode: 29,
  aeFlickerPeriod: 30,
} as const
const pause = (ms = 1) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
const u64 = (d: Uint8Array, o = 0) => view(d).getBigUint64(o, true)
function uint(value: number, max = 0xffffffff) {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new RangeError('unsigned integer required')
  return value
}
function nanos(ms: number) {
  if (!Number.isFinite(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER / 1e6)
    throw new RangeError('invalid duration')
  return BigInt(Math.round(ms * 1e6))
}
function fields(
  size: number,
  init: (p: Pointer) => void,
  values: (number | undefined)[],
) {
  const data = storage(size)
  init(ptr(data))
  values.forEach((value, i) => {
    if (value !== undefined) view(data).setUint32(i * 4, uint(value), true)
  })
  return data
}
function state(data: Uint8Array) {
  return {
    generation: u64(data),
    errorCode: view(data).getInt32(8, true),
    splitState: view(data).getUint32(12, true),
    pending: !!view(data).getUint32(16, true),
  }
}
const nativeAdmission = Symbol('admitted camera owner')
type CameraAdmission = {
  [nativeAdmission]: Pointer
  started: boolean
  claimed: boolean
}
/** A failed disposal still owns a camera. Retry camera.close() before discarding. */
export class CameraCleanupError extends AggregateError {
  readonly owners: readonly { close(): Promise<void> }[]
  constructor(
    errors: unknown[],
    owners: readonly { close(): Promise<void> }[],
  ) {
    super(
      errors.flatMap((e) => (e instanceof CameraCleanupError ? e.errors : [e])),
      'camera operation failed with retained cleanup ownership',
    )
    this.owners = Object.freeze([
      ...new Set([
        ...owners,
        ...errors.flatMap((e) =>
          e instanceof CameraCleanupError ? e.owners : [],
        ),
      ]),
    ])
    this.name = 'CameraCleanupError'
  }
  async cleanup() {
    const settled = await Promise.allSettled(
      this.owners.map((owner) => owner.close()),
    )
    const errors = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (errors.length) throw new CameraCleanupError(errors, this.owners)
  }
}
class ModeWorkerFault extends Error {}
function runModeWorker(
  request: ModeRequest,
  onHook?: (request: ModeRequestHook) => void,
): Promise<ModeResponse> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./mode-worker.ts', import.meta.url).href)
    } catch (error) {
      reject(error)
      return
    }
    let settled = false,
      callbackError: unknown
    worker.onmessage = (event) => {
      if (settled) return
      if (event.data?.kind === 'request-hook') {
        const hook = event.data as ModeRequestHook
        const state =
          request.requestHooks && new Int32Array(request.requestHooks.control)
        if (
          !state ||
          hook.ticket !== Atomics.load(state, 0) ||
          Atomics.compareExchange(state, 1, 0, 1) !== 0
        )
          return
        let code = 0
        try {
          if (
            Atomics.load(new Int32Array(request.cancel), 0) ||
            Date.now() >= request.deadline
          )
            code = -5
          else onHook?.(hook)
        } catch (error) {
          callbackError ??= error
          code = -6
        } finally {
          Atomics.store(state, 2, code)
          Atomics.store(state, 1, 2)
          Atomics.notify(state, 1)
        }
        return
      }
      settled = true
      resolve({ ...event.data, callbackError })
      worker.terminate()
    }
    worker.onerror = (event) => {
      if (settled) return
      settled = true
      reject(new ModeWorkerFault(event.message))
      worker.terminate()
    }
    try {
      worker.postMessage(request)
    } catch (error) {
      worker.terminate()
      reject(error)
    }
  })
}

function recoveryCleanup(request: ModeRequest, handle: Pointer) {
  let owned = handle,
    pending: Promise<void> | undefined,
    fault: unknown
  return {
    close(): Promise<void> {
      if (pending) return pending
      if (fault) return Promise.reject(fault)
      if (!owned) return Promise.resolve()
      pending = runModeWorker({
        ...request,
        handle: owned,
        fresh: false,
        disposeOnly: true,
        previousStarted: false,
        capture: undefined,
        requestHooks: undefined,
        autofocus: false,
        dropFrames: 0,
        cancel: new SharedArrayBuffer(8),
        deadline: Infinity,
      })
        .then((response) => {
          owned = response.handle
          check(
            response.code || response.restoreCode,
            'reconnection candidate cleanup',
          )
        })
        .catch((error) => {
          if (error instanceof ModeWorkerFault) fault = error
          throw error
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    },
  }
}

export interface RuntimeControl {
  id: number
  type: 'bool' | 'int' | 'float' | 'rect'
  values: number[]
}
export interface CameraTransform {
  /** Clockwise rotation followed by flips along the output image axes. */
  rotation?: 0 | 90 | 180 | 270
  hflip?: boolean
  vflip?: boolean
  /** Final diagonal transposition after rotation and flips. */
  transpose?: boolean
  /** Reject pipeline adjustments instead of accepting/reporting them. */
  strict?: boolean
}
export type ImageOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
export interface PreviewOptions extends PreviewViewOptions {
  stream?: PreviewStream
  backend?: 'sdl' | 'headless'
  title?: string
}
export interface PreviewInfo extends PreviewViewOptions {
  stream?: PreviewStream
  backend: 'sdl' | 'headless'
  title: string
  suspended: boolean
}
/** Straight-alpha RGBA8. Active rows are copied into bounded native ownership. */
export interface PreviewOverlay {
  data: Uint8Array
  width: number
  height: number
  stride?: number
}
export interface CameraOptions {
  /** Snapshot before manager startup. Held across mode jobs; conflicts reject. */
  tuning?: TuningSource
  /** Main processed stream. Defaults to RGB byte order BGR888. */
  format?: ProcessedFormat
  colorSpace?: ColorSpaceRequest
  strictColorSpace?: boolean
  transform?: CameraTransform
  /** Opt in to writable mappings and READ|WRITE DMA fences before first start. */
  writable?: boolean
  simulate?: boolean
  width?: number
  height?: number
  buffers?: number
  cameraIndex?: number
  cameraId?: string
  fifo?: boolean
  raw?: boolean
  unpackedRaw?: boolean
  rawFormat?: string
  role?: 'still' | 'preview' | 'video'
  sensor?: { width: number; height: number; bitDepth: number }
  lores?: {
    width: number
    height: number
    rgb?: boolean
    format?: ProcessedFormat
  }
}
type FrameSource = {
  handle: Pointer
  assertOpen(): void
  [legacyRgbInput]?(): boolean
}
export class Frame {
  private released = false
  constructor(
    private camera: FrameSource,
    readonly descriptor: Uint8Array,
  ) {}
  private open() {
    if (this.released) throw new CameraError(-5, 'released frame')
    this.camera.assertOpen()
  }
  get [readableFrame]() {
    this.open()
    check(
      n.zc_frame_readable(this.camera.handle, this.token),
      'frame read access',
    )
    return this.descriptor
  }
  [recorderInput](stream: 'main' | 'lores', target?: Uint8Array) {
    const descriptor = this[readableFrame].slice(),
      selected = storage(208),
      color = storage(24)
    const id = imageStreamId(processedImageStream(stream))
    check(n.zc_get_stream(this.camera.handle, this.token, id, ptr(selected)))
    check(n.zc_get_stream_color_space(this.camera.handle, id, ptr(color)))
    const format = text(selected, 16, 32)
    const formatCode = processedFormatCode(format)
    check(
      n.zc_video_check_input_color_for(
        ptr(color),
        formatCode,
        target ? ptr(target) : null,
      ),
      'recording stream color',
    )
    descriptor.set(selected, 40)
    return { descriptor, color }
  }
  get sequence() {
    return u64(this.descriptor, 8)
  }
  get timestampNs() {
    return u64(this.descriptor, 16)
  }
  get format() {
    return text(this.descriptor, 56, 32)
  }
  /** Keep legacy RGB recording admission free of per-frame string decoding. */
  get [rgbMainFrame]() {
    this.open()
    const d = this.descriptor
    return (
      d[56] === 66 &&
      d[57] === 71 &&
      d[58] === 82 &&
      d[59] === 56 &&
      d[60] === 56 &&
      d[61] === 56 &&
      d[62] === 0 &&
      this.camera[legacyRgbInput]?.() === true
    )
  }
  get width() {
    return view(this.descriptor).getUint32(40, true)
  }
  get height() {
    return view(this.descriptor).getUint32(44, true)
  }
  get token() {
    return this.released ? 0n : u64(this.descriptor)
  }
  colorSpace(stream: StreamName = 'main') {
    this.open()
    return readStreamColorSpace(this.camera.handle, stream)
  }
  copyRGB(stream: 'main' | 'lores' = 'main'): Uint8Array {
    this.open()
    processedImageStream(stream)
    if (stream === 'main') {
      const data = storage(this.width * this.height * 3)
      check(
        n.zc_copy_frame_rgb(
          this.camera.handle,
          this.token,
          ptr(data),
          BigInt(data.length),
        ),
      )
      return data
    }
    const id = imageStreamId(stream),
      descriptor = storage(208)
    check(n.zc_get_stream(this.camera.handle, this.token, id, ptr(descriptor)))
    const d = view(descriptor)
    const data = storage(d.getUint32(0, true) * d.getUint32(4, true) * 3)
    check(
      n.zc_copy_stream_rgb(
        this.camera.handle,
        this.token,
        id,
        ptr(data),
        BigInt(data.length),
      ),
    )
    return data
  }
  makeImage(options: CaptureImageOptions = {}) {
    const selected = snapshotCaptureImageOptions(options)
    this.open()
    return adoptImageSnapshot(resizeImageSnapshot(
      copyNativeImage(this.camera.handle, this.token, selected), selected))
  }
  /** Owned RGB16 words. Requires a 16-bit RGB source; no precision is invented. */
  copyRGB16(stream: 'main' | 'lores' = 'main'): Uint16Array {
    this.open()
    const id = imageStreamId(processedImageStream(stream)),
      descriptor = storage(208)
    check(n.zc_get_stream(this.camera.handle, this.token, id, ptr(descriptor)))
    const format = text(descriptor, 16, 32)
    if (format !== 'BGR161616' && format !== 'RGB161616')
      throw new CameraError(-8, 'RGB16 source required')
    const d = view(descriptor),
      data = storage(d.getUint32(0, true) * d.getUint32(4, true) * 6)
    check(
      n.zc_copy_stream_rgb16(
        this.camera.handle,
        this.token,
        id,
        ptr(data),
        BigInt(data.length),
      ),
    )
    return new Uint16Array(data.buffer)
  }
  /** Owned raw sensor u16 samples. COMP1 uses standard driver offset 2048. */
  copyRaw16(): Uint16Array {
    this.open()
    const descriptor = storage(208)
    check(n.zc_get_stream(this.camera.handle, this.token, 1, ptr(descriptor)))
    const d = view(descriptor),
      data = storage(d.getUint32(0, true) * d.getUint32(4, true) * 2)
    check(
      n.zc_copy_raw16(
        this.camera.handle,
        this.token,
        ptr(data),
        BigInt(data.length),
      ),
    )
    return new Uint16Array(data.buffer)
  }
  copyStream(stream: StreamName = 'main'): PackedStream {
    const names = streamNames([stream])
    this.open()
    return copyNativeStreams(this.camera.handle, this.token, names).streams[
      stream
    ]!
  }
  copyStreams(streams: readonly StreamName[] = ['main']): CapturedStreams {
    const names = streamNames(streams)
    this.open()
    return copyNativeStreams(this.camera.handle, this.token, names)
  }
  retain() {
    this.open()
    const data = storage(456)
    check(
      n.zc_retain(this.camera.handle, this.token, ptr(data)),
      'retain request',
    )
    return new Frame(this.camera, data)
  }
  exportFrame(options: FrameExportOptions = {}) {
    const streams = options.streams, writable = options.writable ?? false
    if (typeof writable !== 'boolean') throw new TypeError('invalid export access')
    const names = streamNames(streams ?? ['main'])
    this.open()
    const mask = names.reduce((mask,name) => mask | (1 << ({main:0,raw:1,lores:2}[name])), 0)
    return exportNativeFrame(this.camera.handle,this.token,mask,writable)
  }
  mapStream(stream: StreamName = 'main') {
    this.open()
    const [name] = streamNames([stream])
    return MappedStream.open(
      this.camera.handle,
      this.token,
      { main: 0, raw: 1, lores: 2 }[name],
    )
  }
  withMappedStream<T>(
    operation: (stream: MappedStream) => T,
    stream: StreamName = 'main',
  ): T {
    using mapped = this.mapStream(stream)
    const result = operation(mapped)
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => {})
      throw new TypeError(
        'mapped callback must be synchronous; use an owned mapping across awaits',
      )
    }
    return result
  }
  get referenceCount() {
    this.open()
    const count = new Uint32Array(1)
    check(n.zc_frame_references(this.camera.handle, this.token, ptr(count)))
    return count[0]
  }
  configurationCatalog() {
    this.open()
    return readCatalog(out => n.zc_frame_configuration_catalog(this.camera.handle, this.token, out))
  }
  configuration() { return decodeFrameConfiguration(this.configurationCatalog()) }
  metadataCatalog() {
    this.open()
    return readCatalog((out) =>
      n.zc_frame_metadata_catalog(this.camera.handle, this.token, out),
    )
  }
  metadata() {
    this.open()
    const data = storage(96)
    check(n.zc_get_frame_metadata(this.camera.handle, this.token, ptr(data)))
    return decodeMetadata(data)
  }
  synchronization() {
    this.open()
    return readFrameSynchronization(this.camera.handle, this.token)
  }
  saveJPEG(path: string, quality = 98) {
    this.saveFile(path, { format: 'jpeg', quality })
  }
  saveFile(path: string, options: ImageOptions = {}) {
    this[savePreparedImage](prepareImage(options, path))
  }
  encodeImage(options: ImageOptions = {}) {
    return this[encodePreparedImage](prepareImage(options))
  }
  [savePreparedImage](prepared: PreparedImage) {
    this.open()
    saveNativeImage(
      this.camera.handle,
      this.token,
      prepared.options,
      prepared.stream,
      prepared.path!,
      prepared.profile,
      prepared.exif,
    )
  }
  [encodePreparedImage](prepared: PreparedImage) {
    this.open()
    return encodeNativeImage(
      this.camera.handle,
      this.token,
      prepared.options,
      prepared.stream,
      prepared.profile,
      prepared.exif,
    )
  }
  saveDNG(path: string) {
    this.open()
    const name = cstring(path)
    check(n.zc_save_dng(this.camera.handle, this.token, ptr(name)))
  }
  release() {
    if (this.released) return
    const code = n.zc_release(this.camera.handle, this.token)
    if (code !== -4) this.released = true
    check(code)
  }
  [Symbol.dispose]() {
    this.release()
  }
}
export interface AutofocusCommandOptions extends JobOptions<number> {
  /** Independent cleanup deadline when a command is cancelled; default 5000 ms. */
  restoreTimeoutMs?: number
}
export interface AutofocusPauseOptions extends AutofocusCommandOptions {
  immediate?: boolean
}
export interface FocusLockedOptions<T = unknown> extends CaptureOptions<T> {
  immediate?: boolean
  requireFocused?: boolean
  /** Deadline for acknowledgement of restored pause intent; default 5000 ms. */
  restoreTimeoutMs?: number
}
type CaptureRequest = {
  transfer?: boolean
  accept?: (frame: Frame) => number
  operation: (frame: Frame) => unknown
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  deadline: number
  signal?: AbortSignal
}
export class Camera {
  static loadTuningFile(name: string, options: LoadTuningOptions = {}) {
    return loadTuningFile(name, options)
  }
  static findTuningAlgorithm(document: TuningDocument, name: string) {
    return findTuningAlgorithm(document, name)
  }
  static alignStream(source: StreamGeometry, options: AlignmentOptions = {}) {
    return alignStream(source, options)
  }
  static alignConfiguration(
    source: CameraOptions,
    options: AlignmentOptions = {},
  ) {
    return alignConfiguration(source, options)
  }
  private selectedId!: string
  private selectedIdBytes!: Uint8Array
  /** Full backend ID, retained even after close. Mode jobs always pin this ID. */
  get cameraId() {
    return this.selectedId
  }
  static discover(options: { simulate?: boolean } = {}) {
    guardOutputHook()
    if (options.simulate !== undefined && typeof options.simulate !== 'boolean')
      throw new RangeError('invalid discovery backend')
    const simulate = options.simulate ?? false
    return cameraDescriptors(
      readCatalog((out) => n.zc_discover(simulate ? 0 : 1, out)),
      simulate,
    )
  }
  static watchCameras(options: CameraWatchOptions = {}) {
    return new CameraWatch(options)
  }
  properties() {
    this.assertOpen()
    return readCatalog((out) => n.zc_camera_properties(this.handle, out))
  }
  controls() {
    this.assertOpen()
    return readCatalog((out) => n.zc_camera_controls(this.handle, out))
  }
  private cameraHandle = 0 as Pointer
  private cachedLegacyRgb?: boolean
  get handle() {
    return this.cameraHandle
  }
  set handle(value: Pointer) {
    this.cameraHandle = value
    if (value && this.lastDeviceError && readDeviceState(value).connected)
      this.lastDeviceError = undefined
    this.cachedLegacyRgb = undefined
  }
  [legacyRgbInput]() {
    if (!this.handle) throw new CameraError(-2, 'camera unavailable')
    if (this.cachedLegacyRgb === undefined) {
      const color = storage(24),
        d = view(color)
      check(n.zc_get_stream_color_space(this.handle, 0, ptr(color)))
      this.cachedLegacyRgb =
        d.getUint32(0, true) === 24 &&
        d.getUint32(4, true) === 1 &&
        d.getUint32(8, true) === 3 &&
        d.getUint32(12, true) === 2 &&
        d.getUint32(16, true) === 1 &&
        d.getUint32(20, true) === 1
    }
    return this.cachedLegacyRgb
  }
  private started = false
  private disconnectJobs = new Set<BunJob<Readonly<DeviceState>>>()
  private reconnectJob?: ReconnectJob<Camera>
  private observedDeviceLoss?: Readonly<DeviceState>
  private disconnectScratch = storage(32)
  private disconnectObserver = new DisconnectObserver(() => {
    if (this.observedDeviceLoss) return this.observedDeviceLoss
    if (this.closing || !this.handle)
      throw new CameraError(-2, 'camera closed during disconnection wait')
    if (this.modeActive || this.coordinatedRecorder || this.coordinatedGroup)
      return undefined
    const state = pollDisconnected(this.handle, this.disconnectScratch)
    if (state) this.observedDeviceLoss ??= state
    return state
  })
  private lastDeviceError?: CameraDisconnectedError
  get deviceError() {
    return this.lastDeviceError
  }
  deviceState() {
    this.assertOpen()
    const state = readDeviceState(this.handle)
    if (!state.connected) this.observedDeviceLoss ??= state
    return state
  }
  private ensureConnected() {
    if (
      !this.modeActive &&
      !this.coordinatedRecorder &&
      !this.coordinatedGroup &&
      this.handle &&
      !readDeviceState(this.handle).connected
    )
      throw new CameraDisconnectedError()
  }
  simulateDisconnect() {
    this.assertOpen()
    check(
      n.zc_simulate_disconnect(this.handle),
      'simulate device disconnection',
    )
    return this.deviceState()
  }
  waitDisconnected(options: JobOptions<Readonly<DeviceState>> = {}) {
    guardRequestCallback()
    this.assertOpen()
    const effective = snapshotJobOptions(options, 30000)
    this.assertOpen()
    if (this.disconnectJobs.size >= 32)
      throw new CameraError(-4, 'disconnection wait queue')
    const job = new BunJob<Readonly<DeviceState>>(
      async (current) => {
        current.check()
        const observed = await this.disconnectObserver.wait(current.signal)
        current.check()
        current.seal()
        return observed
      },
      () => {},
      effective,
    )
    this.disconnectJobs.add(job)
    void job.operationDone.then(() => this.disconnectJobs.delete(job))
    if (effective.signal?.aborted) job.cancel(effective.signal.reason)
    void job.start()
    return job
  }
  /** Recover into a separate owner. Old leases/maps stay with this lost camera. */
  reconnect(options: ReconnectOptions<Camera> = {}) {
    return this.submitReconnect(options)
  }
  private submitReconnect(
    options: ReconnectOptions<Camera>,
    owner?: object,
    schedulePump = true,
  ) {
    guardRequestCallback()
    guardOutputHook()
    const settings = reconnectOptions(options, this.started)
    const admit = () => {
      this.assertOpen()
      if (
        this.hasPendingModes(owner) ||
        (this.reconnectJob && !this.reconnectJob.done) ||
        (this.captureFilesJob && !this.captureFilesJob.done)
      )
        throw new CameraError(-4, 'camera lifecycle job active')
      if (readDeviceState(this.handle).connected)
        throw new CameraError(-2, 'reconnection requires a disconnected camera')
    }
    admit()
    const target = copyConfiguration({
        ...this.options,
        cameraIndex: undefined,
        cameraId: this.selectedId,
      }),
      encoded = cameraConfiguration(target),
      controls = this.readModeControls(settings.autofocus ? 2n : 0n),
      callbacks = this.requestCallbacks,
      retry = new RecoveryRetry(settings)
    if (settings.preview && this.previewConfiguration && !settings.start)
      throw new RangeError('preview recovery requires a started camera')
    const preview = this.prepareRecoveryPreview(
      settings.preview &&
        !settings.job.signal?.aborted &&
        settings.job.timeoutMs !== 0,
    )
    let job: ReconnectJob<Camera>
    try {
      job = new ReconnectJob<Camera>(
        async (current) => {
          let watch: CameraWatch | undefined,
            candidate: Camera | undefined,
            published = false
          let failure: unknown
          const request: ModeRequest = {
            handle: 0 as Pointer,
            fresh: true,
            targetStarted: settings.start,
            ...encoded,
            cameraId: this.selectedIdBytes.slice(),
            previousConfig: encoded.config,
            previousPipeline: encoded.pipeline,
            previousStarted: false,
            ...controls,
            cancel: current.cancellation,
            deadline: Infinity,
            dropFrames: settings.dropFrames,
            autofocus: settings.autofocus,
          }
          try {
            current.check()
            this.assertOpen()
            this.stopPreviewOwned()
            watch = new CameraWatch({ simulate: target.simulate ?? false })
            while (true) {
              current.check()
              if (retry.state.exhausted)
                throw (
                  retry.lastError ??
                  new CameraError(-9, 'reconnection attempts exhausted')
                )
              const available = watch
                .discover()
                .some((entry) => entry.id === this.selectedId)
              if (available && retry.claim()) {
                const response = await runModeWorker(request)
                if (response.code || response.restoreCode) {
                  const error = Object.assign(
                    cameraError(
                      response.code || response.restoreCode,
                      'camera reconnection',
                    ),
                    {
                      controlCode: response.controlCode,
                      restoreCode: response.restoreCode,
                      restoreControlCode: response.restoreControlCode,
                    },
                  )
                  if (response.handle) {
                    const owner = recoveryCleanup(request, response.handle)
                    try {
                      await owner.close()
                    } catch (cleanup) {
                      throw new CameraCleanupError([error, cleanup], [owner])
                    }
                  }
                  current.check()
                  retry.lastError = error
                  if (
                    (response.controlCode &&
                      ![-9, -11].includes(response.controlCode)) ||
                    response.restoreCode ||
                    ![-9, -11, -4].includes(error.code)
                  )
                    throw error
                  retry.complete(true)
                  continue
                }
                // Until the constructor claims it, the worker result is our owner.
                const admission: CameraAdmission = {
                  [nativeAdmission]: response.handle,
                  started: response.started,
                  claimed: false,
                }
                try {
                  candidate = new Camera(target, admission)
                } catch (error) {
                  if (!admission.claimed) {
                    const owner = recoveryCleanup(request, response.handle)
                    try {
                      await owner.close()
                    } catch (cleanup) {
                      throw new CameraCleanupError([error, cleanup], [owner])
                    }
                  }
                  throw error
                }
                if (candidate.cameraId !== this.selectedId)
                  throw new CameraError(
                    -9,
                    'reconnection changed camera identity',
                  )
                candidate.requestCallbacks = callbacks
                preview.apply(candidate)
                current.check()
                await watch.close()
                watch = undefined
                current.check()
                retry.complete(false)
                preview.close()
                if (
                  schedulePump &&
                  (candidate.previewActive ||
                    (candidate.started && candidate.hasRequestCallbacks))
                )
                  candidate.ensurePump()
                current.seal()
                published = true
                return candidate
              }
              try {
                await watch.next({
                  timeoutMs: retry.waitMs(settings.pollMs),
                  signal: current.signal,
                })
              } catch (error) {
                current.check()
                if (!(error instanceof CameraError && error.code === -3))
                  throw error
              }
            }
          } catch (error) {
            failure = error
          }
          const owners = [!published ? candidate : undefined, watch].filter(
            (owner): owner is Camera | CameraWatch => !!owner,
          )
          const failed: (Camera | CameraWatch)[] = [],
            errors: unknown[] = []
          for (const owner of owners) {
            try {
              await owner.close()
            } catch (error) {
              failed.push(owner)
              errors.push(error)
            }
          }
          preview.close()
          if (errors.length)
            throw new CameraCleanupError([failure, ...errors], failed)
          throw failure
        },
        () => {},
        settings.job,
        this.selectedId,
        retry,
      )
    } catch (error) {
      preview.close()
      throw error
    }
    void job.operationDone.then(() => preview.close())
    // Signal registration may have re-entered stop/close or filled this slot.
    try {
      admit()
    } catch (error) {
      job.cancel(error)
      return job
    }
    this.reconnectJob = job
    void job.operationDone.then(() => {
      if (this.reconnectJob === job) this.reconnectJob = undefined
    })
    void job.start()
    return job
  }
  private prepareRecoveryPreview(enabled: boolean) {
    const configuration = enabled ? this.previewConfiguration : undefined
    let overlay = 0 as Pointer
    if (configuration && this.overlayHandle) {
      const out = outPointer()
      check(
        n.zc_preview_overlay_clone(this.overlayHandle, ptr(out)),
        'snapshot recovery overlay',
      )
      overlay = handle(out)
    }
    return {
      apply: (camera: Camera) => {
        if (!configuration) return
        camera.openPreviewOwned(configuration)
        if (overlay) {
          check(
            n.zc_preview_set_overlay(camera.previewHandle, overlay),
            'restore recovery overlay',
          )
          camera.overlayHandle = overlay
          overlay = 0 as Pointer
        }
      },
      close: () => {
        if (overlay) {
          n.zc_preview_overlay_close(overlay)
          overlay = 0 as Pointer
        }
      },
    }
  }
  /** Flush every selected lost session and commit replacement sessions together. */
  reconnectRecordingsAsync(
    members: readonly RecordingModeMember[],
    options: ReconnectOptions<RecoveredRecordingSession> = {},
  ): BunJob<RecoveredRecordingSession> {
    guardRequestCallback()
    guardOutputHook()
    this.assertOpen()
    if (readDeviceState(this.handle).connected)
      throw new CameraError(-2, 'recovery requires a disconnected camera')
    const settings = reconnectOptions(options, true)
    if (!settings.start)
      throw new RangeError('recording recovery requires a started camera')
    const count = uint(members.length, 8)
    if (!count) throw new RangeError('recording recovery requires members')
    const plans = Array.from({ length: count }, (_, index) => {
      const member = members[index],
        recording = member.recording,
        state = recording[recordingRecovery](),
        recorder = recording.recorder,
        change = member.settings ?? {},
        proposed = mergeSessionOptions(recorder.options, change),
        exact =
          (change.width !== undefined ? 1 : 0) |
          (change.height !== undefined ? 2 : 0),
        output = member.output ?? null,
        audio =
          member.audio === undefined
            ? proposed.audio
              ? state.audio
              : undefined
            : (member.audio ?? undefined),
        backpressure = member.backpressure ?? recording.backpressure
      if (state.camera !== this || state.closed)
        throw new CameraError(-4, 'recording belongs to another lifecycle')
      if (backpressure !== 'wait' && backpressure !== 'drop')
        throw new RangeError('invalid recording backpressure')
      if (
        audio &&
        (!audio.handle ||
          !proposed.audio ||
          audio.sampleRate !== proposed.audio.sampleRate ||
          audio.channels !== proposed.audio.channels)
      )
        throw new RangeError(
          'audio capture format differs from recorder session',
        )
      if (typeof output === 'string') {
        if (!output.length || cstring(output).length > 4097)
          throw new RangeError('recording output path length')
        guardHostPath(output)
      }
      this.assertOpen()
      const input = this.readRecordingInput(proposed),
        candidate = resolvedSession(proposed, input.width, input.height, exact)
      return {
        recording,
        recorder,
        candidate,
        exact,
        output,
        audio,
        backpressure,
      }
    })
    const admit = (reserved = false) => {
      this.assertOpen()
      if (readDeviceState(this.handle).connected)
        throw new CameraError(-2, 'recovery requires a disconnected camera')
      if (
        this.hasPendingModes() ||
        (this.reconnectJob && !this.reconnectJob.done) ||
        (this.captureFilesJob && !this.captureFilesJob.done)
      )
        throw new CameraError(-4, 'camera lifecycle job active')
      const known = new Set([...this.recordings, ...this.failedRecordings])
      if (
        new Set(plans.map((p) => p.recorder)).size !== plans.length ||
        [...known].some((r) => !plans.some((p) => p.recording === r)) ||
        plans.some((p) => {
          const state = p.recording[recordingRecovery]()
          return (
            state.closed ||
            state.camera !== this ||
            (!known.has(p.recording) && !state.retained)
          )
        })
      )
        throw new CameraError(
          -4,
          'recovery must include every attached recording exactly once',
        )
      if (this.modeJobs.size >= 32) throw new CameraError(-4, 'mode queue')
      if (
        [...this.audioGroups.values()].some(
          (group) =>
            group.holds !==
            (reserved && holds.some((hold) => hold.group === group) ? 1 : 0),
        )
      )
        throw new CameraError(
          -4,
          'previous microphone recovery cleanup pending',
        )
    }
    const cadences = new Map<AudioCapture, number>()
    for (const plan of plans)
      if (plan.audio) {
        const fps = plan.candidate.fps ?? 30,
          previous = cadences.get(plan.audio)
        if (previous !== undefined && previous !== fps)
          throw new RangeError('shared audio requires the same recording FPS')
        cadences.set(plan.audio, fps)
      }
    admit()
    const preview = this.prepareRecoveryPreview(
      settings.preview &&
        !settings.job.signal?.aborted &&
        settings.job.timeoutMs !== 0,
    )
    const reservations: ReturnType<Recorder[typeof coordinateRecorder]>[] = []
    const holds: {
      source: AudioCapture
      group: SharedAudio
      id: bigint
      released: boolean
    }[] = []
    let claimed = false,
      released = false,
      camera: Camera | undefined,
      installed = false
    const release = () => {
      if (released) return
      for (const reservation of reservations) reservation.release()
      for (const hold of holds) {
        if (!hold.released) {
          hold.group.releaseHold(hold.id)
          hold.released = true
        }
        if (installed) {
          if (camera?.audioGroups.get(hold.source) === hold.group)
            this.audioGroups.delete(hold.source)
          this.closeIdleAudio(hold.source, hold.group, true)
        }
        // Before publication retain the old cursor/history for an explicit retry.
        // Source stop/close retires such idle groups if recovery is abandoned.
      }
      preview.close()
      released = true
    }
    let job: BunJob<RecoveredRecordingSession>
    try {
      job = new BunJob<RecoveredRecordingSession>(
        async (current) => {
          claimed = true
          let child: ReconnectJob<Camera> | undefined,
            group: RestartGroup | undefined,
            result: RecoveredRecordingSession | undefined,
            failure: unknown
          const children: BunJob<void>[] = [],
            prepared: ReturnType<Camera['prepareGroupRecording']>[] = []
          const abort = () => {
            child?.cancel(current.cancellationReason)
            group?.abort(current.cancellationReason)
            for (const next of children) next.cancel(current.cancellationReason)
          }
          current.signal.addEventListener('abort', abort, { once: true })
          this.sessionRecoveryActive = true
          if (this.timer !== undefined) {
            clearTimeout(this.timer)
            this.timer = undefined
          }
          try {
            current.check()
            while (
              this.pumping ||
              plans.some((p) => this.producers.has(p.recording)) ||
              reservations.some((r) => r.pending())
            ) {
              current.check()
              await pause()
            }
            this.failRecordings(
              new CameraDisconnectedError('source camera lost before recovery'),
            )
            const flushes: BunJob<void>[] = []
            try {
              for (const reservation of reservations)
                flushes.push(reservation.flush())
            } catch (error) {
              for (const flush of flushes) flush.cancel(error)
              await Promise.allSettled(flushes)
              throw error
            }
            for (let i = 0; i < plans.length; i++)
              plans[i].recording[adoptCoordinatedFlush](flushes[i])
            children.push(...flushes)
            const flushed = await Promise.allSettled(flushes)
            const rejected = flushed.find(
              (value) => value.status === 'rejected',
            )
            if (rejected?.status === 'rejected') throw rejected.reason
            current.check()
            child = this.submitReconnect(
              {
                ...settings.job,
                signalFunction: undefined,
                signal: current.signal,
                maxAttempts: settings.maxAttempts,
                initialDelayMs: settings.initialDelayMs,
                maximumDelayMs: settings.maximumDelayMs,
                pollMs: settings.pollMs,
                start: true,
                autofocus: settings.autofocus,
                dropFrames: settings.dropFrames,
                preview: false,
              },
              current,
              false,
            )
            camera = await child
            camera.sessionRecoveryActive = true
            current.check()
            const media = plans.map((plan) => {
              const input = camera!.readRecordingInput(plan.candidate)
              return resolvedSession(
                plan.candidate,
                input.width,
                input.height,
                plan.exact,
              )
            })
            preview.apply(camera)
            group = new RestartGroup(plans.length, () => {
              for (const value of prepared) value.install()
              installed = true
              result = Object.freeze({
                camera: camera!,
                recordings: Object.freeze(
                  prepared.map((value) => value.recording),
                ),
              })
            })
            const restarts: BunJob<void>[] = []
            for (let i = 0; i < plans.length; i++) {
              const next = reservations[i].restart(
                media[i],
                plans[i].output,
                () => {},
                () => {},
                () => {},
                { group, index: i },
              )
              restarts.push(next)
              children.push(next)
              void Promise.resolve(next).catch((error) => {
                group!.failed(i, error)
                if (!group!.published)
                  for (const peer of restarts)
                    if (peer !== next) peer.cancel(error)
              })
            }
            await group.ready
            current.check()
            if (plans.some((p) => p.recorder.closing))
              throw new CameraError(
                -2,
                'recorder closed before recovery publication',
              )
            for (const hold of holds)
              if (cadences.has(hold.source)) {
                hold.group.reconfigure(cadences.get(hold.source)!)
                camera.audioGroups.set(hold.source, hold.group)
              }
            for (let i = 0; i < plans.length; i++)
              prepared.push(
                camera.prepareGroupRecording(
                  plans[i].recorder,
                  plans[i].audio,
                  media[i].fps ?? 30,
                  plans[i].backpressure,
                ),
              )
            current.check()
            group.publish(() => current.seal())
            const outcomes = await Promise.allSettled(restarts)
            for (const value of outcomes)
              if (value.status === 'rejected') failure ??= value.reason
            failure ??= group.error
            if (plans.some((plan) => plan.recorder.closing))
              failure ??= new CameraError(
                -2,
                'recorder closed after recovery publication',
              )
            if (!result)
              throw (
                failure ??
                Error('recovery publication did not install capture owners')
              )
          } catch (error) {
            failure = error
            group?.abort(error)
            if (!group?.published)
              for (const next of children) next.cancel(error)
            await Promise.allSettled(children)
          } finally {
            current.signal.removeEventListener('abort', abort)
            const cleanupErrors: unknown[] = [],
              cleanupOwners: { close(): Promise<void> }[] = []
            if (!group?.published) {
              for (const value of prepared) {
                try {
                  value.discard(false)
                } catch (error) {
                  cleanupErrors.push(error)
                }
              }
              for (const hold of holds)
                if (camera?.audioGroups.get(hold.source) === hold.group)
                  camera.audioGroups.delete(hold.source)
              if (camera) {
                try {
                  await camera.close()
                } catch (error) {
                  cleanupErrors.push(error)
                  cleanupOwners.push(camera)
                }
              }
            }
            try {
              release()
            } catch (error) {
              cleanupErrors.push(error)
              cleanupOwners.push({ close: async () => release() })
            }
            this.sessionRecoveryActive = false
            if (camera && installed) {
              camera.sessionRecoveryActive = false
              if (!camera.closing) {
                try {
                  camera.ensurePump()
                } catch (error) {
                  failure ??= error
                }
              }
            }
            if (cleanupErrors.length)
              failure = new CameraCleanupError(
                [failure, ...cleanupErrors],
                cleanupOwners,
              )
          }
          if (failure !== undefined) {
            if (group?.published && camera)
              throw Object.assign(
                failure instanceof Error
                  ? failure
                  : Error('published recording recovery failed', {
                      cause: failure,
                    }),
                {
                  published: true,
                  session:
                    result ??
                    Object.freeze({ camera, recordings: Object.freeze([]) }),
                },
              )
            throw failure
          }
          return result!
        },
        () => {},
        settings.job,
      )
    } catch (error) {
      release()
      throw error
    }
    try {
      for (const plan of plans)
        reservations.push(plan.recorder[coordinateRecorder](job, this))
      for (const [source, group] of this.audioGroups)
        holds.push({ source, group, id: group.hold(), released: false })
      admit(true)
    } catch (error) {
      job.cancel(error)
      release()
      throw error
    }
    this.modeJobs.add(job)
    void job.operationDone.then(() => {
      this.modeJobs.delete(job)
      if (!claimed) release()
    })
    void job.start()
    return job
  }
  private closing = false
  private stopJob?: Promise<void>
  private closeJob?: Promise<void>
  private failedRecordings = new Set<Recording>()
  private recordings = new Set<Recording>()
  private fanout?: FrameFanout
  private recordingIds = new Map<Recording, bigint>()
  private recordingAudio = new Map<Recording, AudioCapture>()
  private audioGroups = new Map<AudioCapture, SharedAudio>()
  private audioBindings = new Map<
    Recording,
    { group: SharedAudio; id: bigint; source: AudioCapture }
  >()
  private producers = new Map<Recording, Promise<void>>()
  private get recording() {
    return this.recordings.values().next().value
  }
  get activeRecordings(): readonly Recording[] {
    return Object.freeze([...this.recordings])
  }
  private lastPreviewError?: unknown
  get previewError() {
    return this.lastPreviewError
  }
  private previewHandle = 0 as Pointer
  private previewConfiguration?: PreviewConfiguration
  private previewInput?: PreparedPreviewInput
  private previewSuspended = false
  private get previewActive() {
    return this.previewConfiguration !== undefined && !this.previewSuspended
  }
  /** Owned observation; mode jobs can temporarily suspend the configured preview. */
  previewInfo(): PreviewInfo | undefined {
    return (
      this.previewConfiguration && {
        backend: this.previewConfiguration.backend,
        title: this.previewConfiguration.title,
        ...(this.previewConfiguration.stream !== undefined
          ? { stream: this.previewConfiguration.stream }
          : {}),
        ...copyPreviewViewOptions(this.previewConfiguration.view),
        suspended:
          this.previewSuspended ||
          this.modeActive ||
          !!this.coordinatedRecorder ||
          !!this.coordinatedGroup,
      }
    )
  }
  previewStreamInfo(): PreviewStreamInfo | undefined {
    return (
      this.previewInput &&
      copyPreviewStreamInfo(
        this.previewInput,
        this.previewInfo()?.suspended ?? true,
      )
    )
  }
  private overlayHandle = 0 as Pointer
  private timer?: ReturnType<typeof setTimeout>
  private pumping = false
  private requests: CaptureRequest[] = []
  private imageFileJobs = new Set<BunJob<ReturnType<Frame['metadata']>>>()
  private requestCallbacks: Readonly<RequestCallbacks> = Object.freeze({})
  private lastRequestCallbackError?: RequestCallbackError
  private failedRequestMappings = new Set<MappedStream>()
  get requestCallbackMappings() {
    for (const map of this.failedRequestMappings)
      if (map.closed) this.failedRequestMappings.delete(map)
    return Object.freeze([...this.failedRequestMappings])
  }
  retryRequestCallbackCleanup() {
    guardRequestCallback()
    this.assertOpen()
    this.retireRequestMappings()
  }
  private retireRequestMappings() {
    const errors: unknown[] = []
    for (const map of this.requestCallbackMappings)
      try {
        map.close()
      } catch (error) {
        errors.push(error)
      }
    for (const map of this.failedRequestMappings)
      if (map.closed) this.failedRequestMappings.delete(map)
    if (errors.length)
      throw new AggregateError(
        errors,
        'request callback mapping cleanup failed',
      )
  }
  get requestCallbackError() {
    return this.lastRequestCallbackError
  }
  get preCallback() {
    return this.requestCallbacks.pre
  }
  set preCallback(callback: RequestCallback | undefined) {
    this.setRequestCallbacks({ ...this.requestCallbacks, pre: callback })
  }
  get postCallback() {
    return this.requestCallbacks.post
  }
  set postCallback(callback: RequestCallback | undefined) {
    this.setRequestCallbacks({ ...this.requestCallbacks, post: callback })
  }
  setRequestCallbacks(callbacks: RequestCallbacks = {}) {
    guardRequestCallback()
    this.assertOpen()
    const pre = callbacks.pre,
      post = callbacks.post
    for (const callback of [pre, post])
      if (callback !== undefined && typeof callback !== 'function')
        throw new TypeError('request callback must be a function')
    this.assertOpen()
    this.requestCallbacks = Object.freeze({ pre, post })
    this.lastRequestCallbackError = undefined
    if (this.started && this.hasRequestCallbacks) this.ensurePump()
  }
  private get hasRequestCallbacks() {
    return !!(this.requestCallbacks.pre || this.requestCallbacks.post)
  }
  private invokeHook(
    phase: RequestPhase,
    callback: RequestCallback | undefined,
    frame: Frame,
    owner = this.handle,
    reserve = 0n,
  ) {
    if (!callback) return
    try {
      invokeRequestCallback(callback, phase, frame, owner, reserve)
    } catch (error) {
      if (this.requestCallbacks[phase] === callback)
        this.requestCallbacks = Object.freeze({
          ...this.requestCallbacks,
          [phase]: undefined,
        })
      this.lastRequestCallbackError = error as RequestCallbackError
      if (error instanceof RequestCallbackError)
        for (const map of error.unclosedMappings)
          this.failedRequestMappings.add(map)
      throw error
    }
  }
  private async runOwnedMode(request: ModeRequest): Promise<ModeResponse> {
    const callbacks = this.requestCallbacks
    if (!callbacks.pre && !callbacks.post) {
      const response = await runModeWorker(request)
      if (response.deviceLoss)
        this.observedDeviceLoss ??= Object.freeze({ ...response.deviceLoss })
      return response
    }
    const prepared = {
      ...request,
      requestHooks: {
        pre: !!callbacks.pre,
        post: !!callbacks.post,
        control: new SharedArrayBuffer(16),
      },
    }
    const response = await runModeWorker(prepared, (hook) => {
      const frame = new Frame(
        { handle: hook.handle, assertOpen: guardOutputHook },
        hook.frame,
      )
      this.invokeHook(
        hook.phase,
        callbacks[hook.phase],
        frame,
        hook.handle,
        10n,
      )
    })
    if (response.deviceLoss)
      this.observedDeviceLoss ??= Object.freeze({ ...response.deviceLoss })
    return response
  }
  private focusJob?: Pick<
    BunJob<unknown>,
    | 'done'
    | 'cancel'
    | 'operationDone'
    | 'error'
    | 'cancellationReason'
    | 'result'
  >
  private focusProducesValue = false
  private focusCaptureActive = false
  private get focusJobs() {
    return this.focusJob && !this.focusJob.done ? 1 : 0
  }
  private configuration: CameraOptions
  private tuningSession?: TuningSession
  private modeActive = false
  private sessionRecoveryActive = false
  private coordinatedGroup?: { recorders: Recorder[]; initials: Recording[] }
  private coordinatedRecorder?: Recorder
  private coordinatedInitial?: Recording
  private captureFilesJob?: CaptureFilesJob
  private pngCaptureJob?: { readonly done: boolean }
  private captureProgressCallback = false
  private modeJobs = new Set<{
    cancel: (reason?: unknown) => boolean
    done: boolean
    cleanupDone: Promise<void>
    operationDone: Promise<void>
  }>()
  private modeTail: Promise<void> = Promise.resolve()
  get options() {
    return copyConfiguration(this.configuration)
  }
  constructor(options: CameraOptions = {}, admission?: CameraAdmission) {
    this.configuration = copyConfiguration(options)
    const {
      config: cfg,
      pipeline,
      mainFormat,
      processed,
      cameraId,
      writable,
      orientation,
      strictOrientation,
    } = cameraConfiguration(this.configuration)
    const out = outPointer()
    if (this.configuration.tuning !== undefined)
      this.tuningSession = TuningSession.open(this.configuration.tuning, {
        simulate: this.configuration.simulate ?? false,
      })
    try {
      if (admission) {
        admission.claimed = true
        this.handle = admission[nativeAdmission]
        this.started = admission.started
      } else {
        check(
          processed
            ? cameraId
              ? n.zc_open_id_processed_pipeline(
                  ptr(cfg),
                  ptr(pipeline),
                  ptr(processed),
                  orientation,
                  strictOrientation ? 1 : 0,
                  ptr(cameraId),
                  cameraId.length,
                  ptr(out),
                )
              : n.zc_open_processed_pipeline(
                  ptr(cfg),
                  ptr(pipeline),
                  ptr(processed),
                  orientation,
                  strictOrientation ? 1 : 0,
                  ptr(out),
                )
            : mainFormat !== 1
              ? cameraId
                ? n.zc_open_id_formatted_pipeline(
                    ptr(cfg),
                    ptr(pipeline),
                    mainFormat,
                    orientation,
                    strictOrientation ? 1 : 0,
                    ptr(cameraId),
                    cameraId.length,
                    ptr(out),
                  )
                : n.zc_open_formatted_pipeline(
                    ptr(cfg),
                    ptr(pipeline),
                    mainFormat,
                    orientation,
                    strictOrientation ? 1 : 0,
                    ptr(out),
                  )
              : cameraId
                ? n.zc_open_id_oriented_pipeline(
                    ptr(cfg),
                    ptr(pipeline),
                    orientation,
                    strictOrientation ? 1 : 0,
                    ptr(cameraId),
                    cameraId.length,
                    ptr(out),
                  )
                : n.zc_open_oriented_pipeline(
                    ptr(cfg),
                    ptr(pipeline),
                    orientation,
                    strictOrientation ? 1 : 0,
                    ptr(out),
                  ),
          'open camera',
        )
        this.handle = handle(out)
      }
      if (writable && !admission)
        check(n.zc_enable_writable(this.handle), 'enable writable buffers')
      const length = new Uint32Array(1)
      check(n.zc_get_camera_id(this.handle, null, 0, ptr(length)), 'camera ID')
      if (!length[0] || length[0] > 4096)
        throw new CameraError(-9, 'camera ID length')
      this.selectedIdBytes = new Uint8Array(length[0])
      check(
        n.zc_get_camera_id(
          this.handle,
          ptr(this.selectedIdBytes),
          this.selectedIdBytes.length,
          ptr(length),
        ),
        'camera ID',
      )
      if (length[0] !== this.selectedIdBytes.length)
        throw new CameraError(-9, 'camera ID changed')
      this.selectedId = new TextDecoder('utf-8', { fatal: true }).decode(
        this.selectedIdBytes,
      )
      if (
        (this.configuration.simulate ?? false) !==
        (this.info().backend === 0)
      )
        throw new CameraError(-8, 'synthetic backend unavailable')
    } catch (error) {
      if (this.handle) {
        const code = n.zc_close(this.handle)
        if (code)
          throw new CameraCleanupError(
            [error, cameraError(code, 'camera construction cleanup')],
            [this],
          )
      }
      this.handle = 0 as Pointer
      try {
        this.tuningSession?.close()
        this.tuningSession = undefined
      } catch (cleanup) {
        throw new TuningCleanupError([error, cleanup], this.tuningSession!)
      }
      throw error
    }
  }
  assertOpen() {
    guardOutputHook()
    if (this.coordinatedRecorder || this.coordinatedGroup)
      throw new CameraError(-4, 'coordinated recording mode pending')
    if (this.modeActive) throw new CameraError(-4, 'mode change active')
    if (!this.handle || this.closing || this.stopJob)
      throw new CameraError(-2, 'camera unavailable')
  }
  info() {
    this.assertOpen()
    return this.readInfo()
  }
  colorSpace(stream: StreamName = 'main') {
    this.assertOpen()
    return readStreamColorSpace(this.handle, stream)
  }
  colorNegotiation(stream: 'main' | 'lores' = 'main') {
    this.assertOpen()
    return readColorNegotiation(this.handle, processedImageStream(stream))
  }
  orientation() {
    this.assertOpen()
    const data = storage(16)
    check(n.zc_get_orientation(this.handle, ptr(data)))
    const v = view(data)
    return {
      requested: v.getUint32(4, true) as ImageOrientation,
      actual: v.getUint32(8, true) as ImageOrientation,
      adjusted: v.getUint32(12, true) !== 0,
    }
  }
  private readInfo() {
    const d = storage(680)
    check(n.zc_get_info(this.handle, ptr(d)))
    const v = view(d)
    return {
      backend: v.getUint32(0, true),
      buffers: v.getUint32(4, true),
      width: v.getUint32(8, true),
      height: v.getUint32(12, true),
      stride: v.getUint32(16, true),
      format: text(d, 24, 32),
      cameraId: this.selectedId,
    }
  }
  private readRecordingInput(options: RecorderOptions) {
    const target =
      options.colorSpace === undefined
        ? undefined
        : encodeColorSpace(options.colorSpace)
    if ((options.stream ?? 'main') === 'main') {
      const info = this.readInfo()
      const formatCode = processedFormatCode(info.format)
      if (
        !isYuv(info.format) &&
        target === undefined &&
        !this[legacyRgbInput]()
      )
        throw new CameraError(-8, 'recording stream color')
      if (info.format !== 'BGR888' || target !== undefined) {
        const color = storage(24)
        check(n.zc_get_stream_color_space(this.handle, 0, ptr(color)))
        check(
          n.zc_video_check_input_color_for(
            ptr(color),
            formatCode,
            target ? ptr(target) : null,
          ),
          'recording stream color',
        )
      }
      return info
    }
    const data = storage(224),
      color = storage(24)
    check(n.zc_get_pipeline_info(this.handle, ptr(data)))
    const d = view(data)
    if (!d.getUint32(28, true))
      throw new CameraError(-8, 'lores recording stream disabled')
    const format = text(data, 32, 32)
    const formatCode = processedFormatCode(format)
    check(n.zc_get_stream_color_space(this.handle, 2, ptr(color)))
    check(
      n.zc_video_check_input_color_for(
        ptr(color),
        formatCode,
        target ? ptr(target) : null,
      ),
      'recording stream color',
    )
    return { width: d.getUint32(16, true), height: d.getUint32(20, true) }
  }
  stats() {
    this.assertOpen()
    const d = storage(40)
    check(n.zc_get_stats(this.handle, ptr(d)))
    return {
      completed: u64(d),
      delivered: u64(d, 8),
      dropped: u64(d, 16),
      errors: u64(d, 24),
      ready: view(d).getUint32(32, true),
      leased: view(d).getUint32(36, true),
    }
  }
  sensorModes() {
    this.assertOpen()
    const count = new Uint32Array(1)
    check(n.zc_get_sensor_modes(this.handle, null, 0, ptr(count)))
    const d = storage(count[0] * 44)
    if (count[0])
      check(n.zc_get_sensor_modes(this.handle, ptr(d), count[0], ptr(count)))
    return Array.from({ length: count[0] }, (_, i) => ({
      width: view(d).getUint32(i * 44, true),
      height: view(d).getUint32(i * 44 + 4, true),
      bitDepth: view(d).getUint32(i * 44 + 8, true),
      format: text(d, i * 44 + 12, 32),
    }))
  }
  start() {
    guardRequestCallback()
    this.assertOpen()
    this.ensureConnected()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    this.startOwned()
  }
  private startOwned() {
    this.ensureConnected()
    if (!this.started) {
      check(n.zc_start(this.handle))
      this.started = true
    }
    if (this.hasRequestCallbacks) this.ensurePump()
  }
  acquire(timeoutMs = 0) {
    if (
      (this.captureFilesJob && !this.captureFilesJob.done) ||
      (this.pngCaptureJob && !this.pngCaptureJob.done)
    )
      throw new CameraError(-4, 'capture series active')
    guardRequestCallback()
    return this.acquireOwned(timeoutMs)
  }
  private acquireOwned(timeoutMs: number) {
    this.assertOpen()
    const data = storage(456)
    check(n.zc_acquire(this.handle, uint(timeoutMs), ptr(data)), 'acquire')
    return new Frame(this, data)
  }
  controlSnapshot(): { revision: bigint; controls: RuntimeControl[] } {
    this.assertOpen()
    const snapshot = this.readControls(),
      data = view(snapshot.controls)
    return {
      revision: snapshot.controlRevision,
      controls: Array.from({ length: snapshot.controlCount }, (_, index) => {
        const offset = index * 144,
          count = data.getUint32(offset + 8, true)
        return {
          id: data.getUint32(offset, true),
          type: (['bool', 'int', 'float', 'rect'] as const)[
            data.getUint32(offset + 4, true) - 1
          ],
          values: Array.from({ length: count }, (_, i) =>
            data.getFloat64(offset + 16 + i * 8, true),
          ),
        }
      }),
    }
  }
  private readControls() {
    const controls = storage(32 * 144),
      count = new Uint32Array(1),
      revision = new BigUint64Array(1)
    check(
      n.zc_get_controls(
        this.handle,
        ptr(controls),
        32,
        ptr(count),
        ptr(revision),
      ),
      'snapshot controls',
    )
    return {
      controls: controls.slice(0, count[0] * 144),
      controlCount: count[0],
      controlRevision: revision[0],
    }
  }
  private readNativeControls() {
    const revision = new BigUint64Array(1)
    const controls = readCatalog((out) =>
      n.zc_get_native_controls(this.handle, out, ptr(revision)),
    )
    return { revision: revision[0], controls }
  }
  nativeControlSnapshot(): NativeControlSnapshot {
    this.assertOpen()
    return this.readNativeControls()
  }
  setNativeControls(controls: readonly NativeControl[]) {
    this.assertOpen()
    if (this.focusCaptureActive)
      throw new CameraError(-4, 'focus-locked capture active')
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    const bytes = encodeNativeControls(controls),
      revision = new BigUint64Array(1)
    this.assertOpen()
    if (this.focusCaptureActive || this.hasPendingModes())
      throw new CameraError(-4, 'camera jobs active')
    check(
      n.zc_set_native_controls(
        this.handle,
        ptr(bytes),
        BigInt(bytes.length),
        ptr(revision),
      ),
      'set native controls',
    )
    return revision[0]
  }
  setSynchronization(
    mode: SynchronizationMode,
    options: SynchronizationOptions = {},
  ) {
    guardRequestCallback()
    this.assertOpen()
    const admitted = synchronizationOptions(mode, options)
    return this.setNativeControls(
      synchronizationControls(this.controls(), admitted),
    )
  }
  restoreNativeControls(snapshot: NativeControlSnapshot) {
    this.assertOpen()
    if (this.focusJobs || this.focusCaptureActive || this.hasPendingModes())
      throw new CameraError(-4, 'camera jobs active')
    const admitted = {
      revision: snapshot.revision,
      controls: snapshot.controls,
    }
    const bytes = encodeNativeSnapshot(admitted),
      revision = new BigUint64Array(1)
    this.assertOpen()
    if (this.focusJobs || this.focusCaptureActive || this.hasPendingModes())
      throw new CameraError(-4, 'camera jobs active')
    check(
      n.zc_restore_native_controls(
        this.handle,
        ptr(bytes),
        BigInt(bytes.length),
        admitted.revision,
        ptr(revision),
      ),
      'restore native controls',
    )
    return revision[0]
  }
  private readModeControls(extra = 0n) {
    const legacy = this.readControls(),
      native = this.readNativeControls()
    if (native.revision !== legacy.controlRevision)
      throw new CameraError(-4, 'controls changed during snapshot')
    const owned = nativeAppIds(native.controls),
      kept: Uint8Array[] = []
    const v = view(legacy.controls)
    for (let i = 0; i < legacy.controlCount; i++)
      if (!owned.has(v.getUint32(i * 144, true)))
        kept.push(legacy.controls.slice(i * 144, (i + 1) * 144))
    const controls = new Uint8Array(kept.length * 144)
    kept.forEach((entry, i) => controls.set(entry, i * 144))
    const count = native.controls.records.length,
      passes = (kept.length ? 1 : 0) + (count ? 1 : 0)
    if (
      (passes || extra) &&
      native.revision >
        0xffffffffffffffffn - 4n * BigInt(Math.max(1, passes)) - extra
    )
      throw new CameraError(-2, 'control revision budget exhausted')
    return {
      controls,
      controlCount: kept.length,
      controlRevision: native.revision,
      nativeControls: encodeNativeSnapshot(native),
    }
  }
  setControls(controls: RuntimeControl[]) {
    this.assertOpen()
    if (!controls.length || controls.length > 32)
      throw new RangeError('1..32 controls required')
    if (this.focusCaptureActive)
      throw new CameraError(-4, 'focus-locked capture active')
    const d = storage(controls.length * 144)
    controls.forEach((control, index) => {
      if (
        !control.values.length ||
        control.values.length > 16 ||
        control.values.some((x) => !Number.isFinite(x))
      )
        throw new RangeError('invalid control values')
      const off = index * 144,
        v = view(d)
      v.setUint32(off, uint(control.id), true)
      v.setUint32(
        off + 4,
        { bool: 1, int: 2, float: 3, rect: 4 }[control.type],
        true,
      )
      v.setUint32(off + 8, control.values.length, true)
      control.values.forEach((value, i) =>
        v.setFloat64(off + 16 + i * 8, value, true),
      )
    })
    const revision = new BigUint64Array(1)
    this.assertOpen()
    if (this.focusCaptureActive)
      throw new CameraError(-4, 'focus-locked capture active')
    check(n.zc_set_controls(this.handle, ptr(d), d.length / 144, ptr(revision)))
    return revision[0]
  }
  async autofocus(options: JobOptions<number> = {}): Promise<number> {
    return this.autofocusAsync(options).wait()
  }
  autofocusAsync(options: JobOptions<number> = {}): BunJob<number> {
    guardRequestCallback()
    this.assertOpen()
    if (this.hasPendingModes() || this.focusJobs)
      throw new CameraError(-4, 'camera jobs active')
    const admitted = snapshotJobOptions(options, 5000)
    this.assertOpen()
    if (this.hasPendingModes() || this.focusJobs)
      throw new CameraError(-4, 'camera jobs active')
    const owned = this.handle
    const job = new BunJob<number>(
      async (current) => {
        current.check()
        this.start()
        const id = new BigUint64Array(1)
        check(n.zc_autofocus_start(owned, ptr(id)), 'start autofocus')
        this.ensurePump()
        try {
          while (true) {
            current.check()
            const result = new Uint32Array(1)
            const code = n.zc_autofocus_wait(owned, id[0], 0, ptr(result))
            if (code === 0) return result[0]
            if (code !== -3) check(code)
            await pause()
          }
        } finally {
          check(n.zc_autofocus_cancel(owned, id[0]), 'finish autofocus')
        }
      },
      () => {},
      admitted,
    )
    this.focusProducesValue = false
    this.focusJob = job
    void job.operationDone.then(() => {
      if (this.focusJob === job) this.focusJob = undefined
    })
    if (admitted.signal?.aborted) job.cancel(admitted.signal.reason)
    void job.start()
    return job
  }
  startContinuousAutofocus() {
    guardRequestCallback()
    this.assertOpen()
    if (this.hasPendingModes() || this.focusJobs)
      throw new CameraError(-4, 'camera jobs active')
    const revision = this.setControls([
      { id: Control.afMode, type: 'int', values: [2] },
      { id: Control.afPause, type: 'int', values: [2] },
    ])
    this.start()
    return revision
  }
  autofocusPauseAsync(options: AutofocusPauseOptions = {}) {
    const immediate = options.immediate
    if (immediate !== undefined && typeof immediate !== 'boolean')
      throw new RangeError('invalid immediate option')
    return this.submitPause(immediate ? 0 : 1, options)
  }
  autofocusPause(options: AutofocusPauseOptions = {}) {
    return this.autofocusPauseAsync(options).wait()
  }
  autofocusResumeAsync(options: AutofocusCommandOptions = {}) {
    return this.submitPause(2, options)
  }
  autofocusResume(options: AutofocusCommandOptions = {}) {
    return this.autofocusResumeAsync(options).wait()
  }
  private submitPause(command: number, options: AutofocusCommandOptions) {
    guardRequestCallback()
    this.assertOpen()
    if (this.hasPendingModes() || this.focusJobs)
      throw new CameraError(-4, 'camera jobs active')
    const restoreTimeout = options.restoreTimeoutMs ?? 5000
    if (!Number.isFinite(restoreTimeout) || restoreTimeout < 0)
      throw new RangeError('invalid restoration deadline')
    const admitted = snapshotJobOptions(options, 5000)
    // Option accessors may run application code. Capture ownership only after
    // normalization, then reject lifecycle changes made during that admission.
    this.assertOpen()
    if (this.hasPendingModes() || this.focusJobs)
      throw new CameraError(-4, 'camera jobs active')
    const owned = this.handle
    const job = new BunJob<number>(
      async (current) => {
        current.check()
        this.start()
        // A replacement acknowledgement and its cancellation must remain possible.
        if (this.readControls().controlRevision > 0xffffffffffffffffn - 3n)
          throw new CameraError(-2, 'AF restoration revision budget exhausted')
        const id = new BigUint64Array(1)
        check(
          n.zc_autofocus_pause_start(owned, command, ptr(id)),
          'continuous AF command',
        )
        this.ensurePump()
        try {
          const state = await this.waitFocus(owned, id[0], current)
          if (state !== 3)
            throw new CameraError(-2, 'continuous AF command stopped')
          // No cancellation may win after acknowledgement is published.
          current.seal()
          return state
        } catch (error) {
          try {
            await this.restoreFocus(owned, id[0], restoreTimeout)
          } catch (restorationError) {
            throw this.focusRestorationFailure(error, restorationError)
          }
          throw error
        }
      },
      () => {},
      admitted,
    )
    this.focusProducesValue = false
    this.focusJob = job
    void job.operationDone.then(() => {
      if (this.focusJob === job) this.focusJob = undefined
    })
    if (admitted.signal?.aborted) job.cancel(admitted.signal.reason)
    void job.start()
    return job
  }
  private focusRestorationFailure(error: unknown, restorationError: unknown) {
    if (error && typeof error === 'object') {
      try {
        return Object.assign(error, { restorationError })
      } catch {}
    }
    return new AggregateError(
      [error, restorationError],
      'AF restoration failed',
    )
  }
  private async restoreFocus(owned: Pointer, id: bigint, timeoutMs: number) {
    let restoreId: bigint | undefined
    try {
      const restored = new BigUint64Array(1)
      check(
        n.zc_autofocus_pause_restore(owned, id, ptr(restored)),
        'restore continuous AF intent',
      )
      restoreId = restored[0]
      const state = await this.waitFocus(
        owned,
        restoreId,
        undefined,
        performance.now() + timeoutMs,
      )
      if (state !== 3) throw new CameraError(-2, 'AF restoration stopped')
    } catch (error) {
      // Failed submission leaves the original command owned. Retire whichever
      // command is current, preserving cancellation failures beside the cause.
      const code = n.zc_autofocus_cancel(owned, restoreId ?? id)
      if (code) {
        if (error && typeof error === 'object') {
          try {
            Object.assign(error, { restorationCancellationCode: code })
          } catch {
            throw new AggregateError(
              [error, cameraError(code, 'cancel AF restoration')],
              'AF restoration cleanup failed',
            )
          }
        } else {
          throw new AggregateError(
            [error, cameraError(code, 'cancel AF restoration')],
            'AF restoration cleanup failed',
          )
        }
      }
      throw error
    }
  }
  private async waitFocus(
    owned: Pointer,
    id: bigint,
    current?: { check(): void },
    deadline = Infinity,
  ): Promise<number> {
    while (true) {
      current?.check()
      if (performance.now() >= deadline)
        throw new CameraError(-3, 'AF restoration deadline')
      const state = new Uint32Array(1)
      const code = n.zc_autofocus_wait(owned, id, 0, ptr(state))
      if (!code) return state[0]
      if (code !== -3) check(code)
      // stop/close has suspended the public pump but must join this owner first.
      if (this.closing || this.stopJob) {
        const frame = storage(456)
        const rc = n.zc_acquire(owned, 0, ptr(frame))
        if (!rc) check(n.zc_release(owned, view(frame).getBigUint64(0, true)))
        else if (rc !== -3) check(rc)
      } else this.ensurePump()
      await pause()
    }
  }
  captureFocusLockedAsync<T>(
    operation: (frame: Frame) => T,
    options: FocusLockedOptions<T> = {},
  ): BunJob<T> {
    return this.submitFocusLocked(operation, options)
  }
  private submitFocusLocked<T>(
    operation: (frame: Frame) => T,
    options: FocusLockedOptions<T>,
    discard?: (value: T) => void,
    transfer = false,
    admitted?: ReturnType<typeof focusCaptureSelection<T>>,
  ): BunJob<T> {
    guardRequestCallback()
    this.assertOpen()
    if (this.hasPendingModes() || this.focusJobs || this.requests.length)
      throw new CameraError(-4, 'camera jobs active')
    if (typeof operation !== 'function')
      throw new TypeError('invalid focus capture callback')
    const { immediate, requireFocused, restoreTimeout, selection } =
      admitted ?? focusCaptureSelection(options)
    this.assertOpen()
    if (this.hasPendingModes() || this.focusJobs || this.requests.length)
      throw new CameraError(-4, 'capture admission changed')
    const owned = this.handle
    const job = new BunJob<T>(
      async (current) => {
        current.check()
        this.start()
        if (this.readControls().controlRevision > 0xffffffffffffffffn - 3n)
          throw new CameraError(
            -2,
            'focus restoration revision budget exhausted',
          )
        const id = new BigUint64Array(1)
        check(
          n.zc_autofocus_pause_start(owned, immediate ? 0 : 1, ptr(id)),
          'lock continuous AF',
        )
        this.focusCaptureActive = true
        this.ensurePump()
        let failure: unknown,
          failed = false,
          captured = false,
          value: T | undefined
        try {
          try {
            const state = await this.waitFocus(owned, id[0], current)
            if (state !== 3) throw new CameraError(-2, 'AF lock stopped')
            current.check()
            value = await new Promise<T>((resolve, reject) => {
              this.requests.push({
                transfer,
                accept: (frame) => {
                  const focused = n.zc_focus_locked_validate(
                    owned,
                    id[0],
                    frame.token,
                    requireFocused ? 1 : 0,
                  )
                  return (
                    focused ||
                    (selection.filter
                      ? n.zc_capture_filter_accept(
                          owned,
                          frame.token,
                          ptr(selection.filter),
                        )
                      : 0)
                  )
                },
                operation: (frame) => {
                  const result = operation(frame)
                  if (
                    result &&
                    typeof (result as { then?: unknown }).then === 'function'
                  ) {
                    void Promise.resolve(result).catch(() => {})
                    throw new TypeError(
                      'focus capture callback must be synchronous',
                    )
                  }
                  return result
                },
                resolve: resolve as (value: unknown) => void,
                reject,
                signal: current.signal,
                deadline: Infinity,
              })
              this.ensurePump()
            })
            captured = true
            current.check()
          } catch (error) {
            failure = error
            failed = true
          }
          try {
            await this.restoreFocus(owned, id[0], restoreTimeout)
          } catch (restorationError) {
            // Cancellation can arrive while restoration is being joined, after
            // the capture-phase check. Preserve it alongside cleanup failure.
            if (!failed && current.cancelRequested) {
              failure = current.cancellationReason
              failed = true
            }
            if (failed) {
              failure = this.focusRestorationFailure(failure, restorationError)
            } else {
              failure = restorationError
              failed = true
            }
          } finally {
            this.focusCaptureActive = false
          }
          if (failed) throw failure
          current.check()
          // Publish only after CAF restoration. A request transferred by the
          // pump is still private until this cancellation boundary is sealed.
          current.seal()
          return value as T
        } catch (error) {
          if (captured && discard) {
            try {
              discard(value as T)
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                'focus capture ownership cleanup failed',
              )
            }
          }
          throw error
        }
      },
      () => {},
      selection.options,
    )
    this.focusProducesValue = true
    this.focusJob = job
    void job.operationDone.then(() => {
      if (this.focusJob === job) this.focusJob = undefined
    })
    if (selection.options.signal?.aborted)
      job.cancel(selection.options.signal.reason)
    void job.start()
    return job
  }
  captureFocusLockedRequestAsync(options: FocusLockedOptions<Frame> = {}) {
    return this.submitFocusLocked(
      (frame) => frame,
      options,
      (frame) => frame.release(),
      true,
    )
  }
  captureFocusLockedRequest(options: FocusLockedOptions<Frame> = {}) {
    return this.captureFocusLockedRequestAsync(options).wait()
  }
  captureFocusLockedStreamsAsync(
    streams: readonly StreamName[] = ['main'],
    options: FocusLockedOptions<CapturedStreams> = {},
  ) {
    const names = streamNames(streams)
    return this.captureFocusLockedAsync(
      (frame) => frame.copyStreams(names),
      options,
    )
  }
  captureFocusLockedStreams(
    streams: readonly StreamName[] = ['main'],
    options: FocusLockedOptions<CapturedStreams> = {},
  ) {
    return this.captureFocusLockedStreamsAsync(streams, options).wait()
  }
  captureFocusLockedRGB(
    options: FocusLockedOptions<Uint8Array> & {
      stream?: 'main' | 'lores'
    } = {},
  ) {
    const stream = processedImageStream(options.stream)
    return this.captureFocusLockedAsync(
      (frame) => frame.copyRGB(stream),
      options,
    )
  }
  captureFocusLockedMetadata(
    options: FocusLockedOptions<ReturnType<Frame['metadata']>> = {},
  ) {
    return this.captureFocusLockedAsync((frame) => frame.metadata(), options)
  }
  captureFocusLockedBuffer(
    stream: 'main' | 'raw' | 'lores' = 'main',
    options: FocusLockedOptions<ReturnType<Frame['copyStream']>> = {},
  ) {
    return this.captureFocusLockedAsync(
      (frame) => frame.copyStream(stream),
      options,
    )
  }
  captureFocusLockedFile(
    path: string,
    options: FocusLockedOptions<ReturnType<Frame['metadata']>> &
      ImageOptions = {},
  ) {
    return this.submitImageFile(path, options, true)
  }
  captureFocusLockedEncodedImage(
    options: FocusLockedOptions<Uint8Array> & ImageOptions = {},
  ) {
    const prepared = prepareImage(options)
    return this.captureFocusLockedAsync(
      (frame) => frame[encodePreparedImage](prepared),
      options,
    )
  }
  private modeFocusPolicy<T>(options: ModeJobOptions<T>) {
    const policy = options.autofocusPolicy ?? 'cancel'
    if (!['cancel', 'wait', 'reject'].includes(policy))
      throw new RangeError('invalid autofocus policy')
    if (
      options.autofocus !== undefined &&
      typeof options.autofocus !== 'boolean'
    )
      throw new RangeError('invalid autofocus option')
    if (policy === 'reject' && this.focusJobs)
      throw new CameraError(-4, 'autofocus active')
    return policy
  }
  private checkModeLeases() {
    const stats = storage(40)
    check(n.zc_get_stats(this.handle, ptr(stats)))
    if (view(stats).getUint32(36, true))
      throw new CameraError(-4, 'mode requires unleased camera')
  }
  private async settleFocus<T>(
    policy: 'cancel' | 'wait' | 'reject',
    current: BunJob<T>,
  ) {
    const focus = this.focusJob,
      producesValue = this.focusProducesValue
    if (!focus || focus.done) return
    if (policy === 'reject') throw new CameraError(-4, 'autofocus active')
    if (policy === 'cancel')
      focus.cancel(new JobCancelledError('autofocus superseded by mode switch'))
    while (!focus.done) {
      current.check()
      await pause()
    }
    await focus.operationDone
    current.check()
    // Waiting observes the old scan's outcome; cancellation intentionally replaces it.
    if (
      policy === 'cancel' &&
      focus.error !== undefined &&
      focus.error !== focus.cancellationReason
    )
      throw focus.error
    if (policy === 'wait') {
      const state = await focus.result()
      if (!producesValue && state !== 3)
        throw Object.assign(
          new CameraError(-6, 'autofocus failed before mode switch'),
          { autofocusState: state },
        )
    }
  }
  capture<T>(
    operation: (frame: Frame) => T,
    options: CaptureOptions<T> = {},
  ): Promise<T> {
    return this.captureAsync(operation, options).wait()
  }
  captureAsync<T>(
    operation: (frame: Frame) => T,
    options: CaptureOptions<T> = {},
  ): BunJob<T> {
    return this.submitCapture(operation, options)
  }
  private submitCapture<T>(
    operation: (frame: Frame) => T,
    options: CaptureOptions<T>,
    discard?: (value: T) => void,
    transfer = false,
    owner?: object,
    requireSyncReady = false,
    admitted?: ReturnType<typeof captureSelection<T>>,
  ): BunJob<T> {
    guardRequestCallback()
    this.assertOpen()
    if (this.hasPendingModes(owner))
      throw new CameraError(-4, 'mode jobs pending')
    if (this.focusCaptureActive)
      throw new CameraError(-4, 'focus-locked capture active')
    if (this.requests.length >= 32) throw new CameraError(-4, 'capture queue')
    if (typeof operation !== 'function')
      throw new TypeError('capture operation must be a function')
    const selection = admitted ?? captureSelection(options, requireSyncReady)
    this.assertOpen()
    if (
      this.hasPendingModes(owner) ||
      this.focusCaptureActive ||
      this.requests.length >= 32
    )
      throw new CameraError(-4, 'capture admission changed')
    const owned = this.handle
    const job = new BunJob<T>(
      async (current) => {
        current.check()
        this.startOwned()
        let captured = false,
          value: T | undefined
        try {
          value = await new Promise<T>((resolve, reject) => {
            this.requests.push({
              transfer,
              accept: selection.filter
                ? (frame) =>
                    n.zc_capture_filter_accept(
                      owned,
                      frame.token,
                      ptr(selection.filter!),
                    )
                : undefined,
              operation: (frame) => {
                const result = operation(frame)
                if (
                  result &&
                  typeof (result as { then?: unknown }).then === 'function'
                ) {
                  void Promise.resolve(result).catch(() => {})
                  throw new TypeError(
                    'capture callback must be synchronous; retain the request for async work',
                  )
                }
                return result
              },
              resolve: resolve as (value: unknown) => void,
              reject,
              deadline: Infinity,
              signal: current.signal,
            })
            this.ensurePump()
          })
          captured = true
          current.check()
          current.seal()
          return value
        } catch (error) {
          if (captured && discard) {
            try {
              discard(value as T)
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                'capture ownership cleanup failed',
              )
            }
          }
          throw error
        }
      },
      () => {},
      selection.options,
    )
    if (selection.options.signal?.aborted)
      job.cancel(selection.options.signal.reason)
    void job.start()
    return job
  }
  /** Own one bounded serial file session; completion always joins camera stop. */
  startAndCaptureFiles(
    targets: CaptureFileTargets,
    options: CaptureFilesOptions = {},
  ): CaptureFilesJob {
    guardRequestCallback()
    this.assertOpen()
    this.checkModeAdmission()
    if (this.hasPendingModes())
      throw new CameraError(-4, 'camera modes pending')
    this.checkModeLeases()
    const plan = prepareCaptureFiles(targets, options, this.options)
    this.modeFocusPolicy(plan.modeOptions)
    for (const configuration of [plan.previewMode, plan.captureMode]) {
      cameraIdentity(configuration)
      this.validateModeTuning(configuration)
      this.validateModeIdentity(configuration)
      cameraConfiguration(configuration, true)
    }
    this.assertOpen()
    this.checkModeAdmission()
    if (this.hasPendingModes())
      throw new CameraError(-4, 'camera admission changed')
    this.checkModeLeases()
    const state = new CaptureFilesState(plan.retainResults)
    const job = new CaptureFilesJob(
      async (current) => {
        current.check()
        state.stage = 'preparing'
        let failed = false,
          failure: unknown
        const modeOptions = (focus: boolean) => ({
          ...plan.modeOptions,
          autofocus: focus ? plan.modeOptions.autofocus : false,
          dropFrames: 0,
          timeoutMs: plan.captureTimeoutMs,
          signal: current.signal,
        })
        const openPreview = () => {
          if (plan.preview && !this.previewConfiguration) {
            this.openPreviewOwned(plan.preview)
            this.startOwned()
            this.ensurePump()
          }
        }
        const idle = async (ms: number) => {
          state.stage = 'waiting'
          await waitCaptureInterval(ms, current)
        }
        try {
          this.assertOpen()
          this.checkModeLeases()
          if (plan.intervalMs > 0 || plan.initialDelayMs > 0) {
            await this.submitMode(
              plan.previewMode,
              undefined,
              modeOptions(false),
              current,
            )
            openPreview()
            await idle(plan.initialDelayMs)
          }
          if (plan.intervalMs === 0) {
            await this.submitMode(
              plan.captureMode,
              undefined,
              modeOptions(true),
              current,
              false,
            )
          }
          for (let i = 0; i < plan.count; i++) {
            current.check()
            const path = plan.path(i),
              prepared = plan.image(path)
            state.currentIndex = i
            state.currentPath = path
            if (i > 0) await idle(plan.intervalMs)
            current.check()
            state.stage = 'capturing'
            const child =
              plan.intervalMs > 0
                ? this.submitMode<ReturnType<Frame['metadata']>>(
                    plan.captureMode,
                    {
                      kind: 'file',
                      path: prepared.path,
                      imageOptions: prepared.options,
                      imageProfile: prepared.profile,
                      imageExif: prepared.exif,
                      stream: prepared.stream,
                    },
                    {
                      ...plan.modeOptions,
                      timeoutMs: plan.captureTimeoutMs,
                      signal: current.signal,
                    },
                    current,
                  )
                : this.captureSeriesFile(
                    prepared,
                    current,
                    plan.captureTimeoutMs,
                    plan.modeOptions.dropFrames,
                  )
            const metadata = await child.wait()
            await child.cleanupDone
            const file = state.record(i, path, metadata)
            current.check()
            state.stage = 'progress'
            if (plan.onFile) {
              this.captureProgressCallback = true
              try {
                const response = plan.onFile(file) as unknown
                if (
                  response &&
                  typeof (response as { then?: unknown }).then === 'function'
                ) {
                  void Promise.resolve(response).catch(() => {})
                  throw new TypeError(
                    'capture progress callback must be synchronous',
                  )
                }
              } finally {
                this.captureProgressCallback = false
              }
            }
            current.check()
          }
        } catch (error) {
          failed = true
          failure = error
        }
        state.stage = 'stopping'
        const cleanup: unknown[] = []
        try {
          this.clearPreviewOwned()
        } catch (error) {
          cleanup.push(error)
        }
        if (this.handle) {
          try {
            check(n.zc_stop(this.handle), 'stop capture series')
            state.stopped = true
          } catch (error) {
            cleanup.push(error)
          }
          this.started = false
        }
        state.stage = 'finished'
        if (cleanup.length)
          throw new AggregateError(
            failed ? [failure, ...cleanup] : cleanup,
            'capture series cleanup failed',
          )
        if (failed) throw failure
        current.check()
        current.seal()
        return state.snapshot()
      },
      () => {
        this.modeJobs.delete(job)
        if (this.captureFilesJob === job) this.captureFilesJob = undefined
      },
      plan.jobOptions,
      state.snapshot,
    )
    this.captureFilesJob = job
    this.modeJobs.add(job)
    void job.start()
    return job
  }
  private captureSeriesFile<T>(
    prepared: PreparedImage,
    owner: BunJob<T>,
    timeoutMs: number,
    dropFrames: number,
  ) {
    const job = new BunJob<ReturnType<Frame['metadata']>>(
      (current) =>
        withStagedImageFile(prepared.path, current, async (file) => {
          current.check()
          const deadline = Date.now() + timeoutMs
          const capture = this.submitCapture(
            (frame) => {
              stageNativeImage(
                file!.handle!,
                this.handle,
                frame.token,
                prepared.options,
                prepared.stream,
                prepared.profile,
                prepared.exif,
              )
              return frame.metadata()
            },
            { signal: current.signal, timeoutMs, dropFrames },
            undefined,
            false,
            owner,
          )
          const metadata = await capture.wait()
          await capture.cleanupDone
          await file!.publish(current, deadline)
          current.seal()
          return metadata
        }),
      () => {},
      { signal: owner.signal, timeoutMs },
    )
    void job.start()
    return job
  }
  captureRequestAsync(options: CaptureOptions<Frame> = {}) {
    return this.submitCapture(
      (frame) => frame,
      options,
      (frame) => frame.release(),
      true,
    )
  }
  captureRequest(options: CaptureOptions<Frame> = {}) {
    return this.captureRequestAsync(options).wait()
  }
  captureSyncRequestAsync(options: CaptureOptions<Frame> = {}) {
    return this.submitCapture(
      (frame) => frame,
      options,
      (frame) => frame.release(),
      true,
      undefined,
      true,
    )
  }
  captureSyncRequest(options: CaptureOptions<Frame> = {}) {
    return this.captureSyncRequestAsync(options).wait()
  }
  captureStreamsAsync(
    streams: readonly StreamName[] = ['main'],
    options: CaptureOptions<CapturedStreams> = {},
  ) {
    const names = streamNames(streams)
    return this.captureAsync((frame) => frame.copyStreams(names), options)
  }
  captureStreams(
    streams: readonly StreamName[] = ['main'],
    options: CaptureOptions<CapturedStreams> = {},
  ) {
    return this.captureStreamsAsync(streams, options).wait()
  }
  captureBufferAsync(
    stream: StreamName = 'main',
    options: CaptureOptions<PackedStream> = {},
  ) {
    const [name] = streamNames([stream])
    return this.captureAsync((frame) => frame.copyStream(name), options)
  }
  captureBuffer(
    stream: StreamName = 'main',
    options: CaptureOptions<PackedStream> = {},
  ) {
    return this.captureBufferAsync(stream, options).wait()
  }
  captureRGBAsync(
    options: CaptureOptions<Uint8Array> & { stream?: 'main' | 'lores' } = {},
  ) {
    const stream = processedImageStream(options.stream)
    return this.captureAsync((frame) => frame.copyRGB(stream), options)
  }
  captureRaw16Async(options: CaptureOptions<Uint16Array> = {}) {
    return this.captureAsync((frame) => frame.copyRaw16(), options)
  }
  captureRaw16(
    options: CaptureOptions<Uint16Array> = {},
  ): Promise<Uint16Array> {
    return this.captureRaw16Async(options).wait()
  }
  captureRGB16Async(
    options: CaptureOptions<Uint16Array> & { stream?: 'main' | 'lores' } = {},
  ) {
    const stream = processedImageStream(options.stream)
    return this.captureAsync((frame) => frame.copyRGB16(stream), options)
  }
  captureRGB16(
    options: CaptureOptions<Uint16Array> & { stream?: 'main' | 'lores' } = {},
  ) {
    return this.captureRGB16Async(options).wait()
  }
  captureMetadataAsync(
    options: CaptureOptions<ReturnType<Frame['metadata']>> = {},
  ) {
    return this.captureAsync((frame) => frame.metadata(), options)
  }
  captureImageAsync(options: CaptureOptions<CapturedImage> & CaptureImageOptions = {}) {
    const selected = snapshotCaptureImageOptions(options)
    return this.submitCapture(frame => frame.makeImage(selected), options, image => image.close())
  }
  captureImage(options: CaptureOptions<CapturedImage> & CaptureImageOptions = {}) {
    return this.captureImageAsync(options).wait()
  }
  captureFocusLockedImageAsync(options: FocusLockedOptions<CapturedImage> & CaptureImageOptions = {}) {
    const selected = snapshotCaptureImageOptions(options)
    return this.submitFocusLocked(frame => frame.makeImage(selected), options, image => image.close())
  }
  captureFocusLockedImage(options: FocusLockedOptions<CapturedImage> & CaptureImageOptions = {}) {
    return this.captureFocusLockedImageAsync(options).wait()
  }
  captureFileAsync(
    path: string,
    options: CaptureOptions<ReturnType<Frame['metadata']>> & ImageOptions = {},
  ) {
    return this.submitImageFile(path, options, false)
  }
  private submitImageFile(
    path: string,
    options: CaptureOptions<ReturnType<Frame['metadata']>> & ImageOptions,
    locked: boolean,
  ) {
    guardRequestCallback()
    this.assertOpen()
    const prepared = prepareImage(options, path)
    const focus = locked ? focusCaptureSelection(options) : undefined
    const selection = focus?.selection ?? captureSelection(options)
    this.assertOpen()
    if (this.hasPendingModes() || this.focusCaptureActive)
      throw new CameraError(-4, 'camera jobs active')
    if (locked && (this.focusJobs || this.requests.length))
      throw new CameraError(-4, 'camera jobs active')
    if (this.imageFileJobs.size >= 32 || this.requests.length >= 32)
      throw new CameraError(-4, 'capture queue')
    const deadline = Date.now() + (selection.options.timeoutMs ?? Infinity)
    const job = new BunJob<ReturnType<Frame['metadata']>>(
      async (current) => {
        current.check()
        return withStagedImageFile(prepared.path, current, async (file) => {
          current.check()
          const stage = (frame: Frame) => {
            stageNativeImage(
              file!.handle!, this.handle, frame.token, prepared.options,
              prepared.stream, prepared.profile, prepared.exif,
            )
            return frame.metadata()
          }
          const selected = {
            filter: selection.filter,
            options: { signal: current.signal },
          }
          const capture = focus
            ? this.submitFocusLocked(
                stage, selected.options, undefined, false,
                { ...focus, selection: selected },
              )
            : this.submitCapture(
                stage, selected.options, undefined, false,
                undefined, false, selected,
              )
          const metadata = await capture.wait()
          await capture.cleanupDone
          await file!.publish(current, deadline)
          current.seal()
          return metadata
        })
      },
      () => this.imageFileJobs.delete(job),
      selection.options,
    )
    this.imageFileJobs.add(job)
    void job.start()
    return job
  }
  captureFile(
    path: string,
    options: CaptureOptions<ReturnType<Frame['metadata']>> & ImageOptions = {},
  ) {
    return this.captureFileAsync(path, options).wait()
  }
  captureEncodedImageAsync(
    options: CaptureOptions<Uint8Array> & ImageOptions = {},
  ) {
    const prepared = prepareImage(options)
    return this.captureAsync(
      (frame) => frame[encodePreparedImage](prepared),
      options,
    )
  }
  captureEncodedImage(options: CaptureOptions<Uint8Array> & ImageOptions = {}) {
    return this.captureEncodedImageAsync(options).wait()
  }
  capturePngAnimationAsync(
    count: number,
    options: CapturePngAnimationOptions = {},
  ): BunJob<CapturedPngAnimation> {
    return this.submitPngAnimation(
      count,
      options,
    ) as BunJob<CapturedPngAnimation>
  }
  capturePngAnimation(count: number, options: CapturePngAnimationOptions = {}) {
    return this.capturePngAnimationAsync(count, options).wait()
  }
  capturePngAnimationFileAsync(
    path: string,
    count: number,
    options: CapturePngAnimationOptions<CapturedPngAnimationFile> = {},
  ): BunJob<CapturedPngAnimationFile> {
    return this.submitPngAnimation(
      count,
      options,
      path,
    ) as BunJob<CapturedPngAnimationFile>
  }
  capturePngAnimationFile(
    path: string,
    count: number,
    options: CapturePngAnimationOptions<CapturedPngAnimationFile> = {},
  ) {
    return this.capturePngAnimationFileAsync(path, count, options).wait()
  }
  private submitPngAnimation<
    T extends CapturedPngAnimation | CapturedPngAnimationFile,
  >(
    count: number,
    options: CapturePngAnimationOptions<T>,
    path?: string,
  ): BunJob<T> {
    guardRequestCallback()
    guardOutputHook()
    this.assertOpen()
    this.checkModeAdmission()
    if (this.hasPendingModes())
      throw new CameraError(-4, 'camera modes pending')
    this.checkModeLeases()
    const total = apngInteger(count, 1, 256, 'frame count'),
      settings = apngSettings(options),
      effective = snapshotJobOptions(options, 30000),
      stream = processedImageStream(options.stream),
      requestedBits = options.bits,
      interval = apngInteger(
        options.intervalMs ?? 0,
        0,
        0xffffffff,
        'capture interval',
      ),
      delay = apngDelay(options.delayMs ?? 40),
      drop = uint(options.dropFrames ?? 0),
      offeredFlush = options.flush,
      syncReady = options.syncReady,
      onFrame = options.onFrame
    if (onFrame !== undefined && typeof onFrame !== 'function')
      throw new TypeError('invalid APNG frame callback')
    if (
      requestedBits !== undefined &&
      requestedBits !== 8 &&
      requestedBits !== 16
    )
      throw new RangeError('invalid APNG capture depth')
    if (path !== undefined && typeof path !== 'string')
      throw new TypeError('invalid APNG path')
    const destination = path === undefined ? undefined : cstring(path)
    const selection = {
      dropFrames: drop,
      flush: offeredFlush === true ? captureClockNs() : offeredFlush,
      syncReady,
    }
    captureSelection(selection)
    this.assertOpen()
    this.checkModeAdmission()
    if (this.hasPendingModes())
      throw new CameraError(-4, 'camera admission changed')
    this.checkModeLeases()
    let width: number, height: number, format: string
    if (stream === 'main') {
      const info = this.readInfo()
      width = info.width
      height = info.height
      format = info.format
    } else {
      const bytes = storage(224)
      check(n.zc_get_pipeline_info(this.handle, ptr(bytes)))
      const d = view(bytes)
      if (!d.getUint32(28, true))
        throw new CameraError(-8, 'lores capture disabled')
      width = d.getUint32(16, true)
      height = d.getUint32(20, true)
      format = text(bytes, 32, 32)
    }
    const wide = format === 'BGR161616' || format === 'RGB161616',
      bits = requestedBits ?? (wide ? 16 : 8)
    if (bits === 16 && !wide) throw new CameraError(-8, 'RGB16 source required')
    const payload = width * height * 3 * (bits / 8) * total
    if (!Number.isSafeInteger(payload) || payload > settings.maxInput)
      throw new RangeError('APNG capture exceeds input cap')
    const deadline = Date.now() + (effective.timeoutMs ?? 30000)
    const job = new BunJob<T>(
      (current) =>
        withStagedImageFile(destination, current, async (file) => {
          const frames: PngAnimationFrame[] = [],
            metadata: PngAnimationMetadata[] = []
          for (let index = 0; index < total; index++) {
            current.check()
            if (index && interval) await waitCaptureInterval(interval, current)
            const child = this.submitCapture(
              (frame) => {
                const data =
                  bits === 16
                    ? new Uint8Array(frame.copyRGB16(stream).buffer)
                    : frame.copyRGB(stream)
                const m = frame.metadata()
                return {
                  data,
                  metadata: Object.freeze({
                    ...m,
                    crop: Object.freeze({ ...m.crop }),
                  }),
                }
              },
              {
                ...selection,
                signal: current.signal,
                timeoutMs: Math.max(0, deadline - Date.now()),
              },
              undefined,
              false,
              current,
            )
            const result = await child.wait()
            await child.cleanupDone
            metadata.push(result.metadata)
            frames.push({ data: result.data, width, height, bits, delay })
            if (onFrame) {
              this.captureProgressCallback = true
              try {
                const response = onFrame(
                  Object.freeze({ index, metadata: result.metadata }),
                ) as unknown
                if (
                  response &&
                  typeof (response as { then?: unknown }).then === 'function'
                ) {
                  void Promise.resolve(response).catch(() => {})
                  throw new TypeError('APNG frame callback must be synchronous')
                }
              } finally {
                this.captureProgressCallback = false
              }
            }
            current.check()
          }
          const prepared = prepareApng({
            width,
            height,
            frames,
            plays: settings.plays,
            compressLevel: settings.compression,
            pngFilter: (
              ['adaptive', 'none', 'sub', 'up', 'average', 'paeth'] as const
            )[settings.filter],
            maxInputBytes: settings.maxInput,
            maxOutputBytes: settings.maxOutput,
          })
          frames.length = 0
          const data = await runApng(prepared, current, file?.handle)
          current.check()
          if (file) await file.publish(current, deadline)
          current.seal()
          return Object.freeze(
            path === undefined
              ? { data: data!, metadata: Object.freeze(metadata) }
              : { path, metadata: Object.freeze(metadata) },
          ) as T
        }),
      () => {
        this.modeJobs.delete(job)
        if (this.pngCaptureJob === job) this.pngCaptureJob = undefined
      },
      effective,
    )
    try {
      this.assertOpen()
      this.checkModeAdmission()
      this.checkModeLeases()
      if (this.hasPendingModes())
        throw new CameraError(-4, 'camera admission changed')
    } catch (error) {
      job.cancel(error)
      throw error
    }
    this.pngCaptureJob = job
    this.modeJobs.add(job)
    void job.start()
    return job
  }
  captureRGB(
    options: CaptureOptions<Uint8Array> & { stream?: 'main' | 'lores' } = {},
  ) {
    return this.captureRGBAsync(options).wait()
  }
  captureMetadata(options?: CaptureOptions<ReturnType<Frame['metadata']>>) {
    return this.capture((frame) => frame.metadata(), options)
  }
  dropFramesAsync(count: number, options: JobOptions<void> = {}): BunJob<void> {
    guardRequestCallback()
    const drops = uint(count)
    this.assertOpen()
    if (this.hasPendingModes() || this.focusCaptureActive)
      throw new CameraError(-4, 'camera jobs active')
    if (drops)
      return this.submitCapture(() => {}, {
        ...options,
        dropFrames: drops - 1,
      })
    const admitted = captureSelection<void>(options).options
    this.assertOpen()
    if (this.hasPendingModes() || this.focusCaptureActive)
      throw new CameraError(-4, 'capture admission changed')
    const job = new BunJob<void>(
      async (current) => {
        current.check()
      },
      () => {},
      admitted,
    )
    if (admitted.signal?.aborted) job.cancel(admitted.signal.reason)
    void job.start()
    return job
  }
  dropFrames(count: number, options: JobOptions<void> = {}) {
    return this.dropFramesAsync(count, options).wait()
  }
  startPreview(options: string | PreviewOptions = 'zig-camera') {
    guardRequestCallback()
    this.assertOpen()
    this.ensureConnected()
    const configuration = preparePreviewConfiguration(options)
    this.assertOpen()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    if (this.previewConfiguration)
      throw new CameraError(-4, 'preview already active')
    this.openPreviewOwned(configuration)
    try {
      this.start()
      this.ensurePump()
    } catch (error) {
      this.stopPreview()
      throw error
    }
  }
  /** Replace display view settings; omitted window fields leave the OS window in place. */
  setPreviewView(options: PreviewViewOptions = {}) {
    guardRequestCallback()
    this.assertOpen()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    if (!this.previewActive) throw new CameraError(-2, 'preview not active')
    const owner = this.previewConfiguration!,
      prepared = preparePreviewView(options)
    this.assertOpen()
    if (
      this.hasPendingModes() ||
      !this.previewActive ||
      this.previewConfiguration !== owner
    )
      throw new CameraError(-4, 'preview changed during view validation')
    const info = this.previewInput!.info
    validatePreviewView(prepared, info.width, info.height)
    if (owner.backend === 'sdl')
      check(
        n.zc_preview_set_view(this.previewHandle, ptr(prepared.data)),
        'preview view',
      )
    this.previewConfiguration = Object.freeze({ ...owner, view: prepared })
  }
  /** Prepare a replacement display before retiring the old stream owner. */
  setPreviewStream(stream: PreviewStream, options?: PreviewViewOptions) {
    guardRequestCallback()
    this.assertOpen()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    if (!this.previewActive) throw new CameraError(-2, 'preview not active')
    const owner = this.previewConfiguration!,
      selected = snapshotPreviewStream(stream)
    if (selected === undefined)
      throw new RangeError('explicit preview stream required')
    const preparedView =
      options === undefined ? owner.view : preparePreviewView(options)
    this.assertOpen()
    if (
      this.hasPendingModes() ||
      !this.previewActive ||
      this.previewConfiguration !== owner
    )
      throw new CameraError(-4, 'preview changed during stream validation')
    const next = Object.freeze({
        ...owner,
        stream: selected,
        view: preparedView,
      }),
      candidate = this.makePreview(next)
    try {
      this.assertOpen()
      if (
        this.hasPendingModes() ||
        !this.previewActive ||
        this.previewConfiguration !== owner
      )
        throw new CameraError(-4, 'preview changed during stream preparation')
      if (this.previewHandle)
        check(n.zc_preview_close(this.previewHandle), 'old preview close')
    } catch (error) {
      if (candidate.handle)
        check(n.zc_preview_close(candidate.handle), 'candidate preview close')
      throw error
    }
    this.previewHandle = candidate.handle
    this.previewInput = candidate.input
    this.previewConfiguration = next
    this.previewSuspended = false
    this.lastPreviewError = undefined
  }
  /** Replace or clear the display-only overlay. Does not modify capture/encoding. */
  setOverlay(overlay: PreviewOverlay | null) {
    guardRequestCallback()
    guardOutputHook()
    this.assertOpen()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    if (!this.previewActive) throw new CameraError(-2, 'preview not active')
    let candidate = 0 as Pointer
    if (overlay !== null) {
      const data = overlay.data,
        width = uint(overlay.width, 4096),
        height = uint(overlay.height, 4096),
        stride = uint(overlay.stride ?? width * 4)
      if (
        !(data instanceof Uint8Array) ||
        !width ||
        !height ||
        stride < width * 4 ||
        data.byteLength < (height - 1) * stride + width * 4
      )
        throw new RangeError('invalid RGBA preview overlay')
      // Application accessors can reenter; recheck before reserving native data.
      this.assertOpen()
      if (this.hasPendingModes() || !this.previewActive)
        throw new CameraError(-4, 'preview changed during overlay validation')
      if (this.previewConfiguration!.backend === 'headless') return
      const out = outPointer()
      check(
        n.zc_preview_overlay_create(
          ptr(data),
          BigInt(data.byteLength),
          width,
          height,
          stride,
          ptr(out),
        ),
      )
      candidate = handle(out)
    }
    if (this.previewConfiguration!.backend === 'headless') return
    try {
      check(n.zc_preview_set_overlay(this.previewHandle, candidate))
    } catch (error) {
      n.zc_preview_overlay_close(candidate)
      throw error
    }
    n.zc_preview_overlay_close(this.overlayHandle)
    this.overlayHandle = candidate
  }
  private makePreview(configuration: PreviewConfiguration) {
    const input = readPreviewInput(this.handle, configuration.stream),
      { width, height } = input.info
    validatePreviewView(configuration.view, width, height)
    if (configuration.backend === 'headless')
      return { handle: 0 as Pointer, input }
    const name = cstring(configuration.title),
      out = outPointer()
    const open =
      input.info.stream === null
        ? n.zc_preview_open_background
        : n.zc_preview_open
    check(open(ptr(name), width, height, ptr(out)))
    const candidate = handle(out)
    try {
      if (configuration.view.customized)
        check(
          n.zc_preview_set_view(candidate, ptr(configuration.view.data)),
          'preview view',
        )
      if (this.overlayHandle)
        check(n.zc_preview_set_overlay(candidate, this.overlayHandle))
    } catch (error) {
      check(n.zc_preview_close(candidate))
      throw error
    }
    return { handle: candidate, input }
  }
  private openPreviewOwned(configuration: PreviewConfiguration) {
    const prepared = this.makePreview(configuration)
    this.previewHandle = prepared.handle
    this.previewInput = prepared.input
    this.previewConfiguration = configuration
    this.previewSuspended = false
    this.lastPreviewError = undefined
  }
  stopPreview() {
    guardRequestCallback()
    guardOutputHook()
    if (this.modeActive) throw new CameraError(-4, 'mode change active')
    this.clearPreviewOwned()
  }
  private clearPreviewOwned() {
    this.stopPreviewOwned()
    n.zc_preview_overlay_close(this.overlayHandle)
    this.overlayHandle = 0 as Pointer
    this.previewConfiguration = undefined
    this.previewInput = undefined
    this.previewSuspended = false
  }
  private stopPreviewOwned() {
    if (this.previewHandle) {
      check(n.zc_preview_close(this.previewHandle))
      this.previewHandle = 0 as Pointer
    }
    if (this.previewConfiguration) this.previewSuspended = true
  }
  startRecording(
    recorder: Recorder,
    options: {
      fps?: number
      audio?: AudioCapture
      backpressure?: RecordingBackpressure
    } = {},
  ) {
    guardRequestCallback()
    this.assertOpen()
    this.ensureConnected()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    const audio = options.audio,
      backpressure = options.backpressure ?? 'wait',
      fps = uint(options.fps ?? recorder.fps, 1000000)
    if (!fps) throw new RangeError('invalid recording FPS')
    if (backpressure !== 'wait' && backpressure !== 'drop')
      throw new RangeError('invalid recording backpressure')
    this.assertOpen()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    if (recorder.sessionState().phase !== 'open')
      throw new CameraError(-2, 'recorder session must be open')
    const info = this.readRecordingInput(recorder.options)
    if (info.width !== recorder.width || info.height !== recorder.height)
      throw new RangeError('recorder geometry mismatch')
    if (audio) {
      const shared = this.audioGroups.get(audio)
      if (shared && shared.fps !== fps)
        throw new RangeError('shared audio requires the same recording FPS')
      const format = recorder.options.audio
      if (
        !audio.handle ||
        !format ||
        audio.sampleRate !== format.sampleRate ||
        audio.channels !== format.channels
      )
        throw new RangeError(
          'audio capture format differs from recorder session',
        )
    }
    const fanout = (this.fanout ??= new FrameFanout()),
      id = fanout.add(backpressure)
    let owned = false
    let binding: ReturnType<Camera['reserveAudio']> | undefined
    try {
      recorder[recordingOwner](this)
      owned = true
      if (audio) binding = this.reserveAudio(audio, fps)
      this.start()
      const recording = new Recording(this, recorder, audio, fps, backpressure)
      this.recordingIds.set(recording, id)
      if (audio) this.recordingAudio.set(recording, audio)
      if (binding) this.audioBindings.set(recording, binding)
      this.recordings.add(recording)
      recording[consumerState] = fanout.state(id)
      this.ensurePump()
      return recording
    } catch (error) {
      fanout.retire(id)
      if (binding) this.releaseAudio(binding, false)
      if (owned) recorder[recordingOwner](this, true)
      throw error
    }
  }
  private attachCoordinatedRecording(
    recorder: Recorder,
    audio: AudioCapture | undefined,
    backpressure: RecordingBackpressure,
  ) {
    const fanout = (this.fanout ??= new FrameFanout()),
      id = fanout.add(backpressure)
    let binding: ReturnType<Camera['reserveAudio']> | undefined
    try {
      if (audio) binding = this.reserveAudio(audio, recorder.fps)
    } catch (error) {
      fanout.retire(id)
      throw error
    }
    const recording = new Recording(
      this,
      recorder,
      audio,
      recorder.fps,
      backpressure,
    )
    this.recordingIds.set(recording, id)
    if (audio) this.recordingAudio.set(recording, audio)
    if (binding) this.audioBindings.set(recording, binding)
    this.recordings.add(recording)
    recording[consumerState] = fanout.state(id)
    return recording
  }
  /** Flush, negotiate camera geometry, prepare a new media session and resume
   * recording as one reserved job. Pre-publication failure restores the camera. */
  switchRecordingModeAsync(
    recorder: Recorder,
    options: CameraOptions,
    settings: RecorderSessionOptions = {},
    output: string | CustomOutput | null = null,
    jobOptions: RecordingModeOptions = {},
  ): BunJob<Recording> {
    guardRequestCallback()
    this.assertOpen()
    this.ensureConnected()
    cameraIdentity(options)
    const focusPolicy = this.modeFocusPolicy(jobOptions)
    const autofocus = jobOptions.autofocus ?? false
    if (
      this.hasPendingModes() ||
      this.requests.length ||
      this.focusCaptureActive ||
      this.failedRecordings.size
    )
      throw new CameraError(-4, 'camera jobs active')
    if (this.modeJobs.size + this.requests.length >= 32)
      throw new CameraError(-4, 'mode queue')
    if (
      this.recordings.size > 1 ||
      [...this.producers.keys()].some((r) => !this.recordings.has(r))
    )
      throw new CameraError(
        -4,
        'mode switch requires other encoders to be stopped',
      )
    if (this.recording && this.recording.recorder !== recorder)
      throw new CameraError(-4, 'camera records a different recorder')
    if (
      (options.simulate !== undefined &&
        options.simulate !== (this.configuration.simulate ?? false)) ||
      (options.cameraIndex !== undefined &&
        (this.configuration.cameraId !== undefined ||
          options.cameraIndex !== (this.configuration.cameraIndex ?? 0))) ||
      (options.cameraId !== undefined && options.cameraId !== this.selectedId)
    )
      throw new CameraError(-1, 'mode must retain camera/backend')
    const target = copyConfiguration({
      ...options,
      simulate: this.configuration.simulate,
      cameraIndex: this.configuration.cameraIndex,
      cameraId: this.configuration.cameraId,
    })
    this.validateModeTuning(target)
    target.writable ??= this.configuration.writable
    target.transform ??= this.configuration.transform
      ? { ...this.configuration.transform }
      : undefined
    const encoded = cameraConfiguration(target),
      dropFrames = uint(jobOptions.dropFrames ?? 0)
    if (typeof output === 'string') guardHostPath(output)
    const exact =
      (settings.width !== undefined ? 1 : 0) |
      (settings.height !== undefined ? 2 : 0)
    const proposed = mergeSessionOptions(recorder.options, settings)
    const geometry = proposed.stream === 'lores' ? target.lores : target
    if (proposed.stream === 'lores' && (!geometry?.width || !geometry?.height))
      throw new CameraError(-8, 'target lores recording stream disabled')
    const candidate = resolvedSession(
      proposed,
      geometry?.width ?? proposed.width,
      geometry?.height ?? proposed.height,
      exact,
    )
    const audio = jobOptions.audio
    if (
      audio &&
      (!audio.handle ||
        !candidate.audio ||
        audio.sampleRate !== candidate.audio.sampleRate ||
        audio.channels !== candidate.audio.channels)
    )
      throw new RangeError('audio capture format differs from recorder session')
    if (audio)
      check(
        n.zc_audio_can_share(audio.handle),
        'candidate audio is already attached',
      )
    const effective = {
      ...jobOptions,
      timeoutMs: jobOptions.timeoutMs ?? 10000,
    }
    const deadline = Date.now() + effective.timeoutMs
    const initialRecording = this.recording
    let reservation: ReturnType<Recorder[typeof coordinateRecorder]> | undefined
    let claimed = false,
      released = false
    const release = () => {
      if (released) return
      released = true
      reservation?.release()
      if (this.coordinatedRecorder === recorder) {
        this.coordinatedRecorder = undefined
        this.coordinatedInitial = undefined
      }
      if (
        !this.closing &&
        !this.stopJob &&
        (this.previewActive || this.recording)
      )
        this.ensurePump()
    }
    const job = new BunJob<Recording>(
      async (current) => {
        claimed = true
        current.check()
        this.checkModeLeases()
        await this.settleFocus(focusPolicy, current)
        current.check()
        const previous = this.options,
          old = cameraConfiguration(previous)
        const started = this.started,
          previewConfig = this.previewConfiguration,
          controls = this.readModeControls(autofocus ? 2n : 0n)
        let response: ModeResponse | undefined,
          published = false,
          resumed: Recording | undefined
        let failure: unknown
        const preview = () => {
          if (
            previewConfig === undefined ||
            !this.handle ||
            this.closing ||
            this.stopJob
          )
            return
          this.openPreviewOwned(previewConfig)
        }
        let attachmentAttempted = false
        const attach = () => {
          if (resumed) return
          attachmentAttempted = true
          if (this.closing || this.stopJob || recorder.closing)
            throw new CameraError(
              -2,
              'capture stopped after session publication',
            )
          if (audio && !audio.handle)
            throw new CameraError(-2, 'audio closed after session publication')
          // Camera and media are published together; no user work can enter until
          // the reservation is released. Audio ownership transfers only here.
          recorder[recordingOwner](this, false, true)
          try {
            resumed = this.attachCoordinatedRecording(
              recorder,
              audio,
              initialRecording?.backpressure ?? 'wait',
            )
          } catch (error) {
            recorder[recordingOwner](this, true)
            throw error
          }
        }
        try {
          current.check()
          const stats = storage(40)
          check(n.zc_get_stats(this.handle, ptr(stats)))
          if (
            view(stats).getUint32(36, true) ||
            this.recording !== initialRecording ||
            this.recordings.size > (initialRecording ? 1 : 0)
          )
            throw new CameraError(
              -4,
              'mode requires unleased camera and stable recording',
            )
          this.modeActive = true
          if (this.timer !== undefined) {
            clearTimeout(this.timer)
            this.timer = undefined
          }
          // Admission may be full with the final copied frame. The coordinator
          // fences new producers while this job waits for that exact turn.
          while (initialRecording && this.producers.has(initialRecording)) {
            current.check()
            await new Promise<void>((resolve) => setTimeout(resolve, 1))
          }
          current.check()
          if (initialRecording?.error !== undefined)
            throw initialRecording.error
          const flush = initialRecording
            ? initialRecording[coordinatedFlush](reservation!.flush)
            : reservation!.flush()
          await flush
          current.check()
          this.stopPreviewOwned()
          response = await this.runOwnedMode({
            handle: this.handle,
            ...encoded,
            cameraId: this.selectedIdBytes,
            previousConfig: old.config,
            previousPipeline: old.pipeline,
            previousWritable: old.writable,
            previousOrientation: old.orientation,
            previousStrictOrientation: old.strictOrientation,
            previousMainFormat: old.mainFormat,
            previousProcessed: old.processed,
            previousStarted: started,
            ...controls,
            cancel: current.cancellation,
            deadline,
            dropFrames,
            autofocus,
          })
          this.handle = response.handle
          this.started = response.started
          this.checkRecordingModeResponse(response, current, deadline)
          const info = this.readRecordingInput(candidate)
          const media = resolvedSession(
            candidate,
            info.width,
            info.height,
            exact,
          )
          preview()
          current.check()
          const replacement = reservation!.restart(
            media,
            output,
            () => {
              published = true
              current.seal()
            },
            () => {
              current.check()
              if (this.closing || this.stopJob || recorder.closing)
                throw new CameraError(
                  -2,
                  'capture stopped before session publication',
                )
              if (audio && !audio.handle)
                throw new CameraError(
                  -2,
                  'audio closed before session publication',
                )
              if (audio)
                check(
                  n.zc_audio_can_share(audio.handle),
                  'candidate audio is already attached',
                )
            },
            () => {
              this.configuration = target
            },
          )
          current.setCancellationGuard(() => replacement.cancel())
          try {
            await replacement
          } catch (error) {
            if (
              replacement.cancelRequested &&
              error === replacement.cancellationReason
            )
              current.check()
            throw error
          }
          attach()
          return resumed!
        } catch (error) {
          failure = error
          if (error instanceof ModeWorkerFault) {
            this.handle = 0 as Pointer
            this.started = false
          }
          if (!published && response?.target && this.handle) {
            try {
              this.stopPreviewOwned()
              const restored = await this.runOwnedMode({
                handle: this.handle,
                ...old,
                cameraId: this.selectedIdBytes,
                previousConfig: encoded.config,
                previousPipeline: encoded.pipeline,
                previousWritable: encoded.writable,
                previousOrientation: encoded.orientation,
                previousStrictOrientation: encoded.strictOrientation,
                previousMainFormat: encoded.mainFormat,
                previousProcessed: encoded.processed,
                previousStarted: true,
                ...controls,
                controlRevision: response!.controlRevision,
                cancel: new SharedArrayBuffer(8),
                deadline: Infinity,
                dropFrames: 0,
              })
              this.handle = restored.handle
              this.started = restored.started
              this.configuration = restored.target ? previous : target
              check(
                restored.restoreCode || restored.code,
                'recording mode rollback',
              )
              if (!started && this.handle) {
                check(n.zc_stop(this.handle))
                this.started = false
              }
            } catch (restorationError) {
              if (restorationError instanceof ModeWorkerFault) {
                this.handle = 0 as Pointer
                this.started = false
              }
              if (failure && typeof failure === 'object')
                Object.assign(failure, { restorationError })
              else
                failure = new AggregateError(
                  [failure, restorationError],
                  'recording mode restoration failed',
                )
            }
          }
          if (!published && !this.previewActive) {
            try {
              preview()
            } catch (previewError) {
              if (failure && typeof failure === 'object')
                Object.assign(failure, { previewError })
              else
                failure = new AggregateError(
                  [failure, previewError],
                  'recording preview restoration failed',
                )
            }
          }
          if (
            published &&
            !attachmentAttempted &&
            !this.closing &&
            !this.stopJob &&
            !recorder.closing
          ) {
            attach()
            if (failure && typeof failure === 'object')
              Object.assign(failure, { recording: resumed })
          }
          throw failure
        } finally {
          current.setCancellationGuard(undefined)
          this.modeActive = false
          release()
        }
      },
      () => {
        this.modeJobs.delete(job)
        if (!claimed) release()
      },
      effective,
    )
    try {
      reservation = recorder[coordinateRecorder](job, this)
    } catch (error) {
      job.cancel(error)
      throw error
    }
    this.coordinatedRecorder = recorder
    this.coordinatedInitial = initialRecording
    if (this.focusJobs) this.ensurePump()
    void job.operationDone.then(release)
    this.modeJobs.add(job)
    this.modeTail = this.modeTail.then(() => job.start()).catch(() => {})
    return job
  }

  private checkRecordingModeResponse(
    response: ModeResponse,
    current: Pick<BunJob<unknown>, 'check' | 'cancel' | 'cancelRequested'>,
    deadline: number,
  ) {
    if (response.callbackError !== undefined)
      throw Object.assign(response.callbackError as object, {
        restoreCode: response.restoreCode,
        controlCode: response.controlCode,
        restoreControlCode: response.restoreControlCode,
      })
    if (
      response.autofocusState !== undefined &&
      response.code &&
      response.code !== -5 &&
      !response.restoreCode &&
      !current.cancelRequested
    )
      throw Object.assign(cameraError(response.code, 'target autofocus'), {
        autofocusState: response.autofocusState,
      })
    if (response.controlCode && !response.restoreCode)
      throw Object.assign(
        cameraError(
          response.code || response.controlCode,
          'runtime control restoration',
        ),
        { controlCode: response.controlCode },
      )
    if (Date.now() >= deadline && !current.cancelRequested)
      current.cancel(new CameraError(-3, 'mode deadline'))
    if (response.restoreCode)
      throw Object.assign(
        cameraError(response.code || response.restoreCode, 'mode restoration'),
        {
          restoreCode: response.restoreCode,
          controlCode: response.controlCode,
          restoreControlCode: response.restoreControlCode,
        },
      )
    if (response.code === -5 && current.cancelRequested) current.check()
    check(response.code, 'recording camera mode')
    current.check()
  }
  /** Switch every active encoder under one camera/media publication decision. */
  switchRecordingsModeAsync(
    options: CameraOptions,
    members: readonly RecordingModeMember[],
    jobOptions: ModeJobOptions<readonly Recording[]> = {},
  ): BunJob<readonly Recording[]> {
    guardRequestCallback()
    this.assertOpen()
    this.ensureConnected()
    cameraIdentity(options)
    const focusPolicy = this.modeFocusPolicy(jobOptions),
      autofocus = jobOptions.autofocus ?? false
    const effective = snapshotJobOptions(jobOptions, 10000),
      deadline = Date.now() + effective.timeoutMs!
    const dropFrames = uint(jobOptions.dropFrames ?? 0)
    const count = uint(members.length, 8)
    if (!count) throw new RangeError('recording group requires active members')
    if (
      (options.simulate !== undefined &&
        options.simulate !== (this.configuration.simulate ?? false)) ||
      (options.cameraIndex !== undefined &&
        (this.configuration.cameraId !== undefined ||
          options.cameraIndex !== (this.configuration.cameraIndex ?? 0))) ||
      (options.cameraId !== undefined && options.cameraId !== this.selectedId)
    )
      throw new CameraError(-1, 'mode must retain camera/backend')
    const target = copyConfiguration({
      ...options,
      simulate: this.configuration.simulate,
      cameraIndex: this.configuration.cameraIndex,
      cameraId: this.configuration.cameraId,
    })
    this.validateModeTuning(target)
    target.writable ??= this.configuration.writable
    target.transform ??= this.configuration.transform
      ? { ...this.configuration.transform }
      : undefined
    const encoded = cameraConfiguration(target)
    const plans = Array.from({ length: count }, (_, index) => {
      const member = members[index],
        recording = member.recording,
        settings = member.settings ?? {},
        output = member.output ?? null
      const recorder = recording.recorder,
        proposed = mergeSessionOptions(recorder.options, settings)
      const exact =
        (settings.width !== undefined ? 1 : 0) |
        (settings.height !== undefined ? 2 : 0)
      const geometry = proposed.stream === 'lores' ? target.lores : target
      if (
        proposed.stream === 'lores' &&
        (!geometry?.width || !geometry?.height)
      )
        throw new CameraError(-8, 'target lores recording stream disabled')
      const candidate = resolvedSession(
        proposed,
        geometry?.width ?? proposed.width,
        geometry?.height ?? proposed.height,
        exact,
      )
      const requestedAudio = member.audio
      const audio =
        requestedAudio === undefined
          ? candidate.audio
            ? this.recordingAudio.get(recording)
            : undefined
          : (requestedAudio ?? undefined)
      const backpressure = member.backpressure ?? recording.backpressure
      if (backpressure !== 'wait' && backpressure !== 'drop')
        throw new RangeError('invalid recording backpressure')
      if (
        audio &&
        (!audio.handle ||
          !candidate.audio ||
          audio.sampleRate !== candidate.audio.sampleRate ||
          audio.channels !== candidate.audio.channels)
      )
        throw new RangeError(
          'audio capture format differs from recorder session',
        )
      if (typeof output === 'string') {
        if (
          !output.length ||
          output.length > 4096 ||
          cstring(output).length > 4097
        )
          throw new RangeError('recording output path length')
        guardHostPath(output)
      }
      return {
        recording,
        recorder,
        candidate,
        exact,
        output,
        audio,
        backpressure,
      }
    })
    // All application accessors have run; reserve only this exact active set.
    this.assertOpen()
    if (
      this.hasPendingModes() ||
      this.requests.length ||
      this.focusCaptureActive ||
      this.failedRecordings.size ||
      this.producers.size >
        [...this.recordings].filter((r) => this.producers.has(r)).length
    )
      throw new CameraError(-4, 'camera jobs active')
    if (this.modeJobs.size >= 32) throw new CameraError(-4, 'mode queue')
    const initials = [...this.recordings]
    if (
      plans.length !== initials.length ||
      new Set(plans.map((p) => p.recording)).size !== plans.length ||
      plans.some((p) => !this.recordings.has(p.recording))
    )
      throw new CameraError(
        -4,
        'group must include every active recording exactly once',
      )
    const cadences = new Map<AudioCapture, number>()
    for (const plan of plans)
      if (plan.audio) {
        const fps = plan.candidate.fps ?? 30,
          previous = cadences.get(plan.audio)
        if (previous !== undefined && previous !== fps)
          throw new RangeError('shared audio requires the same recording FPS')
        cadences.set(plan.audio, fps)
      }
    const context = { recorders: plans.map((p) => p.recorder), initials }
    const reservations: ReturnType<Recorder[typeof coordinateRecorder]>[] = []
    const holds: { source: AudioCapture; group: SharedAudio; id: bigint }[] = []
    let claimed = false,
      released = false
    const release = () => {
      if (released) return
      released = true
      for (const reservation of reservations) reservation.release()
      for (const hold of holds) {
        hold.group.releaseHold(hold.id)
        this.closeIdleAudio(hold.source, hold.group, true)
      }
      if (this.coordinatedGroup === context) this.coordinatedGroup = undefined
      if (
        !this.closing &&
        !this.stopJob &&
        (this.previewActive || this.recordings.size)
      )
        this.ensurePump()
    }
    const job = new BunJob<readonly Recording[]>(
      async (current) => {
        claimed = true
        let response: ModeResponse | undefined, group: RestartGroup | undefined
        const children: BunJob<void>[] = []
        const prepared: ReturnType<Camera['prepareGroupRecording']>[] = []
        let installed = false,
          failure: unknown
        const abortChildren = () => {
          group?.abort(current.cancellationReason)
          for (const child of children) child.cancel(current.cancellationReason)
        }
        current.check()
        this.checkModeLeases()
        await this.settleFocus(focusPolicy, current)
        current.check()
        const previous = this.options,
          old = cameraConfiguration(previous),
          started = this.started,
          previewConfig = this.previewConfiguration,
          controls = this.readModeControls(autofocus ? 2n : 0n)
        const preview = () => {
          if (
            previewConfig === undefined ||
            !this.handle ||
            this.closing ||
            this.stopJob
          )
            return
          this.openPreviewOwned(previewConfig)
        }
        current.signal.addEventListener('abort', abortChildren, { once: true })
        try {
          if (
            initials.length !== this.recordings.size ||
            initials.some((r) => !this.recordings.has(r))
          )
            throw new CameraError(-4, 'recording group changed before claim')
          this.modeActive = true
          if (this.timer !== undefined) {
            clearTimeout(this.timer)
            this.timer = undefined
          }
          while (
            initials.some((r) => this.producers.has(r)) ||
            reservations.some((r) => r.pending())
          ) {
            current.check()
            await pause()
          }
          current.check()
          const producerError = initials.find(
            (r) => r.error !== undefined,
          )?.error
          if (producerError !== undefined) throw producerError
          if (
            initials.length !== this.recordings.size ||
            initials.some((r) => !this.recordings.has(r))
          )
            throw new CameraError(-4, 'recording group changed before flush')
          const flushes: BunJob<void>[] = []
          // Reserve all flush jobs before detaching any old capture owner.
          try {
            for (const reservation of reservations)
              flushes.push(reservation.flush())
          } catch (error) {
            for (const flush of flushes) flush.cancel(error)
            await Promise.allSettled(flushes)
            throw error
          }
          for (let i = 0; i < plans.length; i++)
            plans[i].recording[adoptCoordinatedFlush](flushes[i])
          const flushed = await Promise.allSettled(flushes)
          const flushFailure = flushed.find((r) => r.status === 'rejected')
          if (flushFailure?.status === 'rejected') throw flushFailure.reason
          current.check()
          this.stopPreviewOwned()
          response = await this.runOwnedMode({
            handle: this.handle,
            ...encoded,
            cameraId: this.selectedIdBytes,
            previousConfig: old.config,
            previousPipeline: old.pipeline,
            previousWritable: old.writable,
            previousOrientation: old.orientation,
            previousStrictOrientation: old.strictOrientation,
            previousMainFormat: old.mainFormat,
            previousProcessed: old.processed,
            previousStarted: started,
            ...controls,
            cancel: current.cancellation,
            deadline,
            dropFrames,
            autofocus,
          })
          this.handle = response.handle
          this.started = response.started
          this.checkRecordingModeResponse(response, current, deadline)
          const media = plans.map((plan) => {
            const info = this.readRecordingInput(plan.candidate)
            return resolvedSession(
              plan.candidate,
              info.width,
              info.height,
              plan.exact,
            )
          })
          preview()
          current.check()
          group = new RestartGroup(plans.length, () => {
            this.configuration = target
          })
          for (let i = 0; i < plans.length; i++) {
            const plan = plans[i]
            const child = reservations[i].restart(
              media[i],
              plan.output,
              () => {},
              () => {},
              () => {},
              { group, index: i },
            )
            children.push(child)
            void Promise.resolve(child).catch((error) => {
              group!.failed(i, error)
              if (!group!.published)
                for (const peer of children)
                  if (peer !== child) peer.cancel(error)
            })
          }
          await group.ready
          current.check()
          if (
            this.closing ||
            this.stopJob ||
            plans.some((p) => p.recorder.closing)
          )
            throw new CameraError(
              -2,
              'recording group stopped before publication',
            )
          // Reserve all capture/audio owners before the native shared decision.
          for (const [source, fps] of cadences) {
            if (!source.handle)
              throw new CameraError(-2, 'audio closed before group publication')
            const audioGroup = this.audioGroups.get(source)
            if (audioGroup) audioGroup.reconfigure(fps)
          }
          for (let i = 0; i < plans.length; i++)
            prepared.push(
              this.prepareGroupRecording(
                plans[i].recorder,
                plans[i].audio,
                media[i].fps ?? 30,
                plans[i].backpressure,
              ),
            )
          current.check()
          group.publish(() => current.seal())
          const results = await Promise.allSettled(children)
          for (const result of results)
            if (result.status === 'rejected') failure ??= result.reason
          failure ??= group.error
          if (
            this.closing ||
            this.stopJob ||
            plans.some((p) => p.recorder.closing)
          )
            throw new CameraError(
              -2,
              'recording group stopped after publication',
            )
          for (const value of prepared) value.install()
          installed = true
          const recordings = Object.freeze(prepared.map((p) => p.recording))
          if (failure !== undefined)
            throw Object.assign(
              failure instanceof Error
                ? failure
                : new Error('recording group retirement failed', {
                    cause: failure,
                  }),
              { published: true, recordings },
            )
          return recordings
        } catch (error) {
          failure = error
          group?.abort(error)
          if (!group?.published)
            for (const child of children) child.cancel(error)
          const settled = await Promise.allSettled(children)
          for (const result of settled)
            if (
              result.status === 'rejected' &&
              result.reason !== current.cancellationReason &&
              failure === current.cancellationReason
            )
              failure = result.reason
          if (error instanceof ModeWorkerFault) {
            this.handle = 0 as Pointer
            this.started = false
          }
          if (!group?.published && response?.target && this.handle) {
            try {
              this.stopPreviewOwned()
              const restored = await this.runOwnedMode({
                handle: this.handle,
                ...old,
                cameraId: this.selectedIdBytes,
                previousConfig: encoded.config,
                previousPipeline: encoded.pipeline,
                previousWritable: encoded.writable,
                previousOrientation: encoded.orientation,
                previousStrictOrientation: encoded.strictOrientation,
                previousMainFormat: encoded.mainFormat,
                previousProcessed: encoded.processed,
                previousStarted: true,
                ...controls,
                controlRevision: response.controlRevision,
                cancel: new SharedArrayBuffer(8),
                deadline: Infinity,
                dropFrames: 0,
              })
              this.handle = restored.handle
              this.started = restored.started
              this.configuration = restored.target ? previous : target
              check(
                restored.restoreCode || restored.code,
                'recording group camera rollback',
              )
              if (!started && this.handle) {
                check(n.zc_stop(this.handle))
                this.started = false
              }
            } catch (restorationError) {
              if (restorationError instanceof ModeWorkerFault) {
                this.handle = 0 as Pointer
                this.started = false
              }
              failure = new AggregateError(
                [failure, restorationError],
                'recording group camera restoration failed',
              )
            }
          }
          if (!group?.published && !this.previewActive) {
            try {
              preview()
            } catch (previewError) {
              failure = new AggregateError(
                [failure, previewError],
                'recording group preview restoration failed',
              )
            }
          }
          // All native decisions are new after publication, including stop-hook errors.
          if (
            group?.published &&
            !installed &&
            !this.closing &&
            !this.stopJob &&
            !plans.some((p) => p.recorder.closing)
          ) {
            for (const value of prepared) value.install()
            installed = true
          }
          if (group?.published && failure && typeof failure === 'object')
            Object.assign(failure, {
              published: true,
              recordings: Object.freeze(
                installed ? prepared.map((p) => p.recording) : [],
              ),
            })
          throw failure
        } finally {
          current.signal.removeEventListener('abort', abortChildren)
          if (!installed)
            for (const value of prepared) value.discard(!!group?.published)
          this.modeActive = false
          release()
        }
      },
      () => {
        this.modeJobs.delete(job)
        if (!claimed) release()
      },
      effective,
    )
    try {
      for (const plan of plans)
        reservations.push(plan.recorder[coordinateRecorder](job, this))
      for (const source of new Set(
        initials
          .map((r) => this.recordingAudio.get(r))
          .filter((s): s is AudioCapture => !!s),
      )) {
        const group = this.audioGroups.get(source)!
        holds.push({ source, group, id: group.hold() })
      }
      this.assertOpen()
    } catch (error) {
      job.cancel(error)
      release()
      throw error
    }
    this.coordinatedGroup = context
    this.modeJobs.add(job)
    void job.operationDone.then(release)
    if (this.focusJobs) this.ensurePump()
    this.modeTail = this.modeTail.then(() => job.start()).catch(() => {})
    return job
  }

  switchMode(
    options: CameraOptions,
    jobOptions: ModeJobOptions<ReturnType<Camera['info']>> = {},
  ) {
    return this.submitMode(options, undefined, jobOptions) as BunJob<
      ReturnType<Camera['info']>
    >
  }
  switchModeAndDropFrames(
    options: CameraOptions,
    dropFrames: number,
    jobOptions: ModeJobOptions<ReturnType<Camera['info']>> = {},
  ) {
    return this.switchMode(options, { ...jobOptions, dropFrames })
  }
  switchModeAndCaptureRGB(
    options: CameraOptions,
    jobOptions: ModeJobOptions<Uint8Array> & { stream?: 'main' | 'lores' } = {},
  ) {
    const stream = imageStreamId(processedImageStream(jobOptions.stream))
    return this.submitMode(
      options,
      { kind: 'rgb', stream },
      jobOptions,
    ) as BunJob<Uint8Array>
  }
  switchModeAndCaptureImage(
    options: CameraOptions,
    jobOptions: ModeJobOptions<CapturedImage> & CaptureImageOptions = {},
  ) {
    const imageSettings = snapshotCaptureImageOptions(jobOptions)
    return this.submitMode(options, { kind: 'image', imageSettings }, jobOptions) as BunJob<CapturedImage>
  }
  switchModeAndCaptureMetadata(
    options: CameraOptions,
    jobOptions: ModeJobOptions<ReturnType<Frame['metadata']>> = {},
  ) {
    return this.submitMode(options, { kind: 'metadata' }, jobOptions) as BunJob<
      ReturnType<Frame['metadata']>
    >
  }
  switchModeAndCaptureBuffer(
    options: CameraOptions,
    stream: 'main' | 'raw' | 'lores' = 'main',
    jobOptions: ModeJobOptions<{
      width: number
      height: number
      format: string
      data: Uint8Array
    }> = {},
  ) {
    return this.submitMode(
      options,
      { kind: 'stream', stream: { main: 0, raw: 1, lores: 2 }[stream] },
      jobOptions,
    ) as BunJob<{
      width: number
      height: number
      format: string
      data: Uint8Array
    }>
  }
  switchModeCaptureRequestAndStop(
    options: CameraOptions,
    jobOptions: ModeJobOptions<Frame> = {},
  ) {
    return this.submitMode(
      options,
      { kind: 'request-stop' },
      jobOptions,
    ) as BunJob<Frame>
  }
  switchModeAndCaptureStreams(
    options: CameraOptions,
    streams: readonly StreamName[] = ['main'],
    jobOptions: ModeJobOptions<CapturedStreams> = {},
  ) {
    const names = streamNames(streams)
    return this.submitMode(
      options,
      { kind: 'streams', streams: names },
      jobOptions,
    ) as BunJob<CapturedStreams>
  }
  switchModeAndCaptureFile(
    options: CameraOptions,
    path: string,
    jobOptions: ModeJobOptions<ReturnType<Frame['metadata']>> &
      ImageOptions = {},
  ) {
    const prepared = prepareImage(jobOptions, path)
    return this.submitMode(
      prepared.format === 6
        ? {
            ...options,
            raw: true,
            unpackedRaw: options.unpackedRaw ?? options.rawFormat === undefined,
          }
        : options,
      {
        kind: 'file',
        path: prepared.path,
        imageOptions: prepared.options,
        imageProfile: prepared.profile,
        imageExif: prepared.exif,
        stream: prepared.stream,
      },
      jobOptions,
    ) as BunJob<ReturnType<Frame['metadata']>>
  }
  switchModeAndCaptureEncodedImage(
    options: CameraOptions,
    jobOptions: ModeJobOptions<Uint8Array> & ImageOptions = {},
  ) {
    const prepared = prepareImage(jobOptions)
    return this.submitMode(
      prepared.format === 6
        ? {
            ...options,
            raw: true,
            unpackedRaw: options.unpackedRaw ?? options.rawFormat === undefined,
          }
        : options,
      {
        kind: 'encoded',
        imageOptions: prepared.options,
        imageProfile: prepared.profile,
        imageExif: prepared.exif,
        stream: prepared.stream,
      },
      jobOptions,
    ) as BunJob<Uint8Array>
  }
  private validateModeTuning(target: CameraOptions) {
    if (
      target.tuning !== undefined &&
      target.tuning !== this.configuration.tuning
    )
      throw new CameraError(-1, 'mode must retain manager tuning')
    target.tuning = this.configuration.tuning
  }
  private validateModeIdentity(options: CameraOptions) {
    if (
      (options.simulate !== undefined &&
        options.simulate !== (this.configuration.simulate ?? false)) ||
      (options.cameraIndex !== undefined &&
        (this.configuration.cameraId !== undefined ||
          options.cameraIndex !== (this.configuration.cameraIndex ?? 0))) ||
      (options.cameraId !== undefined && options.cameraId !== this.selectedId)
    )
      throw new CameraError(-1, 'mode must retain camera/backend')
  }
  private checkModeAdmission(owner?: object) {
    this.ensureConnected()
    if (
      this.pngCaptureJob &&
      !this.pngCaptureJob.done &&
      owner !== this.pngCaptureJob
    )
      throw new CameraError(-4, 'APNG capture active')
    if (
      this.captureFilesJob &&
      !this.captureFilesJob.done &&
      owner !== this.captureFilesJob
    )
      throw new CameraError(-4, 'capture series active')
    if (!this.handle || this.closing || this.stopJob)
      throw new CameraError(-2, 'camera unavailable')
    if (this.modeJobs.size + this.requests.length >= 32)
      throw new CameraError(-4, 'mode queue')
    if (
      this.coordinatedRecorder ||
      this.coordinatedGroup ||
      this.recording ||
      this.failedRecordings.size ||
      this.focusCaptureActive ||
      this.requests.length
    )
      throw new CameraError(-4, 'camera jobs active')
  }
  private submitMode<T>(
    options: CameraOptions,
    capture: ModeRequest['capture'],
    jobOptions: ModeJobOptions<T>,
    owner?: object,
    resumePreview = true,
  ) {
    guardRequestCallback()
    guardOutputHook()
    cameraIdentity(options)
    const focusPolicy = this.modeFocusPolicy(jobOptions)
    const autofocus = jobOptions.autofocus ?? false
    this.checkModeAdmission(owner)
    const target = copyConfiguration({
      ...options,
      simulate: this.configuration.simulate,
      cameraIndex: this.configuration.cameraIndex,
      cameraId: this.configuration.cameraId,
    })
    this.validateModeTuning(target)
    target.writable ??= this.configuration.writable
    target.transform ??= this.configuration.transform
      ? { ...this.configuration.transform }
      : undefined
    this.validateModeIdentity(options)
    const encoded = cameraConfiguration(target),
      dropFrames = uint(jobOptions.dropFrames ?? 0)
    const effective = snapshotJobOptions(jobOptions, 5000)
    const deadline = Date.now() + (effective.timeoutMs ?? 5000)
    this.checkModeAdmission(owner)
    const job = new BunJob<T>(
      (current) =>
        withStagedImageFile(
          capture?.kind === 'file' ? capture.path : undefined,
          current,
          async (file) => {
            current.check()
            this.assertOpen()
            this.checkModeLeases()
            await this.settleFocus(focusPolicy, current)
            current.check()
            this.assertOpen()
            const stats = storage(40)
            check(n.zc_get_stats(this.handle, ptr(stats)))
            if (
              view(stats).getUint32(36, true) ||
              this.recording ||
              this.requests.length
            )
              throw new CameraError(-4, 'mode requires unleased idle camera')
            const previous = this.options,
              old = cameraConfiguration(previous),
              started = this.started,
              previewConfig = this.previewConfiguration,
              controls = this.readModeControls(autofocus ? 2n : 0n)
            this.modeActive = true
            if (this.timer !== undefined) {
              clearTimeout(this.timer)
              this.timer = undefined
            }
            let response: ModeResponse | undefined
            let retainedRequest: Frame | undefined
            let value: unknown
            let failure: unknown
            const preview = () => {
              if (
                previewConfig === undefined ||
                !this.handle ||
                this.closing ||
                this.stopJob
              )
                return
              this.openPreviewOwned(previewConfig)
            }
            try {
              this.stopPreviewOwned()
              response = await this.runOwnedMode({
                handle: this.handle,
                ...encoded,
                cameraId: this.selectedIdBytes,
                previousConfig: old.config,
                previousPipeline: old.pipeline,
                previousWritable: old.writable,
                previousOrientation: old.orientation,
                previousStrictOrientation: old.strictOrientation,
                previousMainFormat: old.mainFormat,
                previousProcessed: old.processed,
                previousStarted: started,
                ...controls,
                cancel: current.cancellation,
                deadline,
                capture: file
                  ? { ...capture!, fileOutput: file.handle }
                  : capture,
                dropFrames,
                autofocus,
              })
              this.handle = response.handle
              this.started = response.started
              if (response.requestFrame)
                retainedRequest = new Frame(this, response.requestFrame)
              if (response.callbackError !== undefined)
                throw Object.assign(response.callbackError as object, {
                  restoreCode: response.restoreCode,
                  controlCode: response.controlCode,
                  restoreControlCode: response.restoreControlCode,
                  requestCleanupCode: response.requestCleanupCode,
                })
              if (
                response.autofocusState !== undefined &&
                response.code &&
                response.code !== -5 &&
                !response.restoreCode &&
                !current.cancelRequested
              )
                throw Object.assign(
                  cameraError(response.code, 'target autofocus'),
                  { autofocusState: response.autofocusState },
                )
              if (response.controlCode && !response.restoreCode)
                throw Object.assign(
                  cameraError(
                    response.code || response.controlCode,
                    'runtime control restoration',
                  ),
                  { controlCode: response.controlCode },
                )
              if (Date.now() >= deadline && !current.cancelRequested)
                current.cancel(new CameraError(-3, 'mode deadline'))
              if (response.restoreCode) {
                const error = cameraError(
                  response.code || response.restoreCode,
                  'mode restoration',
                ) as CameraError & { restoreCode: number }
                error.restoreCode = response.restoreCode
                Object.assign(error, {
                  controlCode: response.controlCode,
                  restoreControlCode: response.restoreControlCode,
                  requestCleanupCode: response.requestCleanupCode,
                })
                throw error
              }
              if (response.requestCleanupCode)
                throw Object.assign(
                  new CameraError(
                    response.code || response.requestCleanupCode,
                    'request handoff cleanup',
                  ),
                  {
                    requestCleanupCode: response.requestCleanupCode,
                    cancellationReason: current.cancelRequested
                      ? current.cancellationReason
                      : undefined,
                  },
                )
              if (response.code === -5 && current.cancelRequested)
                current.check()
              check(response.code, 'mode switch')
              current.check()
              this.configuration = response.target ? target : previous
              if (capture) {
                value = response.value
                if (capture.kind === 'request-stop') {
                  if (!retainedRequest || !response.target || response.started)
                    throw new CameraError(-6, 'invalid stopped request handoff')
                  value = retainedRequest
                }
                if (capture.kind === 'metadata' || capture.kind === 'file')
                  value = decodeMetadata(response.value!)
                if (capture.kind === 'streams') {
                  if (!response.bundle)
                    throw new CameraError(-6, 'missing stream bundle')
                  value = response.bundle
                }
                if (capture.kind === 'stream')
                  value = { ...response.stream!, data: response.value! }
              }
              if (capture?.kind === 'request-stop') {
                this.clearPreviewOwned()
                current.seal()
                retainedRequest = undefined // the published Frame now owns release
              } else if (resumePreview) preview()
              // Synchronous preview work may outlast the timer callback.
              // Fail inside this scope so permanent modes roll back as well.
              if (Date.now() >= deadline && !current.cancelRequested)
                current.cancel(new CameraError(-3, 'mode deadline'))
              current.check()
            } catch (error) {
              failure = error
              if (retainedRequest) {
                try {
                  retainedRequest.release()
                } catch (cleanupError) {
                  failure = Object.assign(
                    new AggregateError(
                      [error, cleanupError],
                      'request handoff and cleanup failed',
                    ),
                    {
                      requestCleanup: retainedRequest.token
                        ? retainedRequest
                        : undefined,
                    },
                  )
                }
              }
              if (error instanceof ModeWorkerFault) {
                this.handle = 0 as Pointer
                this.started = false
              }
              if (response?.target && this.handle) {
                try {
                  this.stopPreviewOwned()
                  const restored = await this.runOwnedMode({
                    handle: this.handle,
                    ...old,
                    cameraId: this.selectedIdBytes,
                    previousConfig: encoded.config,
                    previousPipeline: encoded.pipeline,
                    previousWritable: encoded.writable,
                    previousOrientation: encoded.orientation,
                    previousStrictOrientation: encoded.strictOrientation,
                    previousMainFormat: encoded.mainFormat,
                    previousProcessed: encoded.processed,
                    previousStarted: true,
                    ...controls,
                    controlRevision: response!.controlRevision,
                    cancel: new SharedArrayBuffer(8),
                    deadline: Infinity,
                    dropFrames: 0,
                  })
                  this.handle = restored.handle
                  this.started = restored.started
                  this.configuration = restored.target ? previous : target
                  check(restored.restoreCode || restored.code, 'mode rollback')
                  if (!started && this.handle) {
                    check(n.zc_stop(this.handle))
                    this.started = false
                  }
                } catch (restorationError) {
                  if (restorationError instanceof ModeWorkerFault) {
                    this.handle = 0 as Pointer
                    this.started = false
                  }
                  if (failure && typeof failure === 'object')
                    Object.assign(failure, { restorationError })
                  else
                    failure = new AggregateError(
                      [failure, restorationError],
                      'mode and restoration failed',
                    )
                }
              }
              if (!this.previewActive) {
                try {
                  preview()
                } catch (restorationError) {
                  if (failure && typeof failure === 'object')
                    Object.assign(failure, { previewError: restorationError })
                }
              }
            } finally {
              this.modeActive = false
              if (
                this.previewActive ||
                (this.started && this.hasRequestCallbacks)
              )
                this.ensurePump()
            }
            if (failure !== undefined) throw failure
            if (!capture) value = this.info()
            if (file) await file.publish(current, deadline)
            current.check()
            if (capture?.kind === 'image') {
              if (!response?.image) throw new CameraError(-6, 'missing owned image')
              value = adoptImageSnapshot(response.image)
            }
            try {
              current.seal()
            } catch (error) {
              if (value instanceof CapturedImage) value.close()
              throw error
            }
            return value as T
          },
        ),
      () => this.modeJobs.delete(job),
      effective,
    )
    this.modeJobs.add(job)
    if (owner && owner === this.captureFilesJob) void job.start()
    else this.modeTail = this.modeTail.then(() => job.start()).catch(() => {})
    return job
  }
  private hasPendingModes(owner?: object) {
    return [...this.modeJobs].some((job) => !job.done && job !== owner)
  }
  private async cancelModes() {
    const jobs = [...this.modeJobs, ...this.imageFileJobs]
    if (this.reconnectJob && !this.reconnectJob.done)
      jobs.push(this.reconnectJob)
    for (const job of jobs) job.cancel(new CameraError(-2, 'camera stopped'))
    await Promise.all(jobs.map((job) => job.operationDone))
  }

  private prepareGroupRecording(
    recorder: Recorder,
    audio: AudioCapture | undefined,
    fps: number,
    backpressure: RecordingBackpressure,
  ) {
    const fanout = (this.fanout ??= new FrameFanout()),
      id = fanout.add(backpressure)
    let binding: ReturnType<Camera['reserveAudio']> | undefined,
      owned = false,
      installed = false,
      discarded = false
    try {
      recorder[recordingOwner](this, false, true)
      owned = true
      if (audio) {
        if (!audio.handle)
          throw new CameraError(-2, 'audio closed before group publication')
        binding = this.reserveAudio(audio, fps)
      }
      const recording = new Recording(this, recorder, audio, fps, backpressure)
      recording[consumerState] = fanout.state(id)
      return {
        recording,
        install: () => {
          if (installed || discarded) return
          installed = true
          this.recordingIds.set(recording, id)
          if (audio) this.recordingAudio.set(recording, audio)
          if (binding) this.audioBindings.set(recording, binding)
          this.recordings.add(recording)
        },
        discard: (closeSource: boolean) => {
          if (installed || discarded) return
          discarded = true
          recording[consumerState] = fanout.retire(id)
          if (binding)
            recording[audioState] = this.releaseAudio(binding, closeSource)
          recorder[recordingOwner](this, true)
        },
      }
    } catch (error) {
      fanout.retire(id)
      if (binding) this.releaseAudio(binding, false)
      if (owned) recorder[recordingOwner](this, true)
      throw error
    }
  }
  private closeIdleAudio(
    source: AudioCapture,
    group: SharedAudio,
    closeSource: boolean,
  ) {
    if (!group.count && !group.holds) {
      group.close()
      this.audioGroups.delete(source)
      if (closeSource) source.close()
    }
  }
  private reserveAudio(source: AudioCapture, fps: number) {
    let group = this.audioGroups.get(source)
    if (group && group.fps !== fps)
      throw new RangeError('shared audio requires the same recording FPS')
    const fresh = !group
    group ??= new SharedAudio(
      source.handle,
      source.sharedBufferFrames,
      source.sharedMaxBlocks,
      fps,
    )
    try {
      const id = group.add()
      this.audioGroups.set(source, group)
      source[audioGroupView] = group
      return { group, id, source }
    } catch (error) {
      if (fresh) group.close()
      throw error
    }
  }
  private releaseAudio(
    binding: { group: SharedAudio; id: bigint; source: AudioCapture },
    closeSource: boolean,
  ) {
    const { group, id, source } = binding
    const final = group.retire(id)
    this.closeIdleAudio(source, group, closeSource)
    return final
  }
  [recordingAudioState](recording: Recording): AudioConsumerStats | undefined {
    const binding = this.audioBindings.get(recording)
    if (binding) recording[audioState] = binding.group.state(binding.id)
    const value = recording[audioState]
    return value && { ...value }
  }
  [recordingTimestamp](
    recording: Recording,
    offered: bigint | undefined,
    fallback: bigint,
  ) {
    const binding = this.audioBindings.get(recording)
    return binding && offered !== undefined
      ? binding.group.timestamp(
          offered,
          fallback,
          this.readInfo().backend === 0,
        )
      : fallback
  }
  [prepareRecordingAudio](
    recording: Recording,
    timestamp: bigint,
    manual: boolean,
  ) {
    const binding = this.audioBindings.get(recording)
    if (!binding) return
    if (manual) binding.group.fill(timestamp)
    const batch = binding.group.prepare(binding.id, timestamp)
    return {
      ...batch,
      finish: (accepted: boolean) => {
        recording[audioState] = binding.group.finish(
          binding.id,
          batch.ticket,
          accepted,
        )
      },
    }
  }
  private fillRecordingAudio(frame: Frame, offered: bigint) {
    for (const [source, group] of this.audioGroups) {
      const consumers = [...this.recordings].filter(
        (r) => this.recordingAudio.get(r) === source,
      )
      if (!consumers.length) continue
      try {
        group.fill(
          group.timestamp(
            offered,
            frame.timestampNs,
            this.readInfo().backend === 0,
          ),
        )
      } catch (error) {
        for (const consumer of consumers) this.failRecording(consumer, error)
        continue
      }
      for (const consumer of consumers) {
        try {
          group.check(this.audioBindings.get(consumer)!.id)
        } catch (error) {
          this.failRecording(consumer, error)
        }
      }
    }
  }
  recordingState(recording: Recording): CaptureConsumerStats {
    const id = this.recordingIds.get(recording)
    if (id !== undefined) recording[consumerState] = this.fanout!.state(id)
    return { ...recording[consumerState]! }
  }
  pendingRecording(recording: Recording) {
    return this.producers.get(recording) ?? Promise.resolve()
  }
  detach(recording: Recording) {
    const id = this.recordingIds.get(recording)
    this.recordings.delete(recording)
    this.failedRecordings.delete(recording)
    this.recordingAudio.delete(recording)
    const binding = this.audioBindings.get(recording)
    if (binding) {
      recording[audioState] = this.releaseAudio(binding, true)
      this.audioBindings.delete(recording)
    }
    if (id !== undefined) {
      recording[consumerState] = this.fanout!.retire(id)
      this.recordingIds.delete(recording)
      recording.recorder[recordingOwner](this, true)
      if (!this.closing && !this.stopJob && this.handle) this.ensurePump()
    }
  }
  private failRecording(recording: Recording, error: unknown) {
    recording.error ??= error
    this.recordings.delete(recording)
    const id = this.recordingIds.get(recording)
    if (id !== undefined) {
      recording[consumerState] = this.fanout!.fail(id)
      this.failedRecordings.add(recording)
    }
  }
  private failRecordings(error: unknown) {
    for (const recording of [...this.recordings])
      this.failRecording(recording, error)
  }
  private completeRecording(
    recording: Recording,
    id: bigint,
    ticket: bigint,
    error?: unknown,
  ) {
    const cancelled =
      recording.closing && error instanceof CameraError && error.code === -2
    try {
      recording[consumerState] = this.fanout!.finish(
        id,
        ticket,
        error === undefined ? 0 : cancelled ? 2 : 1,
      )
    } catch (cleanupError) {
      error =
        error === undefined
          ? cleanupError
          : new AggregateError(
              [error, cleanupError],
              'encoder claim cleanup failed',
            )
    }
    if (error !== undefined && !cancelled) this.failRecording(recording, error)
  }
  private ensurePump() {
    if (this.lastDeviceError || this.sessionRecoveryActive) return
    if (
      this.timer === undefined &&
      !this.pumping &&
      (!this.fanout || this.fanout.ready())
    )
      this.timer = setTimeout(() => this.pump(), 0)
  }
  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      this.timer = undefined
      if (
        !this.handle ||
        this.closing ||
        this.modeActive ||
        this.stopJob ||
        this.sessionRecoveryActive
      )
        return
      if (this.coordinatedRecorder || this.coordinatedGroup) {
        if (this.focusJobs) {
          const frame = storage(456)
          const code = n.zc_acquire(this.handle, 0, ptr(frame))
          const failure =
            code === 0
              ? n.zc_release(this.handle, view(frame).getBigUint64(0, true))
              : code
          if (failure && failure !== -3)
            this.focusJob?.cancel(
              cameraError(failure, 'autofocus observation pump'),
            )
          if (this.focusJobs) this.timer = setTimeout(() => this.pump(), 1)
        }
        return
      }
      const now = performance.now()
      this.requests = this.requests.filter((job) => {
        if (job.signal?.aborted || now >= job.deadline) {
          job.reject(job.signal?.reason ?? new CameraError(-3, 'capture'))
          return false
        }
        return true
      })
      if (
        !this.recording &&
        !this.previewActive &&
        !this.requests.length &&
        !this.focusJobs &&
        !(this.started && this.hasRequestCallbacks)
      )
        return
      let frame: Frame | undefined
      let selected: CaptureRequest | undefined, capturedValue: unknown
      let attempted: CaptureRequest | undefined
      let offered: bigint | undefined
      try {
        if (this.fanout && !this.fanout.ready()) return
        frame = this.acquireOwned(0)
        offered = this.fanout?.offer()
        const callbacks = this.requestCallbacks
        let callbackFailed = false
        try {
          this.invokeHook('pre', callbacks.pre, frame)
          this.requests = this.requests.filter((job) => {
            if (!job.signal?.aborted) return true
            job.reject(job.signal.reason)
            return false
          })
          const job = this.requests[0]
          attempted = job
          if (job) {
            try {
              const code = job.accept?.(frame) ?? 0
              if (code !== -3) {
                this.requests.shift()
                check(code, 'focus-locked frame')
                capturedValue = job.operation(frame)
                selected = job
              }
            } catch (error) {
              if (this.requests[0] === job) this.requests.shift()
              job.reject(error)
            }
          }

          this.invokeHook('post', callbacks.post, frame)
        } catch (error) {
          if (!(error instanceof RequestCallbackError)) throw error
          callbackFailed = true
          if (selected) selected.reject(error)
          else if (attempted) {
            if (this.requests[0] === attempted) this.requests.shift()
            attempted.reject(error)
          } else {
            this.requests = this.requests.filter((job) => {
              if (!job.signal?.aborted) return true
              job.reject(job.signal.reason)
              return false
            })
            this.requests.shift()?.reject(error)
          }
          selected = undefined
        }
        if (!callbackFailed) {
          this.fillRecordingAudio(frame, offered!)
          for (const writing of [...this.recordings]) {
            const id = this.recordingIds.get(writing)!
            let ticket: bigint | undefined
            try {
              ticket = this.fanout!.claim(id, offered!)
              if (ticket === undefined) {
                writing[consumerState] = this.fanout!.state(id)
                continue
              }
              if (writing.recorder.asyncWrites) {
                const claim = ticket
                const pending = writing
                  .writeAsync(frame, offered)
                  .then(
                    () => this.completeRecording(writing, id, claim),
                    (error) =>
                      this.completeRecording(writing, id, claim, error),
                  )
                  .finally(() => {
                    this.producers.delete(writing)
                    if (!this.closing && !this.stopJob && this.handle)
                      this.ensurePump()
                  })
                this.producers.set(writing, pending)
              } else {
                writing.write(frame, offered)
                this.completeRecording(writing, id, ticket)
              }
            } catch (error) {
              if (ticket !== undefined)
                this.completeRecording(writing, id, ticket, error)
              else this.failRecording(writing, error)
            }
          }
          if (this.previewHandle) {
            try {
              const input = this.previewInput!
              const code =
                input.info.stream === null
                  ? n.zc_preview_show_background(this.previewHandle)
                  : n.zc_preview_show_stream(
                      this.previewHandle,
                      this.handle,
                      frame.token,
                      input.id,
                    )
              if (code === 1) this.stopPreview()
              else check(code, 'preview display')
            } catch (error) {
              this.lastPreviewError = error
              try {
                this.stopPreview()
              } catch (cleanup) {
                this.lastPreviewError = new AggregateError(
                  [error, cleanup],
                  'preview display and cleanup failed',
                )
                throw cleanup
              }
            }
          }
        }
      } catch (error) {
        if (!(error instanceof CameraError && error.code === -3)) {
          if (error instanceof CameraError && error.code === -11) {
            this.lastDeviceError ??=
              error instanceof CameraDisconnectedError
                ? error
                : new CameraDisconnectedError()
            this.focusJob?.cancel(error)
          }
          selected?.reject(error)
          selected = undefined
          for (const job of this.requests) job.reject(error)
          this.requests = []
          this.failRecordings(error)
          if (error instanceof CameraError && error.code === -11)
            this.stopPreviewOwned()
          else this.stopPreview()
        }
      } finally {
        try {
          if (!selected?.transfer) frame?.release()
        } catch (error) {
          selected?.reject(error)
          selected = undefined
          for (const job of this.requests) job.reject(error)
          this.requests = []
          this.focusJob?.cancel(error)
          this.failRecordings(error)
          try {
            this.stopPreviewOwned()
          } catch {}
        }
      }
      selected?.resolve(capturedValue)
      if (this.lastDeviceError || this.sessionRecoveryActive) return
      if (!this.handle || this.closing || this.stopJob) return
      if (
        this.recording ||
        this.previewActive ||
        this.requests.length ||
        this.focusJobs ||
        (this.started && this.hasRequestCallbacks)
      )
        if (!this.fanout || this.fanout.ready())
          this.timer = setTimeout(() => this.pump(), 1)
    } finally {
      this.pumping = false
    }
  }
  stop(): Promise<void> {
    if (this.captureProgressCallback)
      throw new CameraError(
        -4,
        'cancel the capture series from its progress callback',
      )
    guardRequestCallback()
    guardOutputHook()
    if (this.stopJob) return this.stopJob
    if (!this.handle || this.closing)
      throw new CameraError(-2, 'camera unavailable')
    return this.stopWork()
  }
  private stopWork(): Promise<void> {
    if (this.stopJob) return this.stopJob
    const coordinated = this.coordinatedRecorder
    const group = this.coordinatedGroup
    const recordings = [
      ...new Set([...this.recordings, ...this.failedRecordings]),
    ]
    if (
      this.coordinatedInitial &&
      !recordings.includes(this.coordinatedInitial)
    )
      recordings.push(this.coordinatedInitial)
    if (group)
      for (const initial of group.initials)
        if (!recordings.includes(initial)) recordings.push(initial)
    this.recordings.clear()
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    for (const job of this.requests)
      job.reject(new CameraError(-2, 'camera stopped'))
    this.requests = []
    this.stopJob = (async () => {
      let failure: unknown
      await this.cancelModes()
      const focus = this.focusJob
      if (focus && !focus.done) {
        focus.cancel(new CameraError(-2, 'camera stopped'))
        await focus.operationDone
        if (focus.error !== focus.cancellationReason) failure = focus.error
      }
      try {
        this.retireRequestMappings()
      } catch (error) {
        failure ??= error
      }
      try {
        this.stopPreview()
      } catch (error) {
        failure = error
      }
      const closing = await Promise.allSettled(
        recordings.map((recording) => recording.close()),
      )
      for (const result of closing)
        if (result.status === 'rejected') failure ??= result.reason
      if (coordinated && recordings.some((r) => r.recorder === coordinated)) {
        try {
          await coordinated.close()
        } catch (error) {
          failure ??= error
        }
      }
      if (group) {
        const closed = await Promise.allSettled(
          group.recorders.map((r) => r.close()),
        )
        for (const result of closed)
          if (result.status === 'rejected') failure ??= result.reason
      }
      await Promise.all([...this.producers.values()])
      for (const [source, group] of [...this.audioGroups]) {
        if (!group.count && !group.holds) {
          try {
            this.closeIdleAudio(source, group, true)
          } catch (error) {
            failure ??= error
          }
        } else
          failure ??= new CameraError(
            -4,
            'shared microphone owners still pending',
          )
      }
      if (this.started) {
        try {
          check(n.zc_stop(this.handle))
          this.started = false
        } catch (error) {
          failure ??= error
        }
      }
      if (failure) throw failure
    })().finally(() => {
      this.stopJob = undefined
    })
    return this.stopJob
  }
  close(): Promise<void> {
    if (this.captureProgressCallback)
      throw new CameraError(
        -4,
        'cancel the capture series from its progress callback',
      )
    guardRequestCallback()
    guardOutputHook()
    if (this.closeJob) return this.closeJob
    if (
      !this.handle &&
      !this.fanout &&
      !this.previewConfiguration &&
      !this.overlayHandle &&
      !this.tuningSession &&
      this.audioGroups.size === 0 &&
      this.disconnectJobs.size === 0 &&
      (!this.reconnectJob || this.reconnectJob.done)
    )
      return Promise.resolve()
    this.closing = true
    const disconnectJobs = [...this.disconnectJobs]
    const reconnect = this.reconnectJob
    // Publish the promise before cancellation dispatches application listeners.
    this.closeJob = Promise.resolve()
      .then(async () => {
        for (const job of disconnectJobs)
          job.cancel(new CameraError(-2, 'camera closing'))
        reconnect?.cancel(new CameraError(-2, 'camera closing'))
        await Promise.all([
          ...disconnectJobs.map((job) => job.operationDone),
          ...(reconnect ? [reconnect.operationDone] : []),
        ])
        let failure: unknown
        try {
          await this.stopWork()
        } catch (error) {
          failure = error
        }
        try {
          if (this.handle) check(n.zc_close(this.handle))
          this.handle = 0 as Pointer
          this.fanout?.close()
          this.fanout = undefined
          this.tuningSession?.close()
          this.tuningSession = undefined
        } catch (error) {
          failure ??= error
        }
        if (failure) throw failure
      })
      .finally(() => {
        if (
          this.handle ||
          this.fanout ||
          this.tuningSession ||
          this.audioGroups.size
        ) {
          this.closing = false
          this.closeJob = undefined
        }
      })
    return this.closeJob
  }
  async [Symbol.asyncDispose]() {
    await this.close()
  }
}
export interface RecordingStats {
  segments: bigint
  outputBytes: bigint
  outputFrames: bigint
  outputDurationNs: bigint
  audioFrames: bigint
  audioWrittenFrames: bigint
  audioQueuedFrames: bigint
  audioTrimmedFrames: bigint
  rotationDue: boolean
}
export interface RecorderOptions {
  /** Source for manual writes and camera recording pumps; default main. */
  stream?: 'main' | 'lores'
  /** AVC/HEVC YCbCr output profile. Primaries/transfer must match source pixels. */
  colorSpace?: ColorSpaceRequest
  width: number
  height: number
  fps?: number
  codec?: keyof typeof Codec
  encoder?: EncoderOptions
  limits?: EncoderLimits
  /** Repeat parameter sets at AVC/HEVC packet keyframes; default true. */
  repeatHeaders?: boolean
  bitrate?: number
  quality?: RecordingQuality
  gop?: number
  audio?: {
    sampleRate: number
    channels: number
    bufferFrames?: number
    maxBlocks?: number
    bitrate?: number
  }
  exclusive?: boolean
  isolate?: boolean
  circular?: {
    maxFrames: number
    maxBytes: number
    durationMs?: number
    delayMs?: number
  }
  outputQueue?: { maxBytes: number; maxOperations: number; waitMs?: number }
  producerQueue?: { maxBytes: number; maxOperations: number }
  asyncWrites?: boolean
  io?: { maxBytes: number; maxOperations: number; waitMs?: number }
}
/** Session media settings. Omitted fields retain their value; audio:null disables
 * audio, quality:null restores legacy numeric quality. Changing codec resets omitted bitrate/GOP/encoder policy to codec defaults. */
export type RecorderSessionOptions = Partial<
  Pick<
    RecorderOptions,
    'width' | 'height' | 'fps' | 'codec' | 'bitrate' | 'gop' | 'stream'
  >
> & {
  quality?: RecordingQuality | null
  audio?: RecorderOptions['audio'] | null
  colorSpace?: ColorSpaceRequest | null
  encoder?: EncoderOptions | null
  limits?: EncoderLimits | null
  repeatHeaders?: boolean | null
}
function snapshotRecorderOptions(options: RecorderOptions): RecorderOptions {
  options = { ...options }
  qualityTierCode(options.quality)
  if (
    options.repeatHeaders !== undefined &&
    typeof options.repeatHeaders !== 'boolean'
  )
    throw new TypeError('repeatHeaders must be boolean')
  options.stream = processedImageStream(options.stream)
  const colorSpace = snapshotColorSpace(options.colorSpace)
  return Object.freeze({
    ...options,
    limits:
      options.limits === undefined
        ? undefined
        : snapshotEncoderLimits(options.limits),
    encoder:
      options.encoder === undefined
        ? undefined
        : snapshotEncoderOptions(options.encoder),
    colorSpace:
      typeof colorSpace === 'object' ? Object.freeze(colorSpace) : colorSpace,
    audio: options.audio && Object.freeze({ ...options.audio }),
    circular: options.circular && Object.freeze({ ...options.circular }),
    outputQueue:
      options.outputQueue && Object.freeze({ ...options.outputQueue }),
    producerQueue:
      options.producerQueue && Object.freeze({ ...options.producerQueue }),
    io: options.io && Object.freeze({ ...options.io }),
  })
}
function mergeSessionOptions(
  current: RecorderOptions,
  settings?: RecorderSessionOptions,
): RecorderOptions {
  if (!settings) return current
  const merged = { ...current }
  if (
    settings.codec !== undefined &&
    settings.codec !== (current.codec ?? 'mjpeg')
  ) {
    merged.bitrate = undefined
    merged.gop = undefined
    merged.encoder = undefined
    merged.limits = undefined
  }
  for (const key of [
    'width',
    'height',
    'fps',
    'codec',
    'bitrate',
    'gop',
    'stream',
  ] as const) {
    const value = settings[key]
    if (value !== undefined) Object.assign(merged, { [key]: value })
  }
  const quality = settings.quality
  if (quality !== undefined) merged.quality = quality ?? undefined
  if (settings.audio !== undefined) merged.audio = settings.audio ?? undefined
  if (settings.colorSpace !== undefined)
    merged.colorSpace = settings.colorSpace ?? undefined
  if (settings.encoder !== undefined)
    merged.encoder = settings.encoder ?? undefined
  if (settings.limits !== undefined)
    merged.limits = settings.limits ?? undefined
  const repeatHeaders = settings.repeatHeaders
  if (repeatHeaders !== undefined)
    merged.repeatHeaders = repeatHeaders ?? undefined
  return snapshotRecorderOptions(merged)
}
function resolvedSession(
  options: RecorderOptions,
  width: number,
  height: number,
  exact: number,
) {
  sessionFields(options, { width, height, exact })
  return snapshotRecorderOptions({ ...options, width, height })
}
function sessionFields(
  options: RecorderOptions,
  geometry?: { width: number; height: number; exact: number },
) {
  const tier = qualityTierCode(options.quality)
  if (
    options.audio &&
    (!Number.isInteger(options.audio.sampleRate) ||
      options.audio.sampleRate < 8000 ||
      options.audio.sampleRate > 192000 ||
      (options.audio.channels !== 1 && options.audio.channels !== 2))
  )
    throw new RangeError('invalid recording audio format')
  if (options.codec !== undefined && !Object.hasOwn(Codec, options.codec))
    throw new RangeError('invalid recording codec')
  const result = {
    video: fields(32, n.zc_default_video_config, [
      options.width,
      options.height,
      options.fps ?? 30,
      1,
      Codec[options.codec ?? 'mjpeg'],
      options.bitrate,
      typeof options.quality === 'number' ? options.quality : undefined,
      options.gop,
    ]),
    audio: fields(24, n.zc_default_recording_options, [
      undefined,
      options.audio?.sampleRate ?? 0,
      options.audio?.channels ?? 1,
      options.audio?.bufferFrames,
      options.audio?.maxBlocks,
      options.exclusive ? 1 : 0,
    ]),
    bitrate: uint(options.audio?.bitrate ?? 0),
    color:
      options.colorSpace === undefined
        ? undefined
        : encodeColorSpace(options.colorSpace),
    encoder: encodeEncoderOptions(options.encoder),
    limits: encodeEncoderLimits(options.limits),
    repeatHeaders: options.repeatHeaders ?? true,
  }
  if (geometry) {
    // A named video tier overrides target bitrate; resolve that target from the
    // actual geometry before level/CPB validation, preserving native exactness.
    if (
      tier !== undefined &&
      options.codec !== undefined &&
      options.codec !== 'mjpeg'
    )
      view(result.video).setUint32(20, 0, true)
    check(
      n.zc_video_resolve_session_config(
        ptr(result.video),
        ptr(result.audio),
        result.bitrate,
        geometry.width,
        geometry.height,
        geometry.exact,
      ),
      'camera/recorder configuration',
    )
  }
  if (tier !== undefined)
    check(
      n.zc_video_apply_quality_tier(ptr(result.video), tier),
      'quality tier',
    )
  check(
    n.zc_video_check_color(
      ptr(result.video),
      result.color ? ptr(result.color) : null,
    ),
    'recording color configuration',
  )
  check(
    n.zc_video_check_codec_options(ptr(result.video), ptr(result.encoder)),
    'encoder configuration',
  )
  check(
    n.zc_video_check_codec_limits(
      ptr(result.video),
      ptr(result.encoder),
      ptr(result.limits),
    ),
    'encoder limits',
  )
  return result
}
function describeStreams(
  options: RecorderOptions,
  headers: Uint8Array,
): OutputStreams {
  return {
    width: options.width,
    height: options.height,
    fps: options.fps ?? 30,
    codec: Codec[options.codec ?? 'mjpeg'],
    headers,
    colorSpace:
      options.codec === 'h264' || options.codec === 'hevc'
        ? describeRecordingColor(options.colorSpace)
        : undefined,
    audio: options.audio
      ? {
          sampleRate: options.audio.sampleRate,
          channels: options.audio.channels,
        }
      : undefined,
  }
}
function describeRecordingColor(requested?: ColorSpaceRequest) {
  const color =
    requested === undefined ? storage(24) : encodeColorSpace(requested)
  if (requested === undefined) n.zc_default_video_color(ptr(color))
  return decodeStreamColorSpace(color)
}
export interface HostOutputStats extends HostOutputQueueStats {
  id: bigint
  generation: bigint
}
export interface ProducerAudioBlock {
  data: Uint8Array
  timestampNs: bigint
}
export interface PreparationState {
  id: bigint
  generation: bigint
  phase: number
  staged: boolean
  done: boolean
  errorCode: number
}
export class PreparationJob implements PromiseLike<void> {
  private closed = false
  constructor(
    private recorder: Recorder,
    private handle: Pointer | BunJob<void>,
    private outputId = 0n,
    private generation = 0n,
  ) {}
  get status(): PreparationState {
    guardOutputHook()
    if (this.closed) throw new CameraError(-2, 'closed preparation job')
    if (typeof this.handle !== 'number') {
      const job = this.handle
      return {
        id: this.outputId,
        generation: this.generation,
        phase: job.phase,
        staged: job.phase === 3,
        done: job.done,
        errorCode: job.done
          ? job.error === undefined
            ? 0
            : job.error instanceof CameraError
              ? job.error.code
              : job.cancelRequested && job.error === job.cancellationReason
                ? -5
                : -6
          : -3,
      }
    }
    if (this.recorder.closing) throw new CameraError(-4, 'recorder is closing')
    if (this.recorder.handle) this.recorder.poll()
    const data = storage(32)
    check(n.zc_preparation_job_state_get(this.handle, ptr(data)))
    const d = view(data)
    return {
      id: u64(data),
      generation: u64(data, 8),
      phase: d.getUint32(16, true),
      staged: !!d.getUint32(20, true),
      done: !!d.getUint32(24, true),
      errorCode: d.getInt32(28, true),
    }
  }
  cancel() {
    guardOutputHook()
    if (typeof this.handle !== 'number') return this.handle.cancel()
    if (this.closed || this.recorder.closing) return false
    return n.zc_preparation_job_cancel(this.handle) === 0
  }
  async wait({
    timeoutMs = 30_000,
    signal,
  }: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    if (typeof this.handle !== 'number') {
      const job = this.handle
      return await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new CameraError(-3, 'preparation wait'))
        }, timeoutMs)
        const abort = () => job.cancel(signal?.reason)
        const cleanup = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
        }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        job.wait().then(
          () => {
            cleanup()
            resolve()
          },
          (error) => {
            cleanup()
            reject(error)
          },
        )
      })
    }
    const deadline = performance.now() + timeoutMs
    while (true) {
      if (this.recorder.closing) {
        try {
          await this.recorder.closed
        } catch {
          /* read terminal job after cleanup */
        }
      }
      let state: PreparationState
      try {
        state = this.status
      } catch (error) {
        if (!(error instanceof CameraError && error.code === -4)) throw error
        if (signal?.aborted) throw signal.reason ?? new Error('aborted')
        if (performance.now() >= deadline)
          throw new CameraError(-3, 'preparation wait')
        await pause()
        continue
      }
      if (state.done) {
        check(state.errorCode, 'output preparation')
        return
      }
      if (signal?.aborted) {
        this.cancel()
        throw signal.reason ?? new Error('aborted')
      }
      if (performance.now() >= deadline)
        throw new CameraError(-3, 'preparation wait')
      await pause()
    }
  }
  then<TResult1 = void, TResult2 = never>(
    fulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.wait().then(fulfilled, rejected)
  }
  close() {
    guardOutputHook()
    if (this.closed) return
    if (this.recorder.closing) throw new CameraError(-4, 'recorder closing')
    if (typeof this.handle !== 'number') {
      if (!this.handle.done) throw new CameraError(-4, 'preparation pending')
      this.closed = true
      this.recorder.forget(this)
      return
    }
    check(n.zc_preparation_job_close(this.handle))
    this.closed = true
    this.recorder.forget(this)
  }
}
class TaskDispatchError extends Error {}
function nativeTask(
  operation: 'close' | 'snapshot' | 'drain',
  handle: Pointer,
): Promise<{ code: number; results?: Uint8Array; count: number }> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined
    try {
      worker = new Worker(new URL('./native-task.ts', import.meta.url).href)
      const owned = worker
      owned.onmessage = (event) => {
        const data = event.data
        if (data.error) reject(new Error(data.error))
        else resolve(data)
        owned.terminate()
      }
      owned.onerror = (event) => {
        reject(new Error(event.message))
        owned.terminate()
      }
      owned.postMessage({ operation, handle })
    } catch (error) {
      worker?.terminate()
      // Dispatch failed before ownership transferred; independent handles must
      // still release their frozen storage/fence tickets.
      if (operation === 'snapshot') n.zc_snapshot_close(handle)
      if (operation === 'drain') n.zc_output_job_close(handle)
      reject(new TaskDispatchError(String(error)))
    }
  })
}
function factoryFailureCode(error: unknown, cancelled = false) {
  if (error === undefined) return 0
  if (
    error instanceof CameraError &&
    Number.isInteger(error.code) &&
    error.code < 0 &&
    error.code >= -2147483648
  )
    return error.code
  return cancelled ? -5 : -6
}
export interface OutputFactoryContext {
  readonly id: bigint
  readonly index: bigint
  readonly generation: bigint
  readonly reason: 'rotation' | 'recovery'
  readonly signal: AbortSignal
  readonly streams: OutputStreams
}
export type OutputFactory = (
  context: OutputFactoryContext,
) => CustomOutput | Promise<CustomOutput>
export interface FactoryRotationOptions {
  nextIndex?: bigint
  durationMs?: number
  maxBytes?: number
  timeoutMs?: number
}
export interface FactoryRecoveryOptions {
  nextIndex?: bigint
  maxAttempts?: number
  retryDelayMs?: number
  maxDelayMs?: number
  timeoutMs?: number
}
interface FactoryEntry {
  factory: OutputFactory
  recovery: boolean
  timeoutMs?: number
  job?: BunJob<void>
  error?: unknown
  stopping?: Promise<void>
}
export class Recorder {
  handle: Pointer
  private recordingColorBytes?: Uint8Array
  private currentOptions: RecorderOptions
  get width() {
    return this.currentOptions.width
  }
  get height() {
    return this.currentOptions.height
  }
  get fps() {
    return this.currentOptions.fps ?? 30
  }
  get options() {
    return this.currentOptions
  }
  closing = false
  closed?: Promise<void>
  outputErrors = new Map<bigint, unknown>()
  private jobs = new Set<PreparationJob>()
  private objectOutputs = new Map<
    bigint,
    { bridge: OutputBridge; generation: bigint }
  >()
  private objectPreparations = new Map<bigint, object>()
  private objectJobs = new Set<{
    cancel: (reason?: unknown) => boolean
    operationDone: Promise<void>
    cleanupDone: Promise<void>
    done: boolean
  }>()
  private retiringOutputs = new Set<bigint>()
  private factories = new Map<bigint, FactoryEntry>()
  private hostReports = new Map<bigint, HostOutputStats>()
  private publishedHostOutputs = new WeakSet<OutputBridge>()
  private schedulingFactories = false
  private tasks = 0
  private producerTail: Promise<void> = Promise.resolve()
  private capturingCamera?: Camera
  private coordinator?: Pick<BunJob<unknown>, 'cancel' | 'operationDone'>
  private coordinatorEntry = false
  private producerJobs = new Set<object>()
  private restartPending = false
  private sessionEpoch = 0n
  private deliveryBridges = new Set<OutputBridge>()
  private deliveryFailure: unknown
  private producerTurn?: Promise<void>
  private pendingHostOutputs = new Map<
    bigint,
    { bridge: OutputBridge; generation: bigint }
  >()
  private deferredOutputFailures = new Set<() => void>()
  private finalProducerStats?: ReturnType<Recorder['producerStats']>
  private finalStats?: RecordingStats
  constructor(path: string | null, options: RecorderOptions) {
    if (path !== null) guardHostPath(path)
    options = snapshotRecorderOptions(options)
    const producerLimits = options.producerQueue
      ? {
          bytes: uint(options.producerQueue.maxBytes, 1024 ** 3),
          jobs: uint(options.producerQueue.maxOperations, 8),
        }
      : undefined
    if (producerLimits && (!producerLimits.bytes || !producerLimits.jobs))
      throw new RangeError('invalid producer queue bounds')
    this.currentOptions = options
    const {
      video: cfg,
      audio: opts,
      color,
      encoder,
      limits,
    } = sessionFields(options)
    this.recordingColorBytes = color
    const configuredPath =
      path !== null &&
      (color !== undefined ||
        options.encoder !== undefined ||
        options.limits !== undefined ||
        options.repeatHeaders !== undefined)
    const out = outPointer()
    if (options.circular) {
      const ring = fields(24, n.zc_default_buffer_config, [
        undefined,
        options.circular.maxFrames,
      ])
      view(ring).setBigUint64(
        8,
        BigInt(uint(options.circular.maxBytes, Number.MAX_SAFE_INTEGER)),
        true,
      )
      view(ring).setBigUint64(
        16,
        BigInt(Math.round((options.circular.durationMs ?? 5000) * 1000)),
        true,
      )
      check(
        options.audio
          ? n.zc_video_open_circular_av(
              ptr(cfg),
              ptr(ring),
              ptr(opts),
              uint(options.audio?.bitrate ?? 0),
              ptr(out),
            )
          : n.zc_video_open_circular(ptr(cfg), ptr(ring), ptr(out)),
      )
    } else if (path === null || configuredPath)
      check(
        n.zc_video_create(
          ptr(cfg),
          ptr(opts),
          uint(
            options.audio?.bitrate ??
              (configuredPath && options.audio && path!.endsWith('.mp4')
                ? 128000
                : 0),
          ),
          ptr(out),
        ),
      )
    else {
      const name = cstring(path)
      check(
        options.audio && path.endsWith('.mp4')
          ? n.zc_video_open_aac(
              ptr(name),
              ptr(cfg),
              ptr(opts),
              uint(options.audio.bitrate ?? 128000),
              ptr(out),
            )
          : n.zc_video_open_ex(ptr(name), ptr(cfg), ptr(opts), ptr(out)),
      )
    }
    this.handle = handle(out)
    try {
      if (options.repeatHeaders !== undefined)
        check(
          n.zc_video_set_repeat_headers(
            this.handle,
            Number(options.repeatHeaders),
          ),
          'packet header configuration',
        )
      if (options.encoder)
        check(
          n.zc_video_set_codec_options(this.handle, ptr(encoder)),
          'encoder configuration',
        )
      if (options.limits)
        check(
          n.zc_video_set_codec_limits(this.handle, ptr(limits)),
          'encoder limits',
        )
      if (color)
        check(
          n.zc_video_set_color(this.handle, ptr(color)),
          'recording color configuration',
        )
      if (producerLimits)
        check(
          n.zc_video_set_producer_limits(
            this.handle,
            BigInt(producerLimits.bytes),
            producerLimits.jobs,
          ),
        )
      if (options.isolate)
        check(n.zc_video_set_failure_isolation(this.handle, 1))
      if (options.circular?.delayMs !== undefined)
        check(
          n.zc_video_set_delay(this.handle, nanos(options.circular.delayMs)),
        )
      if ((options.circular || configuredPath) && path !== null) {
        const name = cstring(path)
        check(n.zc_video_open_output(this.handle, ptr(name)))
      }
      if (path !== null && options.io) this.setIO(0n, options.io)
    } catch (error) {
      n.zc_video_close(this.handle)
      this.handle = 0 as Pointer
      throw error
    }
  }
  assertOpen(allowProducer = false) {
    if (this.coordinator && !this.coordinatorEntry)
      throw new CameraError(-4, 'coordinated mode owns recorder')
    this.assertOwned(allowProducer)
  }
  qualityPolicy() {
    this.assertOpen()
    const video = storage(32),
      audio = storage(24),
      audioBitrate = new Uint32Array(1)
    check(
      n.zc_video_session_config(
        this.handle,
        ptr(video),
        ptr(audio),
        ptr(audioBitrate),
      ),
      'recording quality policy',
    )
    const cfg = view(video),
      codec = cfg.getUint32(16, true),
      bitrate = cfg.getUint32(20, true),
      quality = cfg.getUint32(24, true)
    const qp = this.encoderOptions().qp
    return Object.freeze({
      tier:
        typeof this.options.quality === 'string'
          ? this.options.quality
          : undefined,
      numericQuality: quality,
      targetBitrate: bitrate,
      mode:
        codec === 3
          ? ('jpeg' as const)
          : qp
            ? ('cqp' as const)
            : bitrate
              ? ('abr' as const)
              : ('crf' as const),
    })
  }
  repeatedHeaders(): boolean {
    this.assertOpen()
    const enabled = new Uint32Array(1)
    check(
      n.zc_video_get_repeat_headers(this.handle, ptr(enabled)),
      'packet header policy',
    )
    return enabled[0] !== 0
  }
  encoderOptions() {
    this.assertOpen()
    return readEncoderOptions(this.handle)
  }
  /** Apply one counted request to a future accepted input. Use the async method
   * when copied writes are pending. Neither method waits for packet delivery. */
  requestKeyframe() {
    this.assertOpen()
    check(n.zc_video_request_keyframe(this.handle), 'keyframe request')
  }
  requestKeyframeAsync(options: JobOptions<void> = {}): BunJob<void> {
    this.assertOpen(true)
    options = snapshotJobOptions(options)
    this.assertOpen(true)
    const out = outPointer()
    check(
      n.zc_video_producer_keyframe(this.handle, ptr(out)),
      'keyframe admission',
    )
    return this.queueProducer(handle(out), options, 'keyframe')
  }
  keyframeState(): { requested: bigint; applied: bigint; pending: number } {
    this.assertOpen()
    const data = storage(24)
    check(n.zc_video_keyframe_state(this.handle, ptr(data)), 'keyframe state')
    return {
      requested: u64(data),
      applied: u64(data, 8),
      pending: view(data).getUint32(16, true),
    }
  }
  encoderLimits() {
    this.assertOpen()
    return readEncoderLimits(this.handle)
  }
  private assertOwned(allowProducer = false) {
    guardOutputHook()
    if (!this.handle || this.closing)
      throw new CameraError(-2, 'closed recorder')
    if (this.producerTurn && !allowProducer)
      throw new CameraError(-4, 'async producer owns recorder')
  }
  colorSpace() {
    this.assertOpen()
    const color = storage(24)
    check(n.zc_video_get_color(this.handle, ptr(color)), 'recording color')
    return decodeStreamColorSpace(color)
  }
  get asyncWrites() {
    return (
      this.options.asyncWrites ??
      !!(
        this.options.producerQueue ||
        this.options.outputQueue?.waitMs ||
        this.options.io?.waitMs
      )
    )
  }
  private async producerIdle() {
    while (this.producerTurn) await this.producerTurn
  }
  producerStats(): {
    ownedBytes: bigint
    ownedJobs: bigint
    highBytes: bigint
    highJobs: bigint
    maxBytes: bigint
    maxJobs: bigint
    admitted: bigint
    released: bigint
    rejected: bigint
    completed: bigint
    failed: bigint
    cancelled: bigint
    running: boolean
  } {
    guardOutputHook()
    if (!this.handle && this.finalProducerStats)
      return { ...this.finalProducerStats }
    this.assertOpen(true)
    return this.readProducerStats()
  }
  private readProducerStats(): NonNullable<typeof this.finalProducerStats> {
    const data = storage(104),
      d = view(data),
      value = (o: number) => d.getBigUint64(o, true)
    check(n.zc_video_producer_stats(this.handle, ptr(data)))
    return {
      ownedBytes: value(0),
      ownedJobs: value(8),
      highBytes: value(16),
      highJobs: value(24),
      maxBytes: value(32),
      maxJobs: value(40),
      admitted: value(48),
      released: value(56),
      rejected: value(64),
      completed: value(72),
      failed: value(80),
      cancelled: value(88),
      running: !!d.getUint32(96, true),
    }
  }
  writeAsync(
    frame: Frame,
    timestampNs = frame.timestampNs,
    options: JobOptions<void> = {},
  ): BunJob<void> {
    this.assertOpen(true)
    options = snapshotJobOptions(options)
    this.assertOpen(true)
    if (!frame.token) throw new CameraError(-5, 'released frame')
    const source =
      this.options.stream === 'lores' ||
      this.recordingColorBytes !== undefined ||
      !frame[rgbMainFrame]
        ? frame[recorderInput](
            this.options.stream ?? 'main',
            this.recordingColorBytes,
          )
        : undefined
    const out = outPointer()
    check(
      source
        ? n.zc_video_producer_input_av(
            this.handle,
            ptr(source.descriptor),
            ptr(source.color),
            timestampNs,
            null,
            0,
            ptr(out),
          )
        : n.zc_video_producer_frame(
            this.handle,
            ptr(frame[readableFrame]),
            timestampNs,
            ptr(out),
          ),
      'producer frame admission',
    )
    return this.queueProducer(handle(out), options)
  }
  writeAudioAsync(
    data: Uint8Array,
    timestampNs: bigint,
    options: JobOptions<void> = {},
  ): BunJob<void> {
    this.assertOpen(true)
    options = snapshotJobOptions(options)
    this.assertOpen(true)
    if (!data.length) throw new RangeError('empty PCM')
    const out = outPointer()
    check(
      n.zc_video_producer_audio(
        this.handle,
        ptr(data),
        BigInt(data.length),
        timestampNs,
        ptr(out),
      ),
      'producer PCM admission',
    )
    return this.queueProducer(handle(out), options)
  }
  writeAVAsync(
    frame: Frame,
    audio: readonly ProducerAudioBlock[],
    timestampNs = frame.timestampNs,
    options: JobOptions<void> = {},
  ): BunJob<void> {
    this.assertOpen(true)
    options = snapshotJobOptions(options)
    if (!frame.token) throw new CameraError(-5, 'released frame')
    const blockCount = uint(audio.length, 256)
    // Resolve application getters before deriving pointers. A later getter may
    // detach an earlier array or change the camera/recorder lifecycle.
    const blocks = Array.from({ length: blockCount }, (_, i) => {
      const block = audio[i]
      return { data: block.data, timestampNs: block.timestampNs }
    })
    const inputs = storage(blockCount * 24),
      d = view(inputs)
    for (let i = 0; i < blockCount; i++) {
      if (!(blocks[i].data instanceof Uint8Array) || !blocks[i].data.byteLength)
        throw new RangeError('empty or invalid PCM')
      d.setBigUint64(i * 24, BigInt(ptr(blocks[i].data)), true)
      d.setBigUint64(i * 24 + 8, BigInt(blocks[i].data.length), true)
      d.setBigUint64(i * 24 + 16, blocks[i].timestampNs, true)
    }
    this.assertOpen(true)
    const source =
      this.options.stream === 'lores' ||
      this.recordingColorBytes !== undefined ||
      !frame[rgbMainFrame]
        ? frame[recorderInput](
            this.options.stream ?? 'main',
            this.recordingColorBytes,
          )
        : undefined
    const out = outPointer()
    check(
      source
        ? n.zc_video_producer_input_av(
            this.handle,
            ptr(source.descriptor),
            ptr(source.color),
            timestampNs,
            blockCount ? ptr(inputs) : null,
            blockCount,
            ptr(out),
          )
        : n.zc_video_producer_av(
            this.handle,
            ptr(frame[readableFrame]),
            timestampNs,
            blockCount ? ptr(inputs) : null,
            blockCount,
            ptr(out),
          ),
      'producer A/V admission',
    )
    return this.queueProducer(handle(out), options)
  }
  [writeSharedAudio](
    frame: Frame,
    batch: NativeAudioBatch,
    timestampNs: bigint,
    asynchronous: boolean,
  ): BunJob<void> | undefined {
    this.assertOpen(asynchronous)
    if (!asynchronous) {
      const d = view(batch.inputs)
      for (let i = 0; i < batch.count; i++)
        check(
          n.zc_video_write_audio(
            this.handle,
            Number(d.getBigUint64(i * 24, true)) as Pointer,
            d.getBigUint64(i * 24 + 8, true),
            d.getBigUint64(i * 24 + 16, true),
          ),
          'shared PCM write',
        )
      this.write(frame, timestampNs)
      return
    }
    const source =
        this.options.stream === 'lores' ||
        this.recordingColorBytes !== undefined ||
        !frame[rgbMainFrame]
          ? frame[recorderInput](
              this.options.stream ?? 'main',
              this.recordingColorBytes,
            )
          : undefined,
      out = outPointer()
    check(
      source
        ? n.zc_video_producer_input_av(
            this.handle,
            ptr(source.descriptor),
            ptr(source.color),
            timestampNs,
            batch.count ? ptr(batch.inputs) : null,
            batch.count,
            ptr(out),
          )
        : n.zc_video_producer_av(
            this.handle,
            ptr(frame[readableFrame]),
            timestampNs,
            batch.count ? ptr(batch.inputs) : null,
            batch.count,
            ptr(out),
          ),
      'shared A/V producer admission',
    )
    return this.queueProducer(handle(out), {})
  }
  private queueProducer(
    native: Pointer,
    options: JobOptions<void>,
    mode: 'write' | 'drain' | 'flush' | 'keyframe' = 'write',
  ) {
    let owned = true
    const release = () => {
      if (owned) {
        check(n.zc_producer_job_close(native), 'producer cleanup')
        owned = false
      }
    }
    try {
      const lifecycle = this.objectJob<void>(
        async (job) => {
          // New native turns begin on a later macrotask. Waiting main-thread
          // lifecycle continuations finish their synchronous ABI work first.
          await pause()
          job.check()
          this.assertOwned(true)
          let unlock!: () => void
          this.producerTurn = new Promise<void>((resolve) => {
            unlock = resolve
          })
          let started = false,
            finished = false
          try {
            check(n.zc_producer_job_start(native), 'producer start')
            started = true
            if (mode === 'flush') job.seal()
            else
              job.setCancellationGuard(
                () =>
                  n.zc_producer_job_cancel(native) === 0 || mode === 'drain',
              )
            const code = new Int32Array(1),
              handoffs = storage(8 * 16),
              count = new Uint32Array(1)
            let observed = 0
            const retire = () => {
              check(
                n.zc_producer_job_handoffs(
                  native,
                  ptr(handoffs),
                  8,
                  ptr(count),
                ),
              )
              for (; observed < count[0]; observed++) {
                const id = u64(handoffs, observed * 16),
                  generation = u64(handoffs, observed * 16 + 8)
                const old = this.objectOutputs.get(id)
                if (old && old.generation < generation) {
                  void old.bridge.retire().catch(() => {})
                  const next = this.pendingHostOutputs.get(id)
                  if (next?.generation === generation)
                    this.setHostOutput(id, next)
                  else this.objectOutputs.delete(id)
                }
              }
            }
            while (true) {
              retire()
              const state = n.zc_producer_job_finish(native, ptr(code))
              if (state === -3) {
                await pause()
                continue
              }
              check(state, 'producer completion')
              finished = true
              retire()
              if (code[0] === -10) job.check()
              if (mode === 'drain' || mode === 'flush') {
                if (mode === 'drain') job.setCancellationGuard(undefined)
                const prefixes = [...this.deliveryBridges].map((bridge) => ({
                  bridge,
                  target: bridge.prefix(),
                  done: false,
                }))
                let failure: unknown = this.deliveryFailure
                while (true) {
                  if (mode !== 'flush') job.check()
                  let pending = false
                  const nativeCode = n.zc_producer_job_drain_outputs(native)
                  if (nativeCode === -3) pending = true
                  else if (nativeCode !== 0)
                    failure ??= new CameraError(
                      nativeCode,
                      'recording delivery',
                    )
                  for (const prefix of prefixes) {
                    if (prefix.done) continue
                    try {
                      prefix.done = prefix.bridge.pollDrain(prefix.target)
                    } catch (error) {
                      failure ??= error
                      prefix.done = true
                    }
                    if (!prefix.done) pending = true
                  }
                  if (!pending) {
                    check(code[0], 'recording barrier')
                    if (failure !== undefined) throw failure
                    break
                  }
                  await pause()
                }
              }
              check(
                code[0],
                mode === 'keyframe'
                  ? 'async keyframe request'
                  : 'async producer write',
              )
              job.check()
              job.seal()
              break
            }
          } finally {
            job.setCancellationGuard(undefined)
            if (!started || finished) release()
            this.producerTurn = undefined
            unlock()
            const failures = [...this.deferredOutputFailures]
            this.deferredOutputFailures.clear()
            for (const fail of failures) fail()
            if (!this.closing) {
              this.reconcileOutputs()
              this.scheduleFactories()
            }
          }
        },
        options,
        'producer',
      )
      void lifecycle.operationDone.then(release)
      return lifecycle
    } catch (error) {
      release()
      throw error
    }
  }
  write(frame: Frame, timestampNs = frame.timestampNs) {
    this.assertOpen()
    if (!frame.token) throw new CameraError(-5, 'released frame')
    const source =
      this.options.stream === 'lores' ||
      this.recordingColorBytes !== undefined ||
      !frame[rgbMainFrame]
        ? frame[recorderInput](
            this.options.stream ?? 'main',
            this.recordingColorBytes,
          )
        : undefined
    check(
      source
        ? n.zc_video_write_input(
            this.handle,
            ptr(source.descriptor),
            ptr(source.color),
            timestampNs,
          )
        : n.zc_video_write(this.handle, ptr(frame[readableFrame]), timestampNs),
    )
    this.reconcileOutputs()
    this.scheduleFactories()
  }
  writeAudio(data: Uint8Array, timestampNs: bigint) {
    this.assertOpen()
    if (!data.length) throw new RangeError('empty PCM')
    check(
      n.zc_video_write_audio(
        this.handle,
        ptr(data),
        BigInt(data.length),
        timestampNs,
      ),
    )
  }
  poll() {
    this.assertOpen()
    check(n.zc_video_poll_preparations(this.handle))
    this.reconcileOutputs()
  }
  stats(): RecordingStats {
    if (!this.handle && this.finalStats) return this.finalStats
    this.assertOpen()
    return this.readRecordingStats()
  }
  private readRecordingStats(): RecordingStats {
    const data = storage(72)
    check(n.zc_video_recording_stats(this.handle, ptr(data)))
    return {
      segments: u64(data),
      outputBytes: u64(data, 8),
      outputFrames: u64(data, 16),
      outputDurationNs: u64(data, 24),
      audioFrames: u64(data, 32),
      audioWrittenFrames: u64(data, 40),
      audioQueuedFrames: u64(data, 48),
      audioTrimmedFrames: u64(data, 56),
      rotationDue: !!view(data).getUint32(64, true),
    }
  }
  outputState(id: bigint | number = 0n) {
    this.assertOpen()
    const data = storage(24)
    check(n.zc_video_output_state(this.handle, BigInt(id), ptr(data)))
    return state(data)
  }
  outputStats(id: bigint | number = 0n) {
    this.assertOpen()
    const data = storage(48)
    check(n.zc_video_output_stats(this.handle, BigInt(id), ptr(data)))
    return {
      id: u64(data),
      frames: u64(data, 8),
      bytes: u64(data, 16),
      firstNs: u64(data, 24),
      audioFrames: u64(data, 32),
      waitingKey: !!view(data).getUint32(40, true),
    }
  }
  bufferStats() {
    this.assertOpen()
    const data = storage(64)
    check(n.zc_video_buffer_stats(this.handle, ptr(data)))
    return {
      frames: u64(data),
      bytes: u64(data, 8),
      evicted: u64(data, 16),
      skipped: u64(data, 24),
      firstNs: u64(data, 32),
      lastNs: u64(data, 40),
      segments: u64(data, 48),
      splitPending: !!view(data).getUint32(56, true),
      outputOpen: !!view(data).getUint32(60, true),
    }
  }
  static async open(output: string | CustomOutput, options: RecorderOptions) {
    guardOutputHook()
    if (typeof output === 'string') return new Recorder(output, options)
    const recorder = new Recorder(null, options)
    try {
      await recorder.openOutput(output)
      return recorder
    } catch (error) {
      try {
        await recorder.close()
      } catch {}
      throw error
    }
  }
  openOutput(output: CustomOutput, options: JobOptions<void> = {}) {
    this.assertOpen()
    return this.attachObject(output, true, options) as BunJob<void>
  }
  addOutput(path: string): bigint
  addOutput(output: CustomOutput, options?: JobOptions<bigint>): BunJob<bigint>
  addOutput(
    output: string | CustomOutput,
    options: JobOptions<bigint> = {},
  ): bigint | BunJob<bigint> {
    this.assertOpen()
    if (typeof output !== 'string')
      return this.attachObject(output, false, options) as BunJob<bigint>
    guardHostPath(output)
    const name = cstring(output),
      id = new BigUint64Array(1)
    check(n.zc_video_add_output(this.handle, ptr(name), ptr(id)))
    try {
      if (this.options.io) this.setIO(id[0], this.options.io)
    } catch (error) {
      n.zc_video_remove_output(this.handle, id[0])
      throw error
    }
    return id[0]
  }
  removeOutput(id: bigint | number): void | BunJob<void> {
    this.assertOpen()
    const key = BigInt(id)
    this.checkOutputMutation(key)
    const current = this.objectOutputs.get(key)
    if (!current) {
      check(n.zc_video_remove_output(this.handle, key))
      return
    }
    return this.objectJob<void>(async (job) => {
      job.check()
      this.retiringOutputs.add(key)
      let primary: unknown
      const code = n.zc_video_remove_output(this.handle, key)
      const present = storage(24)
      if (n.zc_video_output_state(this.handle, key, ptr(present)) === 0) {
        this.retiringOutputs.delete(key)
        check(code, 'remove output')
        throw new CameraError(-4, 'output not detached')
      }
      this.objectOutputs.delete(key)
      try {
        if (code !== 0)
          primary = current.bridge.error ?? cameraError(code, 'remove output')
        await current.bridge.retire()
      } catch (error) {
        primary ??= error
      } finally {
        this.retiringOutputs.delete(key)
      }
      if (primary !== undefined) {
        this.outputErrors.set(key, primary)
        throw primary
      }
    })
  }
  setIO(
    id: bigint | number,
    options: { maxBytes: number; maxOperations: number; waitMs?: number },
  ) {
    this.assertOpen()
    this.checkOutputMutation(BigInt(id))
    check(
      n.zc_video_set_output_io(
        this.handle,
        BigInt(id),
        BigInt(uint(options.maxBytes, 1024 ** 3)),
        uint(options.maxOperations, 65536),
        nanos(options.waitMs ?? 0),
      ),
    )
  }
  ioStats(id: bigint | number = 0n) {
    this.assertOpen()
    const data = storage(88)
    check(n.zc_video_output_io_stats(this.handle, BigInt(id), ptr(data)))
    return {
      queuedBytes: u64(data),
      queuedOperations: u64(data, 8),
      acceptedOperations: u64(data, 16),
      completedOperations: u64(data, 24),
      rejectedOperations: u64(data, 32),
      highBytes: u64(data, 40),
      highOperations: u64(data, 48),
      maxBytes: u64(data, 56),
      waitNs: u64(data, 64),
      maxOperations: view(data).getUint32(72, true),
      running: !!view(data).getUint32(76, true),
      errorCode: view(data).getInt32(80, true),
      splitError: view(data).getInt32(84, true),
    }
  }
  /** Native queue ownership and host hook state for one output epoch. */
  hostIOStats(id: bigint | number = 0n): HostOutputStats {
    guardOutputHook()
    const key = BigInt(id),
      current = this.objectOutputs.get(key)
    if (current)
      return {
        id: key,
        generation: current.generation,
        ...current.bridge.stats(),
      }
    const final = this.hostReports.get(key)
    if (final) return { ...final }
    throw new CameraError(-2, 'no host output telemetry')
  }
  /** Wait for observed headroom; this does not reserve capacity or retry media. */
  waitForOutput(
    id: bigint | number = 0n,
    options: OutputCapacityOptions &
      Omit<JobOptions<HostOutputStats>, 'timeoutMs'> = {},
  ): BunJob<HostOutputStats> {
    this.assertOpen(true)
    const key = BigInt(id),
      current = this.objectOutputs.get(key)
    if (!current) throw new CameraError(-2, 'no host output')
    const wait = current.bridge.capacityWait(options)
    try {
      const job = this.objectJob<HostOutputStats>(
        async (job) => {
          try {
            await wait.wait(() => job.check())
            job.check()
            if (this.objectOutputs.get(key) !== current)
              throw new CameraError(-5, 'output epoch replaced')
            return {
              id: key,
              generation: current.generation,
              ...current.bridge.stats(),
            }
          } finally {
            wait.close()
          }
        },
        { signal: options.signal, signalFunction: options.signalFunction },
        'host',
      )
      void job.operationDone.then(() => wait.close())
      return job
    } catch (error) {
      wait.close()
      throw error
    }
  }
  setDelay(
    id: bigint | number,
    delayMs: number,
    { maxBytes = 64 * 1024 * 1024, maxFrames = 300 } = {},
  ) {
    this.assertOpen()
    check(
      n.zc_video_set_output_delay(
        this.handle,
        BigInt(id),
        nanos(delayMs),
        BigInt(uint(maxBytes, Number.MAX_SAFE_INTEGER)),
        uint(maxFrames),
      ),
    )
  }
  split(output: string | CustomOutput, id: bigint | number = 0n) {
    return this.prepare(output, BigInt(id), false)
  }
  recover(output: string | CustomOutput, id: bigint | number = 0n) {
    return this.prepare(output, BigInt(id), true)
  }
  private prepare(
    output: string | CustomOutput,
    id: bigint,
    recovery: boolean,
  ): PreparationJob {
    this.assertOpen()
    this.checkOutputMutation(id)
    if (typeof output !== 'string' || this.objectOutputs.has(id))
      return this.prepareObject(output, id, recovery)
    const name = cstring(output),
      out = outPointer()
    check(
      n.zc_video_prepare_async(
        this.handle,
        id,
        ptr(name),
        null,
        recovery ? 1 : 0,
        ptr(out),
      ),
    )
    const job = new PreparationJob(this, handle(out))
    this.jobs.add(job)
    return job
  }
  forget(job: PreparationJob) {
    this.jobs.delete(job)
  }
  setRotation(
    pattern: string | OutputFactory,
    options: FactoryRotationOptions,
    id: bigint | number = 0n,
  ) {
    this.assertOpen()
    if (typeof pattern === 'function')
      return this.configureFactory(BigInt(id), pattern, false, options)
    if (BigInt(id) !== 0n)
      throw new CameraError(-8, 'path rotation requires primary output')
    this.checkOutputMutation(0n)
    if (this.objectOutputs.has(0n))
      throw new CameraError(-8, 'custom outputs rotate with split jobs')
    const name = cstring(pattern)
    check(
      n.zc_video_set_automatic(
        this.handle,
        0n,
        ptr(name),
        options.nextIndex ?? 1n,
        0,
        nanos(options.durationMs ?? 0),
        BigInt(uint(options.maxBytes ?? 0, Number.MAX_SAFE_INTEGER)),
      ),
    )
  }
  setRecovery(
    id: bigint | number,
    pattern: string | OutputFactory,
    {
      nextIndex = 1n,
      maxAttempts = 3,
      retryDelayMs = 100,
      maxDelayMs = 5000,
      timeoutMs,
    }: FactoryRecoveryOptions = {},
  ) {
    this.assertOpen()
    if (typeof pattern === 'function')
      return this.configureFactory(BigInt(id), pattern, true, {
        nextIndex,
        maxAttempts,
        retryDelayMs,
        maxDelayMs,
        timeoutMs,
      })
    this.checkOutputMutation(BigInt(id))
    if (this.objectOutputs.has(BigInt(id)))
      throw new CameraError(-8, 'custom outputs recover with output objects')
    const name = cstring(pattern)
    check(
      n.zc_video_set_output_recovery(
        this.handle,
        BigInt(id),
        uint(maxAttempts),
        nanos(retryDelayMs),
        nanos(maxDelayMs),
      ),
    )
    check(
      n.zc_video_set_automatic(
        this.handle,
        BigInt(id),
        ptr(name),
        nextIndex,
        1,
        0n,
        0n,
      ),
    )
  }
  stopAutomatic(id: bigint | number = 0n): void | Promise<void> {
    this.assertOpen()
    const entry = this.factories.get(BigInt(id))
    if (entry) return this.stopFactory(BigInt(id), entry)
    check(
      n.zc_video_set_automatic(this.handle, BigInt(id), null, 0n, 0, 0n, 0n),
    )
  }
  automaticState(id: bigint | number = 0n) {
    this.assertOpen()
    if (this.factories.has(BigInt(id))) return this.factoryState(BigInt(id))
    const data = storage(16)
    check(n.zc_video_automatic_state(this.handle, BigInt(id), ptr(data)))
    return {
      nextIndex: u64(data),
      errorCode: view(data).getInt32(8, true),
      pending: !!view(data).getUint32(12, true),
      error: undefined,
      kind: 'path' as const,
    }
  }
  recoveryState(id: bigint | number = 0n) {
    this.assertOpen()
    if (this.factories.has(BigInt(id))) {
      const value = this.factoryState(BigInt(id))
      return {
        limit: value.limit,
        attempts: value.attempts,
        exhausted: value.exhausted,
        pending: value.retryPending,
        deadlineNs: value.deadlineNs,
      }
    }
    const data = storage(24)
    check(n.zc_video_output_recovery(this.handle, BigInt(id), ptr(data)))
    const d = view(data)
    return {
      limit: d.getUint32(0, true),
      attempts: d.getUint32(4, true),
      exhausted: !!d.getUint32(8, true),
      pending: !!d.getUint32(12, true),
      deadlineNs: u64(data, 16),
    }
  }

  private checkOutputMutation(id: bigint, configuring = false) {
    if (!configuring && this.factories.has(id))
      throw new CameraError(-4, 'output owned by factory')
    if (this.objectPreparations.has(id) || this.retiringOutputs.has(id))
      throw new CameraError(-4, 'output lifecycle pending')
  }
  private streamInfo(): OutputStreams {
    const length = new BigUint64Array(1)
    check(n.zc_video_get_headers(this.handle, null, 0, ptr(length)))
    const headers = storage(Number(length[0]))
    if (headers.length)
      check(
        n.zc_video_get_headers(
          this.handle,
          ptr(headers),
          BigInt(headers.length),
          ptr(length),
        ),
      )
    return describeStreams(this.options, headers)
  }
  private newBridge(
    output: CustomOutput,
    scope: OutputScope = { owner: this, id: Symbol() },
    options: RecorderOptions = this.options,
  ) {
    if (
      (output.format ?? 'packets') === 'mp4' &&
      options.audio &&
      typeof output.patch !== 'function'
    )
      throw new CameraError(-8, 'AAC output requires patch')
    return new OutputBridge(
      output,
      options.outputQueue ??
        (options.io
          ? {
              maxBytes: options.io.maxBytes,
              maxOperations: options.io.maxOperations,
              waitMs: options.io.waitMs,
            }
          : {}),
      scope,
    )
  }
  private setHostOutput(
    id: bigint,
    current: { bridge: OutputBridge; generation: bigint },
  ) {
    const active = this.objectOutputs.get(id)
    if (
      active?.bridge === current.bridge &&
      active.generation === current.generation
    )
      return
    if (!current.bridge.onRetired)
      this.bindBridge(id, current.generation, current.bridge)
    this.publishedHostOutputs.add(current.bridge)
    this.deliveryBridges.add(current.bridge)
    this.hostReports.delete(id)
    this.objectOutputs.set(id, current)
  }
  private bindBridge(id: bigint, generation: bigint, bridge: OutputBridge) {
    const session = this.sessionEpoch
    bridge.onRetired = (stats) => {
      this.deliveryBridges.delete(bridge)
      if (session !== this.sessionEpoch) return
      if (!this.publishedHostOutputs.has(bridge)) return
      const previous = this.hostReports.get(id)
      if (!previous || previous.generation <= generation) {
        this.hostReports.delete(id)
        this.hostReports.set(id, { id, generation, ...stats })
        if (this.hostReports.size > 8)
          this.hostReports.delete(this.hostReports.keys().next().value!)
      }
    }
    const report = (error: unknown) => {
      if (session !== this.sessionEpoch) return
      if (this.publishedHostOutputs.has(bridge)) this.deliveryFailure ??= error
      if (this.producerTurn) {
        this.deferredOutputFailures.add(() => report(error))
        return
      }
      if (this.handle && !this.closing) {
        const state = storage(24)
        if (
          n.zc_video_output_state(this.handle, id, ptr(state)) === 0 &&
          u64(state) === generation
        ) {
          this.outputErrors.set(id, error)
          n.zc_video_fail_output(this.handle, id, -6)
          queueMicrotask(() => this.scheduleFactories())
        }
      } else if (this.objectOutputs.get(id)?.bridge === bridge)
        this.outputErrors.set(id, error)
    }
    bridge.onError = report
  }
  private reconcileOutputs() {
    for (const [id, current] of this.objectOutputs) {
      const state = storage(24)
      if (
        n.zc_video_output_state(this.handle, id, ptr(state)) === 0 &&
        u64(state) === current.generation
      ) {
        const code = view(state).getInt32(8, true)
        if (code !== 0) current.bridge.fail(cameraError(code, 'native output'))
      }
    }
  }
  private objectJob<T>(
    operation: (job: BunJob<T>) => Promise<T>,
    options: JobOptions<T> = {},
    kind: 'native' | 'host' | 'producer' = 'native',
  ): BunJob<T> {
    this.admit(true)
    let job: BunJob<T>
    try {
      job = new BunJob<T>(
        async (current) => {
          if (kind === 'native') await this.producerIdle()
          current.check()
          return operation(current)
        },
        () => {
          this.tasks--
          this.objectJobs.delete(job)
          this.producerJobs.delete(job)
        },
        options,
      )
    } catch (error) {
      this.tasks--
      throw error
    }
    this.objectJobs.add(job)
    if (kind === 'producer') this.producerJobs.add(job)
    if (kind === 'producer') {
      const previous = this.producerTail
      this.producerTail = previous.then(() => job.operationDone)
      void previous.then(() => job.start())
    } else queueMicrotask(() => void job.start())
    return job
  }
  private attachObject<T>(
    output: CustomOutput,
    primary: boolean,
    options: JobOptions<T>,
  ) {
    if (primary) {
      this.checkOutputMutation(0n)
      const state = storage(24)
      if (n.zc_video_output_state(this.handle, 0n, ptr(state)) === 0)
        throw new CameraError(-4, 'primary already attached')
    }
    const lifecycle = this.objectJob<T>(async (job) => {
      job.check()
      let bridge: OutputBridge | undefined
      let attached = false
      let id = 0n
      try {
        bridge = this.newBridge(output, {
          owner: this,
          id: primary ? 0n : Symbol(),
        })
        await bridge.start(this.streamInfo())
        await this.producerIdle()
        job.check()
        this.assertOpen()
        if (primary) {
          check(
            n.zc_video_open_held_callbacks(this.handle, ptr(bridge.callbacks)),
          )
        } else {
          const result = new BigUint64Array(1)
          check(
            n.zc_video_add_callbacks(
              this.handle,
              ptr(bridge.callbacks),
              ptr(result),
            ),
          )
          id = result[0]
        }
        attached = true
        this.retiringOutputs.add(id)
        bridge.scope.id = id
        if (!primary) check(n.zc_video_hold_output(this.handle, id, 1))
        await bridge.enable()
        await bridge.drain()
        if (primary) {
          while (true) {
            job.check()
            await this.producerIdle()
            const code = n.zc_video_step_held_output(this.handle)
            if (code !== -3) check(code, 'pre-roll replay')
            await bridge.drain()
            job.check()
            await this.producerIdle()
            const publish = n.zc_video_publish_held_output(this.handle)
            if (publish === 0) break
            if (publish !== -3) check(publish, 'pre-roll publication')
            await pause()
          }
        } else {
          await this.producerIdle()
          job.check()
          check(n.zc_video_hold_output(this.handle, id, 0))
        }
        const current = storage(24)
        check(n.zc_video_output_state(this.handle, id, ptr(current)))
        this.bindBridge(id, u64(current), bridge)
        this.setHostOutput(id, { bridge, generation: u64(current) })
        job.seal()
        return (primary ? undefined : id) as T
      } catch (error) {
        await this.producerIdle()
        let secondary: unknown
        if (attached) {
          if (primary) n.zc_video_discard_held_output(this.handle)
          else n.zc_video_remove_output(this.handle, id)
          const state = storage(24)
          if (n.zc_video_output_state(this.handle, id, ptr(state)) === 0) {
            if (bridge)
              this.setHostOutput(id, { bridge, generation: u64(state) })
            throw error
          }
        }
        if (bridge)
          try {
            await bridge.retire(true)
          } catch (cleanup) {
            secondary = cleanup
          }
        if (
          job.cancelRequested &&
          error === job.cancellationReason &&
          secondary !== undefined
        )
          throw secondary
        throw error
      } finally {
        if (attached) this.retiringOutputs.delete(id)
      }
    }, options)
    if (primary) {
      this.objectPreparations.set(0n, lifecycle)
      void lifecycle.operationDone.then(() => {
        if (this.objectPreparations.get(0n) === lifecycle)
          this.objectPreparations.delete(0n)
      })
    }
    return lifecycle
  }
  private prepareObject(
    output: string | CustomOutput,
    id: bigint,
    recovery: boolean,
  ): PreparationJob {
    const state = storage(24)
    check(n.zc_video_output_state(this.handle, id, ptr(state)))
    const generation = u64(state),
      old = this.objectOutputs.get(id)
    let wrapper: PreparationJob
    const lifecycle = this.objectJob<void>((job) =>
      this.executePreparation(output, id, recovery, job, generation, old),
    )
    this.objectPreparations.set(id, lifecycle)
    void lifecycle.operationDone.then(() => {
      if (this.objectPreparations.get(id) === lifecycle)
        this.objectPreparations.delete(id)
    })
    wrapper = new PreparationJob(this, lifecycle, id, generation)
    this.jobs.add(wrapper)
    return wrapper
  }

  private async executePreparation(
    output: string | CustomOutput,
    id: bigint,
    recovery: boolean,
    job: BunJob<void>,
    generation: bigint,
    old: { bridge: OutputBridge; generation: bigint } | undefined,
    suppliedBridge?: OutputBridge,
    factoryTicket?: bigint,
  ) {
    let bridge: OutputBridge | undefined = suppliedBridge
    let native: Pointer | undefined
    let staged = false
    let committed = false
    let nativeDone = false
    try {
      await this.producerIdle()
      job.check()
      if (typeof output !== 'string' && !bridge) {
        bridge = this.newBridge(output, { owner: this, id })
      }
      if (bridge) {
        await bridge.start(this.streamInfo())
        job.check()
      }
      await this.producerIdle()
      this.assertOpen()
      const out = outPointer(),
        name = typeof output === 'string' ? cstring(output) : undefined
      check(
        factoryTicket !== undefined
          ? n.zc_video_prepare_factory(
              this.handle,
              id,
              factoryTicket,
              ptr(bridge!.callbacks),
              ptr(out),
            )
          : (bridge ? n.zc_video_prepare_held : n.zc_video_prepare_async)(
              this.handle,
              id,
              name ? ptr(name) : null,
              bridge ? ptr(bridge.callbacks) : null,
              recovery ? 1 : 0,
              ptr(out),
            ),
      )
      native = handle(out)
      if (bridge) {
        this.bindBridge(id, generation + 1n, bridge)
        this.pendingHostOutputs.set(id, {
          bridge,
          generation: generation + 1n,
        })
        await bridge.enable()
      }
      while (true) {
        await this.producerIdle()
        n.zc_video_poll_preparations(this.handle)
        const status = storage(32)
        check(n.zc_preparation_job_state_get(native, ptr(status)))
        const d = view(status)
        if (this.closing && staged) n.zc_preparation_job_abort_pending(native)
        if (job.cancelRequested && !staged) n.zc_preparation_job_cancel(native)
        if (bridge && d.getUint32(16, true) === 2 && !job.cancelRequested) {
          await bridge.drain()
          job.check()
          await this.producerIdle()
          check(n.zc_preparation_job_publish(native))
          // Publication is released at this serialized boundary. Capture may
          // stage it before this lifecycle loop runs again.
          job.seal()
        }
        if (d.getUint32(20, true) && !staged) {
          staged = true
          job.seal()
          this.retiringOutputs.add(id)
        }
        if (staged && !committed) {
          const active = storage(24)
          if (
            n.zc_video_output_state(this.handle, id, ptr(active)) === 0 &&
            u64(active) > generation
          ) {
            committed = true
            if (bridge)
              this.setHostOutput(id, {
                bridge,
                generation: generation + 1n,
              })
            else this.objectOutputs.delete(id)
          }
        }
        if (d.getUint32(24, true)) {
          nativeDone = true
          const code = d.getInt32(28, true)
          if (code === -5 && job.cancelRequested) job.check()
          check(code, 'output split')
          break
        }
        await pause()
      }
      if (old && committed) {
        try {
          await old.bridge.retire()
        } catch (error) {
          if (!recovery) throw error
          if (old.bridge.stopError !== undefined) throw old.bridge.stopError
        }
      }
    } catch (error) {
      if (native && !nativeDone) {
        await this.producerIdle()
        n.zc_preparation_job_cancel(native)
        while (true) {
          await this.producerIdle()
          if (this.closing && staged) n.zc_preparation_job_abort_pending(native)
          n.zc_video_poll_preparations(this.handle)
          const status = storage(32)
          n.zc_preparation_job_state_get(native, ptr(status))
          const d = view(status)
          if (d.getUint32(20, true) && !staged) {
            staged = true
          }
          const active = storage(24)
          if (
            staged &&
            n.zc_video_output_state(this.handle, id, ptr(active)) === 0 &&
            u64(active) > generation
          ) {
            committed = true
            if (bridge)
              this.setHostOutput(id, {
                bridge,
                generation: generation + 1n,
              })
            else this.objectOutputs.delete(id)
          }
          if (d.getUint32(24, true)) {
            nativeDone = true
            break
          }
          await pause()
        }
      }
      let cleanupError: unknown
      if (bridge && !committed)
        try {
          await bridge.retire(true)
        } catch (cleanup) {
          cleanupError = cleanup
        }
      if (old && committed)
        try {
          await old.bridge.retire()
        } catch (cleanup) {
          if (!recovery) cleanupError ??= cleanup
          else cleanupError ??= old.bridge.stopError
        }
      if (
        job.cancelRequested &&
        error === job.cancellationReason &&
        cleanupError !== undefined
      )
        throw cleanupError
      throw error
    } finally {
      await this.producerIdle()
      if (this.pendingHostOutputs.get(id)?.bridge === bridge)
        this.pendingHostOutputs.delete(id)
      if (native && nativeDone) n.zc_preparation_job_close(native)
      this.retiringOutputs.delete(id)
    }
  }

  protected factoryOutput(output: CustomOutput, _id: bigint): CustomOutput {
    return output
  }
  private factoryState(id: bigint) {
    const data = storage(72)
    check(n.zc_video_factory_state(this.handle, id, ptr(data)))
    const d = view(data)
    return {
      nextIndex: u64(data),
      ticket: u64(data, 8),
      index: u64(data, 16),
      generation: u64(data, 24),
      deadlineNs: u64(data, 32),
      errorCode: d.getInt32(40, true),
      kind: 'factory' as const,
      recovery: d.getUint32(44, true) === 2,
      pending: !!d.getUint32(48, true),
      attempts: d.getUint32(52, true),
      limit: d.getUint32(56, true),
      exhausted: !!d.getUint32(60, true),
      retryPending: !!d.getUint32(64, true),
      error: this.factories.get(id)?.error,
    }
  }
  private configureFactory(
    id: bigint,
    factory: OutputFactory,
    recovery: boolean,
    options: FactoryRotationOptions & FactoryRecoveryOptions,
  ) {
    this.checkOutputMutation(id, true)
    const previous = this.factories.get(id)
    if (previous?.job || previous?.stopping)
      throw new CameraError(-4, 'factory lifecycle pending')
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
    )
      throw new RangeError('invalid factory deadline')
    const config = storage(56),
      d = view(config)
    d.setUint32(0, 56, true)
    d.setUint32(4, recovery ? 2 : 1, true)
    d.setUint32(8, uint(options.maxAttempts ?? 3), true)
    d.setBigUint64(16, options.nextIndex ?? 1n, true)
    if (
      (options.nextIndex ?? 1n) < 0n ||
      (options.nextIndex ?? 1n) > 0xffffffffffffffffn
    )
      throw new RangeError('invalid factory index')
    d.setBigUint64(24, nanos(options.durationMs ?? 0), true)
    d.setBigUint64(
      32,
      BigInt(uint(options.maxBytes ?? 0, Number.MAX_SAFE_INTEGER)),
      true,
    )
    d.setBigUint64(40, nanos(options.retryDelayMs ?? 100), true)
    d.setBigUint64(48, nanos(options.maxDelayMs ?? 5000), true)
    check(n.zc_video_set_factory(this.handle, id, ptr(config)))
    this.factories.set(id, { factory, recovery, timeoutMs: options.timeoutMs })
    this.scheduleFactories()
  }
  private stopFactory(id: bigint, entry: FactoryEntry): Promise<void> {
    if (entry.stopping) return entry.stopping
    entry.job?.cancel(new CameraError(-5, 'factory stopped'))
    entry.stopping = (async () => {
      await entry.job?.operationDone
      await this.producerIdle()
      if (this.factories.get(id) !== entry) return
      if (this.handle && !this.closing)
        check(n.zc_video_set_factory(this.handle, id, null))
      this.factories.delete(id)
    })()
    return entry.stopping
  }
  private scheduleFactories() {
    if (
      this.coordinator ||
      this.schedulingFactories ||
      !this.handle ||
      this.closing ||
      this.producerTurn
    )
      return
    this.schedulingFactories = true
    try {
      for (const [id, entry] of this.factories) {
        if (
          entry.job ||
          entry.stopping ||
          this.tasks >= 16 ||
          this.objectPreparations.has(id) ||
          this.retiringOutputs.has(id)
        )
          continue
        const state = storage(72),
          code = n.zc_video_claim_factory(this.handle, id, ptr(state))
        if (code === -3) continue
        if (code !== 0) {
          entry.error ??= cameraError(code, 'factory claim')
          continue
        }
        const ticket = u64(state, 8),
          index = u64(state, 16),
          generation = u64(state, 24)
        let streams: OutputStreams
        try {
          streams = this.streamInfo()
        } catch (error) {
          n.zc_video_finish_factory(this.handle, id, ticket, -6)
          entry.error = error
          continue
        }
        let began = false
        let lifecycle: BunJob<void>
        try {
          lifecycle = this.objectJob<void>(
            async (job) => {
              began = true
              let candidate: CustomOutput | undefined,
                bridge: OutputBridge | undefined
              let result: unknown
              try {
                job.check()
                candidate = await invokeOutputFactory(() =>
                  entry.factory({
                    id,
                    index,
                    generation,
                    reason: entry.recovery ? 'recovery' : 'rotation',
                    signal: job.signal,
                    streams: {
                      ...streams,
                      headers: streams.headers.slice(),
                      audio: streams.audio ? { ...streams.audio } : undefined,
                    },
                  }),
                )
                candidate = this.factoryOutput(candidate, id)
                bridge = this.newBridge(candidate, { owner: this, id })
                await this.executePreparation(
                  candidate,
                  id,
                  entry.recovery,
                  job,
                  generation,
                  this.objectOutputs.get(id),
                  bridge,
                  ticket,
                )
              } catch (error) {
                result =
                  error === undefined
                    ? new Error('factory threw undefined')
                    : error
                if (candidate && !bridge) {
                  try {
                    await discardFactoryOutput(candidate)
                  } catch (cleanup) {
                    if (
                      job.cancelRequested &&
                      result === job.cancellationReason
                    )
                      result =
                        cleanup === undefined
                          ? new Error('factory cleanup threw undefined')
                          : cleanup
                  }
                }
              } finally {
                await this.producerIdle()
                const code = factoryFailureCode(
                  result,
                  job.cancelRequested && result === job.cancellationReason,
                )
                const finished = n.zc_video_finish_factory(
                  this.handle,
                  id,
                  ticket,
                  code,
                )
                if (finished !== 0 && result === undefined)
                  result = new CameraError(finished, 'factory completion')
                entry.error = result
              }
              if (result !== undefined) throw result
            },
            { timeoutMs: entry.timeoutMs },
          )
        } catch (error) {
          n.zc_video_finish_factory(this.handle, id, ticket, -6)
          entry.error = error
          continue
        }
        entry.job = lifecycle
        this.objectPreparations.set(id, lifecycle)
        void lifecycle.operationDone.then(async () => {
          if (this.producerTurn) await this.producerIdle()
          if (!began) {
            n.zc_video_finish_factory(
              this.handle,
              id,
              ticket,
              factoryFailureCode(lifecycle.error, lifecycle.cancelRequested),
            )
            entry.error = lifecycle.error
          }
          if (entry.job === lifecycle) entry.job = undefined
          if (this.objectPreparations.get(id) === lifecycle)
            this.objectPreparations.delete(id)
          // Further rotation/retry checks use the next supplied media-clock poll.
        })
      }
    } finally {
      this.schedulingFactories = false
    }
  }
  private snapshotObject(
    output: CustomOutput,
    options: JobOptions<void>,
  ): BunJob<void> {
    this.admit()
    let frozen: Pointer | undefined
    const release = () => {
      if (frozen) {
        n.zc_snapshot_close(frozen)
        frozen = undefined
      }
    }
    let started = false
    try {
      const streams = this.streamInfo(),
        out = outPointer()
      check(n.zc_video_freeze_callbacks(this.handle, ptr(out)))
      frozen = handle(out)
      const job = new BunJob<void>(
        async (current) => {
          started = true
          let bridge: OutputBridge | undefined,
            complete = false,
            result: unknown
          try {
            current.check()
            bridge = this.newBridge(output, { owner: {}, id: Symbol() })
            await bridge.start(streams)
            current.check()
            if (this.closed) {
              try {
                await this.closed
              } catch {}
            }
            current.check()
            await this.producerIdle()
            if (this.closing)
              throw new CameraError(-2, 'snapshot source close incomplete')
            check(
              n.zc_snapshot_open_callbacks(
                frozen!,
                this.handle || null,
                ptr(bridge.callbacks),
              ),
            )
            await bridge.enable()
            await bridge.drain()
            while (true) {
              current.check()
              const code = n.zc_snapshot_step(frozen!)
              if (code !== -3) check(code, 'snapshot replay')
              await bridge.drain()
              current.check()
              if (code === 0) break
              await pause()
            }
            current.seal()
            complete = true
          } catch (error) {
            result =
              error === undefined
                ? new Error('snapshot threw undefined')
                : error
          } finally {
            release()
            if (bridge)
              try {
                await bridge.retire(!complete)
              } catch (error) {
                if (
                  result === undefined ||
                  (current.cancelRequested &&
                    result === current.cancellationReason)
                )
                  result = error
              }
          }
          if (result !== undefined) throw result
        },
        () => {
          release()
          this.tasks--
        },
        options,
      )
      void job.operationDone.then(() => {
        if (!started) release()
      })
      queueMicrotask(() => void job.start())
      return job
    } catch (error) {
      release()
      this.tasks--
      throw error
    }
  }

  private admit(allowProducer = false) {
    this.assertOpen(allowProducer)
    if (this.tasks >= 16) throw new CameraError(-4, 'lifecycle queue')
    this.tasks++
  }
  sessionState() {
    this.assertOpen()
    return this.readSessionState()
  }
  private readSessionState() {
    const data = storage(16)
    check(n.zc_video_session_state(this.handle, ptr(data)))
    return {
      id: u64(data),
      phase: ['open', 'flushing', 'flushed', 'failed'][
        view(data).getUint32(8, true)
      ]!,
      errorCode: view(data).getInt32(12, true),
    }
  }
  /** @internal Reserve admission while existing copied producers finish. */
  [recordingOwner](camera: Camera, release = false, coordinated = false) {
    if (release) {
      if (this.capturingCamera === camera) this.capturingCamera = undefined
      return
    }
    if (coordinated) this.assertOwned(true)
    else this.assertOpen(true)
    if (this.capturingCamera)
      throw new CameraError(-4, 'recorder already attached to camera')
    this.capturingCamera = camera
  }
  [coordinateRecorder](
    job: Pick<BunJob<unknown>, 'cancel' | 'operationDone'>,
    camera: Camera,
  ) {
    this.assertOpen(true)
    if (
      (this.capturingCamera && this.capturingCamera !== camera) ||
      this.restartPending ||
      this.jobs.size ||
      this.factories.size ||
      [...this.objectJobs].some((j) => !j.done && !this.producerJobs.has(j))
    )
      throw new CameraError(-4, 'recorder lifecycle jobs active')
    this.coordinator = job
    const enter = <T>(operation: () => T): T => {
      this.coordinatorEntry = true
      try {
        return operation()
      } finally {
        this.coordinatorEntry = false
      }
    }
    return {
      pending: () => this.readProducerStats().ownedJobs !== 0n,
      flush: () => enter(() => this.flushAsync()),
      restart: (
        settings: RecorderOptions,
        output: string | CustomOutput | null,
        onPublished: () => void,
        beforePublish: () => void,
        onInstalled: () => void,
        group?: GroupRestartMember,
      ) =>
        enter(() =>
          this.restartSession(
            {
              ...settings,
              audio: settings.audio ?? null,
              colorSpace: settings.colorSpace ?? null,
              quality: settings.quality ?? null,
              encoder: settings.encoder ?? null,
              limits: settings.limits ?? null,
              repeatHeaders: settings.repeatHeaders ?? true,
            },
            output,
            {},
            onPublished,
            beforePublish,
            onInstalled,
            group,
          ),
        ),
      release: () => {
        if (this.coordinator === job) this.coordinator = undefined
      },
    }
  }
  /** Prepare and publish a fresh session after flush, retaining media settings. */
  restartAsync(
    output: string | CustomOutput | null = null,
    options: JobOptions<void> = {},
  ): BunJob<void> {
    return this.restartSession(undefined, output, options)
  }
  /** Replace session media settings after flush. Publication is atomic; failed
   * or cancelled preparation preserves the previous session and its settings. */
  reconfigureAsync(
    settings: RecorderSessionOptions,
    output: string | CustomOutput | null = null,
    options: JobOptions<void> = {},
  ): BunJob<void> {
    return this.restartSession(settings, output, options)
  }
  private restartSession(
    settings: RecorderSessionOptions | undefined,
    output: string | CustomOutput | null,
    options: JobOptions<void>,
    onPublished?: () => void,
    beforePublish?: () => void,
    onInstalled?: () => void,
    group?: GroupRestartMember,
  ): BunJob<void> {
    this.assertOpen(true)
    if (this.restartPending)
      throw new CameraError(-4, 'restart already pending')
    const candidate = mergeSessionOptions(this.options, settings)
    const config = settings ? sessionFields(candidate) : undefined
    // Snapshotting caller getters can close the owner or admit another job.
    this.assertOpen(true)
    if (this.restartPending)
      throw new CameraError(-4, 'restart already pending')
    if (config && candidate.audio && candidate.audio.bitrate === undefined) {
      // A file constructor may have resolved an implicit AAC default that is
      // absent from requested options. Preserve the actual recipe for an
      // unchanged audio format; explicit zero still selects automatic bitrate.
      const video = storage(32),
        audio = storage(24),
        bitrate = new Uint32Array(1)
      check(
        n.zc_video_session_config(
          this.handle,
          ptr(video),
          ptr(audio),
          ptr(bitrate),
        ),
        'inherited audio settings',
      )
      const previous = view(audio)
      if (
        previous.getUint32(4, true) === candidate.audio.sampleRate &&
        previous.getUint32(8, true) === candidate.audio.channels
      )
        config.bitrate = bitrate[0]
    }
    if (typeof output === 'string') guardHostPath(output)
    const name = typeof output === 'string' ? cstring(output) : undefined
    const out = outPointer()
    check(
      n.zc_video_producer_restart(
        this.handle,
        name ? 1 : output ? 2 : 0,
        name ? ptr(name) : null,
        ptr(out),
      ),
      'restart admission',
    )
    const native = handle(out)
    let owned = true
    const release = () => {
      if (owned) {
        check(n.zc_producer_job_close(native), 'restart cleanup')
        owned = false
      }
    }
    this.restartPending = true
    try {
      if (config)
        check(
          n.zc_producer_job_restart_configure(
            native,
            ptr(config.video),
            ptr(config.audio),
            config.bitrate,
          ),
          'session settings',
        )
      if (config)
        check(
          n.zc_producer_job_restart_color(
            native,
            config.color ? ptr(config.color) : null,
          ),
          'session color settings',
        )
      if (config)
        check(
          n.zc_producer_job_restart_repeat_headers(
            native,
            Number(config.repeatHeaders),
          ),
          'session packet headers',
        )
      if (config)
        check(
          n.zc_producer_job_restart_codec_options(native, ptr(config.encoder)),
          'session encoder settings',
        )
      if (config)
        check(
          n.zc_producer_job_restart_codec_limits(native, ptr(config.limits)),
          'session encoder limits',
        )
      if (typeof output === 'string' && this.options.io) {
        const io = this.options.io
        check(
          n.zc_producer_job_restart_io(
            native,
            BigInt(uint(io.maxBytes, 1024 ** 3)),
            uint(io.maxOperations, 65536),
            nanos(io.waitMs ?? 0),
          ),
        )
      }
      const lifecycle = this.objectJob<void>(
        async (job) => {
          await pause()
          job.check()
          this.assertOwned(true)
          const streams = describeStreams(candidate, new Uint8Array())
          let unlock!: () => void
          this.producerTurn = new Promise<void>((resolve) => {
            unlock = resolve
          })
          let started = false,
            finished = false,
            published = false,
            committed = false
          let bridge: OutputBridge | undefined
          let failure: unknown
          try {
            check(n.zc_producer_job_start(native), 'restart start')
            started = true
            job.setCancellationGuard(
              () => n.zc_producer_job_cancel(native) === 0,
            )
            const code = new Int32Array(1),
              stage = new Uint32Array(1)
            while (true) {
              const state = n.zc_producer_job_finish(native, ptr(code))
              if (state !== -3) {
                check(state, 'restart completion')
                finished = true
                if (code[0] === -10) job.check()
                check(code[0], 'restart preparation')
                committed = true
                break
              }
              check(n.zc_producer_job_restart_stage(native, ptr(stage)))
              if (
                !published &&
                stage[0] >= 1 &&
                typeof output !== 'string' &&
                output &&
                !bridge
              ) {
                job.check()
                const headers = storage(8192),
                  count = new Uint32Array(1)
                check(
                  n.zc_producer_job_restart_headers(
                    native,
                    ptr(headers),
                    headers.length,
                    ptr(count),
                  ),
                )
                bridge = this.newBridge(
                  output,
                  { owner: this, id: 0n },
                  candidate,
                )
                await bridge.start({
                  ...streams,
                  headers: headers.slice(0, count[0]),
                })
                job.check()
                check(
                  n.zc_producer_job_restart_bind(native, ptr(bridge.callbacks)),
                )
                await bridge.enable()
              }
              if (!published && stage[0] === 2) {
                if (bridge) await bridge.drain()
                job.check()
                if (bridge?.error !== undefined) throw bridge.error
                if (group)
                  await group.group.prepared(group.index, native, () => {
                    job.check()
                    if (bridge?.error !== undefined) throw bridge.error
                  })
                else {
                  beforePublish?.()
                  check(
                    n.zc_producer_job_restart_publish(native),
                    'restart publication',
                  )
                }
                published = true
                job.seal()
                onPublished?.()
              }
              await pause()
            }
            const old = [...this.deliveryBridges]
            const install = () => {
              try {
                this.currentOptions = candidate
                if (config) this.recordingColorBytes = config.color
                onInstalled?.()
                this.sessionEpoch = this.readSessionState().id
                this.objectOutputs.clear()
                this.deliveryBridges.clear()
                this.factories.clear()
                this.outputErrors.clear()
                this.hostReports.clear()
                this.deliveryFailure = undefined
                this.finalStats = undefined
                if (bridge) {
                  const state = storage(24)
                  check(n.zc_video_output_state(this.handle, 0n, ptr(state)))
                  this.setHostOutput(0n, { bridge, generation: u64(state) })
                }
              } catch (error) {
                failure ??= error
              }
            }
            if (group) await group.group.installed(group.index, install)
            else install()
            for (const previous of old) {
              try {
                await previous.retire()
              } catch (error) {
                if (previous.stopError !== undefined) failure ??= error
              }
            }
            if (failure !== undefined) throw failure
          } catch (error) {
            failure = error
            if (started && !finished) {
              if (!published) n.zc_producer_job_cancel(native)
              const code = new Int32Array(1)
              while (n.zc_producer_job_finish(native, ptr(code)) === -3)
                await pause()
              finished = true
            }
            if (bridge && !committed) {
              try {
                await bridge.retire(true)
              } catch (cleanup) {
                if (bridge.stopError !== undefined) failure = cleanup
              }
            }
            throw failure
          } finally {
            job.setCancellationGuard(undefined)
            if (!started || finished) release()
            this.producerTurn = undefined
            unlock()
            const failures = [...this.deferredOutputFailures]
            this.deferredOutputFailures.clear()
            for (const fail of failures) fail()
            this.restartPending = false
            if (!this.closing) {
              this.reconcileOutputs()
              this.scheduleFactories()
            }
          }
        },
        options,
        'producer',
      )
      void lifecycle.operationDone.then(() => {
        release()
        this.restartPending = false
      })
      return lifecycle
    } catch (error) {
      release()
      this.restartPending = false
      throw error
    }
  }
  /** Join preceding producers and acknowledge every emitted output prefix. */
  drainRecordingAsync(options: JobOptions<void> = {}): BunJob<void> {
    return this.recordingBarrier(false, options)
  }
  /** Terminally flush codec/container tails and acknowledge all output. */
  flushAsync(options: JobOptions<void> = {}): BunJob<void> {
    return this.recordingBarrier(true, options)
  }
  private recordingBarrier(flush: boolean, options: JobOptions<void>) {
    this.assertOpen(true)
    const out = outPointer()
    check(
      n.zc_video_producer_barrier(this.handle, Number(flush), ptr(out)),
      'recording barrier admission',
    )
    return this.queueProducer(handle(out), options, flush ? 'flush' : 'drain')
  }
  /** Wait for copied inputs admitted so far to finish cleanup, regardless of
   * their individual results. Does not wait for output acknowledgements. */
  drainProducersAsync(options: JobOptions<void> = {}): BunJob<void> {
    this.assertOpen(true)
    const out = outPointer()
    check(n.zc_video_producer_drain(this.handle, ptr(out)), 'producer drain')
    const native = handle(out)
    let owned = true
    const release = () => {
      if (owned) {
        n.zc_producer_drain_close(native)
        owned = false
      }
    }
    try {
      const lifecycle = this.objectJob<void>(
        async (job) => {
          try {
            while (true) {
              job.check()
              const code = n.zc_producer_drain_poll(native)
              if (code === -3) {
                await pause()
                continue
              }
              check(code, 'producer drain')
              job.seal()
              return
            }
          } finally {
            release()
          }
        },
        options,
        'host',
      )
      void lifecycle.operationDone.then(release)
      return lifecycle
    } catch (error) {
      release()
      throw error
    }
  }
  async drain(id: bigint | number = 0n) {
    this.admit()
    const out = outPointer()
    const bridge = this.objectOutputs.get(BigInt(id))?.bridge,
      prefix = bridge?.prefix()
    try {
      check(n.zc_video_drain_output_async(this.handle, BigInt(id), ptr(out)))
      const result = await nativeTask('drain', handle(out))
      check(result.code, 'drain')
      if (bridge) await bridge.drain(prefix)
    } finally {
      this.tasks--
    }
  }
  snapshot(path: string): Promise<void>
  snapshot(output: CustomOutput, options?: JobOptions<void>): BunJob<void>
  snapshot(
    output: string | CustomOutput,
    options: JobOptions<void> = {},
  ): Promise<void> | BunJob<void> {
    return typeof output === 'string'
      ? this.snapshotPath(output)
      : this.snapshotObject(output, options)
  }
  private async snapshotPath(path: string) {
    this.admit()
    try {
      guardHostPath(path)
      const name = cstring(path),
        out = outPointer()
      check(n.zc_video_freeze_buffer(this.handle, ptr(name), ptr(out)))
      const result = await nativeTask('snapshot', handle(out))
      check(result.code, 'snapshot')
    } finally {
      this.tasks--
    }
  }
  close(): Promise<void> {
    guardOutputHook()
    if (this.closed) return this.closed
    if (!this.handle) return Promise.resolve()
    this.closing = true
    this.closed = (async () => {
      const coordinator = this.coordinator
      if (coordinator) {
        coordinator.cancel(new CameraError(-2, 'recorder closed'))
        await coordinator.operationDone
      }
      const objectJobs = [...this.objectJobs]
      for (const job of objectJobs)
        job.cancel(new CameraError(-2, 'recorder closed'))
      await Promise.all(objectJobs.map((job) => job.operationDone))
      this.factories.clear()
      this.finalStats = this.readRecordingStats()
      this.finalProducerStats = this.readProducerStats()
      let result: Awaited<ReturnType<typeof nativeTask>>
      try {
        result = await nativeTask('close', this.handle)
      } catch (error) {
        if (error instanceof TaskDispatchError) {
          this.closing = false
          this.closed = undefined
        }
        throw error
      }
      if (result.code === -4 && result.count === 0) {
        this.closing = false
        this.closed = undefined
        check(result.code, 'recorder close')
      }
      this.handle = 0 as Pointer
      if (result.results) {
        for (let i = 0; i < result.count; i++) {
          const data = result.results.subarray(i * 32, (i + 1) * 32)
          const code = view(data).getInt32(16, true)
          if (code) this.outputErrors.set(u64(data), code)
        }
      }
      let hookFailure: unknown
      for (const [id, current] of this.objectOutputs) {
        try {
          await current.bridge.retire()
        } catch (error) {
          this.outputErrors.set(id, error)
          if (current.bridge.stopError !== undefined || !this.options.isolate)
            hookFailure ??= current.bridge.stopError ?? error
        }
      }
      this.objectOutputs.clear()
      this.closing = false
      check(result.code, 'recorder close')
      if (hookFailure !== undefined) throw hookFailure
    })()
    return this.closed
  }
  async [Symbol.asyncDispose]() {
    await this.close()
  }
}
export class AudioCapture {
  [audioGroupView]?: SharedAudio
  sharedStats(): SharedAudioStats | undefined {
    return this[audioGroupView]?.stats()
  }
  readonly sharedBufferFrames: number
  readonly sharedMaxBlocks: number
  handle: Pointer
  readonly sampleRate: number
  readonly channels: number
  readonly blockFrames: number
  constructor({
    simulate = false,
    sampleRate = 48000,
    channels = 1,
    blockFrames = 1024,
    startNs = 0n,
    device = 'default',
    sharedHistory,
  }: {
    simulate?: boolean
    sampleRate?: number
    channels?: number
    blockFrames?: number
    startNs?: bigint
    device?: string
    sharedHistory?: { maxFrames?: number; maxBlocks?: number }
  } = {}) {
    this.sampleRate = sampleRate
    this.channels = channels
    this.blockFrames = blockFrames
    this.sharedBufferFrames = uint(
      sharedHistory?.maxFrames ?? sampleRate * 2,
      sampleRate * 10,
    )
    this.sharedMaxBlocks = uint(sharedHistory?.maxBlocks ?? 256, 256)
    if (this.sharedBufferFrames < blockFrames || !this.sharedMaxBlocks)
      throw new RangeError('invalid shared audio history')
    const cfg = fields(32, n.zc_default_audio_config, [
      undefined,
      simulate ? 0 : 1,
      sampleRate,
      channels,
      blockFrames,
    ])
    view(cfg).setBigUint64(24, startNs, true)
    const out = outPointer(),
      name = cstring(device)
    check(n.zc_audio_open(ptr(cfg), ptr(name), ptr(out)))
    this.handle = handle(out)
  }
  read(timeoutMs = 0) {
    if (!this.handle) throw new CameraError(-2, 'closed audio')
    const data = storage(this.blockFrames * this.channels * 2),
      meta = storage(24)
    check(
      n.zc_audio_read(
        this.handle,
        ptr(data),
        BigInt(data.length),
        uint(timeoutMs),
        ptr(meta),
      ),
    )
    return {
      data: data.subarray(
        0,
        view(meta).getUint32(16, true) * this.channels * 2,
      ),
      timestampNs: u64(meta),
      clockErrorNs: view(meta).getBigInt64(8, true),
    }
  }
  close() {
    if (this.handle) {
      check(n.zc_audio_close(this.handle))
      this.handle = 0 as Pointer
    }
  }
  [Symbol.dispose]() {
    this.close()
  }
}
export class Recording {
  [recordingRecovery]() {
    return {
      camera: this.camera,
      audio: this.audio,
      fps: this.fps,
      retained: this.retainedRecorder,
      closed: !!this.closeJob,
    }
  }
  [consumerState]?: CaptureConsumerStats
  private originFrame?: bigint;
  [audioState]?: AudioConsumerStats
  audioStats() {
    return this.audio ? this.camera[recordingAudioState](this) : undefined
  }
  stats() {
    return this.camera.recordingState(this)
  }
  frames = 0
  error: unknown
  private stopped = false
  private closeJob?: Promise<void>
  private flushJob?: BunJob<void>
  private retainedRecorder = false
  get closing() {
    return this.stopped
  }
  constructor(
    private camera: Camera,
    readonly recorder: Recorder,
    private audio: AudioCapture | undefined,
    private fps: number,
    readonly backpressure: RecordingBackpressure = 'wait',
  ) {}
  private inputs(frame: Frame, offered?: bigint) {
    if (this.stopped) throw new CameraError(-2, 'recording stopped')
    if (offered !== undefined) this.originFrame ??= offered
    const index =
      offered === undefined ? BigInt(this.frames) : offered - this.originFrame!
    const fallback =
      this.camera.info().backend === 0
        ? (index * 1_000_000_000n) / BigInt(this.fps)
        : frame.timestampNs
    const timestamp = this.camera[recordingTimestamp](this, offered, fallback)
    const audio = this.camera[prepareRecordingAudio](
      this,
      timestamp,
      offered === undefined,
    )
    return { timestamp, audio }
  }
  write(frame: Frame, offered?: bigint) {
    const { timestamp, audio } = this.inputs(frame, offered)
    let accepted = false
    try {
      if (audio) this.recorder[writeSharedAudio](frame, audio, timestamp, false)
      else this.recorder.write(frame, timestamp)
      this.frames++
      accepted = true
    } finally {
      audio?.finish(accepted)
    }
  }
  writeAsync(frame: Frame, offered?: bigint): Promise<void> {
    const { timestamp, audio } = this.inputs(frame, offered)
    let accepted = false
    try {
      const job = audio
        ? this.recorder[writeSharedAudio](frame, audio, timestamp, true)
        : this.recorder.writeAVAsync(frame, [], timestamp)
      this.frames++
      accepted = true
      return Promise.resolve(job)
    } finally {
      audio?.finish(accepted)
    }
  }
  requestKeyframe() {
    if (this.stopped || this.closeJob)
      throw new CameraError(-2, 'recording stopped')
    this.recorder.requestKeyframe()
  }
  requestKeyframeAsync(options: JobOptions<void> = {}): BunJob<void> {
    if (this.stopped || this.closeJob)
      throw new CameraError(-2, 'recording stopped')
    return this.recorder.requestKeyframeAsync(options)
  }
  split(output: string | CustomOutput, id: bigint | number = 0n) {
    return this.recorder.split(output, id)
  }
  switchModeAsync(
    camera: CameraOptions,
    settings: RecorderSessionOptions = {},
    output: string | CustomOutput | null = null,
    options: RecordingModeOptions = {},
  ): BunJob<Recording> {
    if (this.stopped || this.closeJob)
      throw new CameraError(-2, 'recording stopped')
    return this.camera.switchRecordingModeAsync(
      this.recorder,
      camera,
      settings,
      output,
      options,
    )
  }
  [coordinatedFlush](flush: () => BunJob<void>): BunJob<void> {
    return this.flushOwned(flush)
  }
  /** Stop this camera/audio pump and flush, leaving the recorder reusable. */
  flushAsync(options: JobOptions<void> = {}): BunJob<void> {
    this.recorder.assertOpen(true)
    return this.flushOwned(() => this.recorder.flushAsync(options))
  }
  private flushOwned(flush: () => BunJob<void>): BunJob<void> {
    guardOutputHook()
    if (this.closeJob) throw new CameraError(-2, 'recording closed')
    if (
      this.flushJob &&
      (!this.flushJob.done || this.flushJob.error === undefined)
    )
      return this.flushJob
    const job = flush()
    this[adoptCoordinatedFlush](job)
    return job
  }
  [adoptCoordinatedFlush](job: BunJob<void>) {
    this.flushJob = job
    this.stopped = true
    this.retainedRecorder = true
    this.camera.detach(this)
  }
  close() {
    guardOutputHook()
    if (this.closeJob) return this.closeJob
    this.stopped = true
    this.camera.detach(this)
    this.closeJob = (async () => {
      let failure = this.error
      try {
        if (this.retainedRecorder) await this.flushJob?.operationDone
        else await this.recorder.close()
      } catch (error) {
        failure ??= error
      }
      await this.camera.pendingRecording(this)
      failure ??= this.error
      if (failure) throw failure
    })()
    return this.closeJob
  }
}

export interface CircularOutput2Options extends RecorderOptions {
  bufferDurationMs?: number
  pts?: PtsStream
}
/** Delayed Home A/V output with a shared PTS observer across segment epochs. */
export class CircularOutput2 extends Recorder {
  private duration: number
  private pts?: PtsStream
  constructor(options: CircularOutput2Options) {
    const duration =
      options.bufferDurationMs ?? options.circular?.delayMs ?? 5000
    nanos(duration)
    super(null, {
      ...options,
      circular: {
        maxFrames: options.circular?.maxFrames ?? 300,
        maxBytes: options.circular?.maxBytes ?? 64 * 1024 * 1024,
        durationMs: options.circular?.durationMs ?? Math.max(duration, 1),
        delayMs: duration,
      },
    })
    this.duration = duration
    this.pts = options.pts
  }
  get bufferDurationMs() {
    return this.duration
  }
  set bufferDurationMs(value: number) {
    this.assertOpen()
    check(n.zc_video_set_delay(this.handle, nanos(value)))
    this.duration = value
  }
  protected override factoryOutput(output: CustomOutput, id: bigint) {
    return id === 0n ? this.observed(output) : output
  }
  private observed(output: CustomOutput | string) {
    if (output instanceof PtsOutput) return output
    if (typeof output === 'string' && !/\.(mp4|mkv)$/i.test(output))
      throw new CameraError(-8, 'circular output container')
    const sink =
      typeof output === 'string'
        ? new MuxedOutput(
            output,
            output.toLowerCase().endsWith('.mp4') ? 'mp4' : 'mkv',
          )
        : output
    return this.pts ? new PtsOutput(sink, this.pts) : sink
  }
  override openOutput(
    output: string | CustomOutput,
    options: JobOptions<void> = {},
  ) {
    this.assertOpen()
    return super.openOutput(this.observed(output), options)
  }
  closeOutput() {
    return this.removeOutput(0n)
  }
  override split(output: string | CustomOutput, id: bigint | number = 0n) {
    this.assertOpen()
    return super.split(BigInt(id) === 0n ? this.observed(output) : output, id)
  }
  override recover(output: string | CustomOutput, id: bigint | number = 0n) {
    this.assertOpen()
    return super.recover(BigInt(id) === 0n ? this.observed(output) : output, id)
  }
}
