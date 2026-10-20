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
import { BunJob, type JobOptions } from './jobs'
import { cameraConfiguration, copyConfiguration } from './config'
import type { ModeRequest, ModeResponse } from './mode-worker'
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
  type Pointer,
} from './ffi'
export { CameraError } from './ffi'
const recordingOwner = Symbol('recordingOwner')
const coordinateRecorder = Symbol('coordinateRecorder')
const coordinatedFlush = Symbol('coordinatedFlush')
export interface RecordingModeOptions extends JobOptions<Recording> {
  dropFrames?: number
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
function text(data: Uint8Array, offset = 0, length = data.length - offset) {
  const slice = data.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end))
}
function state(data: Uint8Array) {
  return {
    generation: u64(data),
    errorCode: view(data).getInt32(8, true),
    splitState: view(data).getUint32(12, true),
    pending: !!view(data).getUint32(16, true),
  }
}
function decodeMetadata(data: Uint8Array) {
  const d = view(data)
  return {
    eventId: u64(data, 8),
    sequence: u64(data, 16),
    timestampNs: u64(data, 24),
    controlRevision: u64(data, 32),
    exposureUs: d.getUint32(40, true),
    afState: d.getInt32(44, true),
    analogueGain: d.getFloat32(56, true),
    lensPosition: d.getFloat32(60, true),
    frameDurationUs: u64(data, 72),
  }
}
class ModeWorkerFault extends Error {}
function runModeWorker(request: ModeRequest): Promise<ModeResponse> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./mode-worker.ts', import.meta.url).href)
    } catch (error) {
      reject(error)
      return
    }
    worker.onmessage = (event) => {
      resolve(event.data)
      worker.terminate()
    }
    worker.onerror = (event) => {
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

export interface CameraOptions {
  simulate?: boolean
  width?: number
  height?: number
  buffers?: number
  cameraIndex?: number
  fifo?: boolean
  raw?: boolean
  unpackedRaw?: boolean
  rawFormat?: string
  role?: 'still' | 'preview' | 'video'
  sensor?: { width: number; height: number; bitDepth: number }
  lores?: { width: number; height: number; rgb?: boolean }
}
export class Frame {
  private released = false
  constructor(
    private camera: Camera,
    readonly descriptor: Uint8Array,
  ) {}
  private open() {
    if (this.released) throw new CameraError(-5, 'released frame')
    this.camera.assertOpen()
  }
  get sequence() {
    return u64(this.descriptor, 8)
  }
  get timestampNs() {
    return u64(this.descriptor, 16)
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
  copyRGB() {
    this.open()
    const data = storage(this.width * this.height * 3)
    check(n.zc_copy_rgb(ptr(this.descriptor), ptr(data), BigInt(data.length)))
    return data
  }
  copyStream(stream: 'main' | 'raw' | 'lores' = 'main') {
    this.open()
    const data = storage(208)
    check(
      n.zc_get_stream(
        this.camera.handle,
        this.token,
        { main: 0, raw: 1, lores: 2 }[stream],
        ptr(data),
      ),
    )
    const d = view(data),
      width = d.getUint32(0, true),
      height = d.getUint32(4, true)
    const format = text(data, 16, 32)
    if (format !== 'BGR888' && format !== 'YUV420')
      throw new CameraError(-8, 'packed stream')
    const out = storage(width * height * (format === 'YUV420' ? 1.5 : 3))
    check(n.zc_copy_stream(ptr(data), ptr(out), BigInt(out.length)))
    return { width, height, format, data: out }
  }
  metadata() {
    this.open()
    const data = storage(96)
    check(n.zc_get_frame_metadata(this.camera.handle, this.token, ptr(data)))
    const d = view(data)
    return {
      eventId: u64(data, 8),
      sequence: u64(data, 16),
      timestampNs: u64(data, 24),
      controlRevision: u64(data, 32),
      exposureUs: d.getUint32(40, true),
      afState: d.getInt32(44, true),
      analogueGain: d.getFloat32(56, true),
      lensPosition: d.getFloat32(60, true),
      frameDurationUs: u64(data, 72),
    }
  }
  saveJPEG(path: string, quality = 98) {
    this.open()
    const name = cstring(path)
    check(
      n.zc_save_jpeg(this.camera.handle, this.token, ptr(name), uint(quality)),
    )
  }
  saveDNG(path: string) {
    this.open()
    const name = cstring(path)
    check(n.zc_save_dng(this.camera.handle, this.token, ptr(name)))
  }
  release() {
    if (this.released) return
    check(n.zc_release(this.camera.handle, this.token))
    this.released = true
  }
  [Symbol.dispose]() {
    this.release()
  }
}
type CaptureRequest = {
  operation: (frame: Frame) => unknown
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  deadline: number
  signal?: AbortSignal
}
export class Camera {
  handle: Pointer
  private started = false
  private closing = false
  private stopJob?: Promise<void>
  private closeJob?: Promise<void>
  private failedRecordings = new Set<Recording>()
  private recording?: Recording
  private previewHandle = 0 as Pointer
  private timer?: ReturnType<typeof setTimeout>
  private pumping = false
  private requests: CaptureRequest[] = []
  private focusJobs = 0
  private configuration: CameraOptions
  private modeActive = false
  private coordinatedRecorder?: Recorder
  private coordinatedInitial?: Recording
  private modeJobs = new Set<{
    cancel: (reason?: unknown) => boolean
    done: boolean
    cleanupDone: Promise<void>
    operationDone: Promise<void>
  }>()
  private modeTail: Promise<void> = Promise.resolve()
  private previewTitle?: string
  get options() {
    return copyConfiguration(this.configuration)
  }
  constructor(options: CameraOptions = {}) {
    this.configuration = copyConfiguration(options)
    const { config: cfg, pipeline } = cameraConfiguration(options)
    const out = outPointer()
    check(n.zc_open_pipeline(ptr(cfg), ptr(pipeline), ptr(out)), 'open camera')
    this.handle = handle(out)
    if ((options.simulate ?? false) !== (this.info().backend === 0)) {
      n.zc_close(this.handle)
      this.handle = 0 as Pointer
      throw new CameraError(-8, 'synthetic backend unavailable')
    }
  }
  assertOpen() {
    guardOutputHook()
    if (this.coordinatedRecorder)
      throw new CameraError(-4, 'coordinated recording mode pending')
    if (this.modeActive) throw new CameraError(-4, 'mode change active')
    if (!this.handle || this.closing || this.stopJob)
      throw new CameraError(-2, 'camera unavailable')
  }
  info() {
    this.assertOpen()
    return this.readInfo()
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
      cameraId: text(d, 424, 256),
    }
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
    this.assertOpen()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    if (!this.started) {
      check(n.zc_start(this.handle))
      this.started = true
    }
  }
  acquire(timeoutMs = 0) {
    this.assertOpen()
    const data = storage(456)
    check(n.zc_acquire(this.handle, uint(timeoutMs), ptr(data)), 'acquire')
    return new Frame(this, data)
  }
  setControls(
    controls: {
      id: number
      type: 'bool' | 'int' | 'float' | 'rect'
      values: number[]
    }[],
  ) {
    this.assertOpen()
    if (!controls.length || controls.length > 32)
      throw new RangeError('1..32 controls required')
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
    check(
      n.zc_set_controls(this.handle, ptr(d), controls.length, ptr(revision)),
    )
    return revision[0]
  }
  async autofocus({
    signal,
    timeoutMs = 5000,
  }: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    this.assertOpen()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    this.start()
    const id = new BigUint64Array(1)
    check(n.zc_autofocus_start(this.handle, ptr(id)))
    this.focusJobs++
    this.ensurePump()
    const deadline = performance.now() + timeoutMs
    try {
      while (true) {
        this.assertOpen()
        if (signal?.aborted || performance.now() >= deadline) {
          check(n.zc_autofocus_cancel(this.handle, id[0]))
          throw signal?.reason ?? new CameraError(-3, 'autofocus')
        }
        const result = new Uint32Array(1)
        const code = n.zc_autofocus_wait(this.handle, id[0], 0, ptr(result))
        if (code === 0) return result[0]
        if (code !== -3) check(code)
        await pause()
      }
    } finally {
      this.focusJobs--
    }
  }
  capture<T>(
    operation: (frame: Frame) => T,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    this.assertOpen()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    if (this.requests.length >= 32) throw new CameraError(-4, 'capture queue')
    this.start()
    const result = new Promise<T>((resolve, reject) =>
      this.requests.push({
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
        deadline: performance.now() + (options.timeoutMs ?? 5000),
        signal: options.signal,
      }),
    )
    this.ensurePump()
    return result
  }
  captureRGB(options?: { timeoutMs?: number; signal?: AbortSignal }) {
    return this.capture((frame) => frame.copyRGB(), options)
  }
  captureMetadata(options?: { timeoutMs?: number; signal?: AbortSignal }) {
    return this.capture((frame) => frame.metadata(), options)
  }
  startPreview(title = 'zig-camera') {
    this.assertOpen()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    if (this.previewHandle) throw new CameraError(-4, 'preview already active')
    const info = this.info(),
      name = cstring(title),
      out = outPointer()
    check(n.zc_preview_open(ptr(name), info.width, info.height, ptr(out)))
    this.previewHandle = handle(out)
    this.previewTitle = title
    this.start()
    this.ensurePump()
  }
  stopPreview() {
    guardOutputHook()
    if (this.modeActive) throw new CameraError(-4, 'mode change active')
    this.stopPreviewOwned()
  }
  private stopPreviewOwned() {
    if (this.previewHandle) {
      check(n.zc_preview_close(this.previewHandle))
      this.previewHandle = 0 as Pointer
      this.previewTitle = undefined
    }
  }
  startRecording(
    recorder: Recorder,
    options: { fps?: number; audio?: AudioCapture } = {},
  ) {
    this.assertOpen()
    if (this.hasPendingModes()) throw new CameraError(-4, 'mode jobs pending')
    if (this.recording) throw new CameraError(-4, 'recording active')
    if (recorder.sessionState().phase !== 'open')
      throw new CameraError(-2, 'recorder session must be open')
    const info = this.info()
    if (info.width !== recorder.width || info.height !== recorder.height)
      throw new RangeError('recorder geometry mismatch')
    if (options.audio) {
      const format = recorder.options.audio
      if (
        !format ||
        options.audio.sampleRate !== format.sampleRate ||
        options.audio.channels !== format.channels
      )
        throw new RangeError(
          'audio capture format differs from recorder session',
        )
    }
    recorder[recordingOwner](this)
    try {
      this.start()
    } catch (error) {
      recorder[recordingOwner](this, true)
      throw error
    }
    const recording = new Recording(
      this,
      recorder,
      options.audio,
      options.fps ?? recorder.fps,
    )
    this.recording = recording
    this.ensurePump()
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
    this.assertOpen()
    if (
      this.hasPendingModes() ||
      this.requests.length ||
      this.focusJobs ||
      this.failedRecordings.size
    )
      throw new CameraError(-4, 'camera jobs active')
    if (this.modeJobs.size + this.requests.length >= 32)
      throw new CameraError(-4, 'mode queue')
    if (this.recording && this.recording.recorder !== recorder)
      throw new CameraError(-4, 'camera records a different recorder')
    if (
      (options.simulate !== undefined &&
        options.simulate !== (this.configuration.simulate ?? false)) ||
      (options.cameraIndex !== undefined &&
        options.cameraIndex !== (this.configuration.cameraIndex ?? 0))
    )
      throw new CameraError(-1, 'mode must retain camera/backend')
    const target = copyConfiguration({
      ...options,
      simulate: this.configuration.simulate,
      cameraIndex: this.configuration.cameraIndex,
    })
    const encoded = cameraConfiguration(target),
      dropFrames = uint(jobOptions.dropFrames ?? 0)
    if (typeof output === 'string') guardHostPath(output)
    const exact =
      (settings.width !== undefined ? 1 : 0) |
      (settings.height !== undefined ? 2 : 0)
    const proposed = mergeSessionOptions(recorder.options, settings)
    const candidate = resolvedSession(
      proposed,
      target.width ?? proposed.width,
      target.height ?? proposed.height,
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
    const effective = {
      ...jobOptions,
      timeoutMs: jobOptions.timeoutMs ?? 10000,
    }
    const deadline = Date.now() + effective.timeoutMs
    const initialRecording = this.recording
    let reservation: ReturnType<Recorder[typeof coordinateRecorder]> | undefined
    let claimed = false
    const release = () => {
      reservation?.release()
      if (this.coordinatedRecorder === recorder) {
        this.coordinatedRecorder = undefined
        this.coordinatedInitial = undefined
      }
      if (
        !this.closing &&
        !this.stopJob &&
        (this.previewHandle || this.recording)
      )
        this.ensurePump()
    }
    const job = new BunJob<Recording>(
      async (current) => {
        claimed = true
        const previous = this.options,
          old = cameraConfiguration(previous)
        const started = this.started,
          title = this.previewTitle
        let response: ModeResponse | undefined,
          published = false,
          resumed: Recording | undefined
        let failure: unknown
        const preview = () => {
          if (!title || !this.handle || this.closing || this.stopJob) return
          const info = this.readInfo(),
            name = cstring(title),
            out = outPointer()
          check(n.zc_preview_open(ptr(name), info.width, info.height, ptr(out)))
          this.previewHandle = handle(out)
          this.previewTitle = title
        }
        const attach = () => {
          if (resumed) return
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
          resumed = new Recording(this, recorder, audio, recorder.fps)
          this.recording = resumed
        }
        try {
          current.check()
          const stats = storage(40)
          check(n.zc_get_stats(this.handle, ptr(stats)))
          if (
            view(stats).getUint32(36, true) ||
            this.recording !== initialRecording
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
          const flush = initialRecording
            ? initialRecording[coordinatedFlush](reservation!.flush)
            : reservation!.flush()
          await flush
          current.check()
          this.stopPreviewOwned()
          response = await runModeWorker({
            handle: this.handle,
            ...encoded,
            previousConfig: old.config,
            previousPipeline: old.pipeline,
            previousStarted: started,
            cancel: current.cancellation,
            deadline,
            dropFrames,
          })
          this.handle = response.handle
          this.started = response.started
          if (Date.now() >= deadline && !current.cancelRequested)
            current.cancel(new CameraError(-3, 'mode deadline'))
          if (response.restoreCode)
            throw Object.assign(
              new CameraError(
                response.code || response.restoreCode,
                'mode restoration',
              ),
              { restoreCode: response.restoreCode },
            )
          if (response.code === -5 && current.cancelRequested) current.check()
          check(response.code, 'recording camera mode')
          current.check()
          const info = this.readInfo()
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
              const restored = await runModeWorker({
                handle: this.handle,
                ...old,
                previousConfig: encoded.config,
                previousPipeline: encoded.pipeline,
                previousStarted: true,
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
          if (!published && !this.previewHandle) {
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
    void job.operationDone.then(() => {
      if (!claimed) release()
    })
    this.modeJobs.add(job)
    this.modeTail = this.modeTail.then(() => job.start()).catch(() => {})
    return job
  }

  switchMode(
    options: CameraOptions,
    jobOptions: JobOptions<ReturnType<Camera['info']>> & {
      dropFrames?: number
    } = {},
  ) {
    return this.submitMode(options, undefined, jobOptions) as BunJob<
      ReturnType<Camera['info']>
    >
  }
  switchModeAndDropFrames(
    options: CameraOptions,
    dropFrames: number,
    jobOptions: JobOptions<ReturnType<Camera['info']>> = {},
  ) {
    return this.switchMode(options, { ...jobOptions, dropFrames })
  }
  switchModeAndCaptureRGB(
    options: CameraOptions,
    jobOptions: JobOptions<Uint8Array> & { dropFrames?: number } = {},
  ) {
    return this.submitMode(
      options,
      { kind: 'rgb' },
      jobOptions,
    ) as BunJob<Uint8Array>
  }
  switchModeAndCaptureMetadata(
    options: CameraOptions,
    jobOptions: JobOptions<ReturnType<Frame['metadata']>> & {
      dropFrames?: number
    } = {},
  ) {
    return this.submitMode(options, { kind: 'metadata' }, jobOptions) as BunJob<
      ReturnType<Frame['metadata']>
    >
  }
  switchModeAndCaptureBuffer(
    options: CameraOptions,
    stream: 'main' | 'raw' | 'lores' = 'main',
    jobOptions: JobOptions<{
      width: number
      height: number
      format: string
      data: Uint8Array
    }> & { dropFrames?: number } = {},
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
  switchModeAndCaptureFile(
    options: CameraOptions,
    path: string,
    jobOptions: JobOptions<ReturnType<Frame['metadata']>> & {
      dropFrames?: number
      quality?: number
    } = {},
  ) {
    const dng = path.toLowerCase().endsWith('.dng')
    if (!dng && !/\.jpe?g$/i.test(path))
      throw new CameraError(-8, 'mode capture file format')
    return this.submitMode(
      dng ? { ...options, raw: true, unpackedRaw: true } : options,
      {
        kind: 'file',
        path: cstring(path),
        dng,
        quality: uint(jobOptions.quality ?? 98),
      },
      jobOptions,
    ) as BunJob<ReturnType<Frame['metadata']>>
  }
  private submitMode<T>(
    options: CameraOptions,
    capture: ModeRequest['capture'],
    jobOptions: JobOptions<T> & { dropFrames?: number },
  ) {
    guardOutputHook()
    if (!this.handle || this.closing || this.stopJob)
      throw new CameraError(-2, 'camera unavailable')
    if (this.modeJobs.size + this.requests.length >= 32)
      throw new CameraError(-4, 'mode queue')
    if (
      this.coordinatedRecorder ||
      this.recording ||
      this.failedRecordings.size ||
      this.focusJobs ||
      this.requests.length
    )
      throw new CameraError(-4, 'camera jobs active')
    const target = copyConfiguration({
      ...options,
      simulate: this.configuration.simulate,
      cameraIndex: this.configuration.cameraIndex,
    })
    if (
      (options.simulate !== undefined &&
        options.simulate !== (this.configuration.simulate ?? false)) ||
      (options.cameraIndex !== undefined &&
        options.cameraIndex !== (this.configuration.cameraIndex ?? 0))
    )
      throw new CameraError(-1, 'mode must retain camera/backend')
    const encoded = cameraConfiguration(target),
      dropFrames = uint(jobOptions.dropFrames ?? 0)
    const effective = { ...jobOptions, timeoutMs: jobOptions.timeoutMs ?? 5000 }
    const deadline = Date.now() + effective.timeoutMs
    const job = new BunJob<T>(
      async (current) => {
        current.check()
        const stats = storage(40)
        check(n.zc_get_stats(this.handle, ptr(stats)))
        if (
          view(stats).getUint32(36, true) ||
          this.recording ||
          this.focusJobs ||
          this.requests.length
        )
          throw new CameraError(-4, 'mode requires unleased idle camera')
        const previous = this.options,
          old = cameraConfiguration(previous),
          started = this.started,
          title = this.previewTitle
        this.modeActive = true
        if (this.timer !== undefined) {
          clearTimeout(this.timer)
          this.timer = undefined
        }
        let response: ModeResponse | undefined
        let value: unknown
        let failure: unknown
        const preview = () => {
          if (!title || !this.handle || this.closing || this.stopJob) return
          const info = storage(680)
          check(n.zc_get_info(this.handle, ptr(info)))
          const name = cstring(title),
            out = outPointer()
          check(
            n.zc_preview_open(
              ptr(name),
              view(info).getUint32(8, true),
              view(info).getUint32(12, true),
              ptr(out),
            ),
          )
          this.previewHandle = handle(out)
          this.previewTitle = title
        }
        try {
          this.stopPreviewOwned()
          response = await runModeWorker({
            handle: this.handle,
            ...encoded,
            previousConfig: old.config,
            previousPipeline: old.pipeline,
            previousStarted: started,
            cancel: current.cancellation,
            deadline,
            capture,
            dropFrames,
          })
          this.handle = response.handle
          this.started = response.started
          if (Date.now() >= deadline && !current.cancelRequested)
            current.cancel(new CameraError(-3, 'mode deadline'))
          if (response.restoreCode) {
            const error = new CameraError(
              response.code || response.restoreCode,
              'mode restoration',
            ) as CameraError & { restoreCode: number }
            error.restoreCode = response.restoreCode
            throw error
          }
          if (response.code === -5 && current.cancelRequested) current.check()
          check(response.code, 'mode switch')
          current.check()
          this.configuration = response.target ? target : previous
          if (capture) {
            value = response.value
            if (capture.kind === 'metadata' || capture.kind === 'file')
              value = decodeMetadata(response.value!)
            if (capture.kind === 'stream')
              value = { ...response.stream!, data: response.value! }
          }
          preview()
        } catch (error) {
          failure = error
          if (error instanceof ModeWorkerFault) {
            this.handle = 0 as Pointer
            this.started = false
          }
          if (response?.target && this.handle) {
            try {
              const restored = await runModeWorker({
                handle: this.handle,
                ...old,
                previousConfig: encoded.config,
                previousPipeline: encoded.pipeline,
                previousStarted: true,
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
              if (error && typeof error === 'object')
                Object.assign(error, { restorationError })
              else
                failure = new AggregateError(
                  [error, restorationError],
                  'mode and restoration failed',
                )
            }
          }
          if (!this.previewHandle) {
            try {
              preview()
            } catch (restorationError) {
              if (error && typeof error === 'object')
                Object.assign(error, { previewError: restorationError })
            }
          }
        } finally {
          this.modeActive = false
          if (this.previewHandle) this.ensurePump()
        }
        if (failure !== undefined) throw failure
        if (!capture) value = this.info()
        current.seal()
        return value as T
      },
      () => this.modeJobs.delete(job),
      effective,
    )
    this.modeJobs.add(job)
    this.modeTail = this.modeTail.then(() => job.start()).catch(() => {})
    return job
  }
  private hasPendingModes() {
    return [...this.modeJobs].some((job) => !job.done)
  }
  private async cancelModes() {
    const jobs = [...this.modeJobs]
    for (const job of jobs) job.cancel(new CameraError(-2, 'camera stopped'))
    await Promise.all(jobs.map((job) => job.operationDone))
  }

  detach(recording: Recording) {
    const detached = this.recording === recording
    if (detached) this.recording = undefined
    const failed = this.failedRecordings.delete(recording)
    if ((detached || failed) && this.recording?.recorder !== recording.recorder)
      recording.recorder[recordingOwner](this, true)
  }
  private ensurePump() {
    if (this.timer === undefined && !this.pumping)
      this.timer = setTimeout(() => this.pump(), 0)
  }
  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      this.timer = undefined
      if (!this.handle || this.closing || this.coordinatedRecorder) return
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
        !this.previewHandle &&
        !this.requests.length &&
        !this.focusJobs
      )
        return
      let frame: Frame | undefined
      let producer: Promise<void> | undefined, writing: Recording | undefined
      try {
        frame = this.acquire(0)
        if (this.recording) {
          try {
            writing = this.recording
            if (writing.recorder.asyncWrites)
              producer = writing.writeAsync(frame)
            else writing.write(frame)
          } catch (error) {
            this.recording.error = error
            this.failedRecordings.add(this.recording)
            this.recording = undefined
          }
        }
        if (this.previewHandle) {
          const code = n.zc_preview_show(
            this.previewHandle,
            ptr(frame.descriptor),
          )
          if (code === 1) this.stopPreview()
          else check(code)
        }
        const job = this.requests.shift()
        if (job) {
          try {
            job.resolve(job.operation(frame))
          } catch (error) {
            job.reject(error)
          }
        }
      } catch (error) {
        if (!(error instanceof CameraError && error.code === -3)) {
          for (const job of this.requests) job.reject(error)
          this.requests = []
          if (this.recording) {
            this.recording.error = error
            this.failedRecordings.add(this.recording)
          }
          this.recording = undefined
          this.stopPreview()
        }
      } finally {
        frame?.release()
      }
      if (producer) {
        try {
          await producer
        } catch (error) {
          if (
            writing &&
            !(
              writing.closing &&
              error instanceof CameraError &&
              error.code === -2
            )
          ) {
            writing.error = error
            this.failedRecordings.add(writing)
            if (this.recording === writing) this.recording = undefined
          }
        }
      }
      if (!this.handle || this.closing) return
      if (
        this.recording ||
        this.previewHandle ||
        this.requests.length ||
        this.focusJobs
      )
        this.timer = setTimeout(() => this.pump(), 1)
    } finally {
      this.pumping = false
    }
  }
  stop(): Promise<void> {
    guardOutputHook()
    if (this.stopJob) return this.stopJob
    if (!this.handle || this.closing)
      throw new CameraError(-2, 'camera unavailable')
    return this.stopWork()
  }
  private stopWork(): Promise<void> {
    if (this.stopJob) return this.stopJob
    const coordinated = this.coordinatedRecorder
    const recordings = [...this.failedRecordings]
    if (this.coordinatedInitial) recordings.push(this.coordinatedInitial)
    if (this.recording) recordings.push(this.recording)
    this.recording = undefined
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
      try {
        this.stopPreview()
      } catch (error) {
        failure = error
      }
      for (const recording of recordings) {
        try {
          await recording.close()
        } catch (error) {
          failure ??= error
        }
      }
      if (coordinated && recordings.some((r) => r.recorder === coordinated)) {
        try {
          await coordinated.close()
        } catch (error) {
          failure ??= error
        }
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
    guardOutputHook()
    if (this.closeJob) return this.closeJob
    if (!this.handle) return Promise.resolve()
    this.closing = true
    this.closeJob = (async () => {
      let failure: unknown
      try {
        await this.stopWork()
      } catch (error) {
        failure = error
      }
      try {
        if (this.handle) check(n.zc_close(this.handle))
        this.handle = 0 as Pointer
      } catch (error) {
        failure ??= error
      }
      if (failure) throw failure
    })().finally(() => {
      if (this.handle) {
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
  width: number
  height: number
  fps?: number
  codec?: keyof typeof Codec
  bitrate?: number
  quality?: number
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
 * audio. Changing codec resets omitted bitrate/GOP to that codec's defaults. */
export type RecorderSessionOptions = Partial<
  Pick<
    RecorderOptions,
    'width' | 'height' | 'fps' | 'codec' | 'bitrate' | 'quality' | 'gop'
  >
> & { audio?: RecorderOptions['audio'] | null }
function snapshotRecorderOptions(options: RecorderOptions): RecorderOptions {
  return Object.freeze({
    ...options,
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
  }
  for (const key of [
    'width',
    'height',
    'fps',
    'codec',
    'bitrate',
    'quality',
    'gop',
  ] as const)
    if (settings[key] !== undefined)
      Object.assign(merged, { [key]: settings[key] })
  if (settings.audio !== undefined) merged.audio = settings.audio ?? undefined
  return snapshotRecorderOptions(merged)
}
function resolvedSession(
  options: RecorderOptions,
  width: number,
  height: number,
  exact: number,
) {
  const config = sessionFields(options)
  check(
    n.zc_video_resolve_session_config(
      ptr(config.video),
      ptr(config.audio),
      config.bitrate,
      width,
      height,
      exact,
    ),
    'camera/recorder configuration',
  )
  return snapshotRecorderOptions({ ...options, width, height })
}
function sessionFields(options: RecorderOptions) {
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
  return {
    video: fields(32, n.zc_default_video_config, [
      options.width,
      options.height,
      options.fps ?? 30,
      1,
      Codec[options.codec ?? 'mjpeg'],
      options.bitrate,
      options.quality,
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
  }
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
    audio: options.audio
      ? {
          sampleRate: options.audio.sampleRate,
          channels: options.audio.channels,
        }
      : undefined,
  }
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
  private coordinator?: BunJob<Recording>
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
    const producerLimits = options.producerQueue
      ? {
          bytes: uint(options.producerQueue.maxBytes, 1024 ** 3),
          jobs: uint(options.producerQueue.maxOperations, 8),
        }
      : undefined
    if (producerLimits && (!producerLimits.bytes || !producerLimits.jobs))
      throw new RangeError('invalid producer queue bounds')
    options = snapshotRecorderOptions(options)
    this.currentOptions = options
    const { video: cfg, audio: opts } = sessionFields(options)
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
    } else if (path === null)
      check(
        n.zc_video_create(
          ptr(cfg),
          ptr(opts),
          uint(options.audio?.bitrate ?? 0),
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
      if (options.circular && path !== null) {
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
  private assertOwned(allowProducer = false) {
    guardOutputHook()
    if (!this.handle || this.closing)
      throw new CameraError(-2, 'closed recorder')
    if (this.producerTurn && !allowProducer)
      throw new CameraError(-4, 'async producer owns recorder')
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
    if (!frame.token) throw new CameraError(-5, 'released frame')
    const out = outPointer()
    check(
      n.zc_video_producer_frame(
        this.handle,
        ptr(frame.descriptor),
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
    if (!frame.token) throw new CameraError(-5, 'released frame')
    if (audio.length > 256) throw new RangeError('too many PCM blocks')
    const inputs = storage(audio.length * 24),
      d = view(inputs)
    for (let i = 0; i < audio.length; i++) {
      if (!audio[i].data.length) throw new RangeError('empty PCM')
      d.setBigUint64(i * 24, BigInt(ptr(audio[i].data)), true)
      d.setBigUint64(i * 24 + 8, BigInt(audio[i].data.length), true)
      d.setBigUint64(i * 24 + 16, audio[i].timestampNs, true)
    }
    const out = outPointer()
    check(
      n.zc_video_producer_av(
        this.handle,
        ptr(frame.descriptor),
        timestampNs,
        audio.length ? ptr(inputs) : null,
        audio.length,
        ptr(out),
      ),
      'producer A/V admission',
    )
    return this.queueProducer(handle(out), options)
  }
  private queueProducer(
    native: Pointer,
    options: JobOptions<void>,
    mode: 'write' | 'drain' | 'flush' = 'write',
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
              if (mode !== 'write') {
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
              check(code[0], 'async producer write')
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
    check(n.zc_video_write(this.handle, ptr(frame.descriptor), timestampNs))
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
          primary =
            current.bridge.error ?? new CameraError(code, 'remove output')
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
        if (code !== 0)
          current.bridge.fail(new CameraError(code, 'native output'))
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
        this.pendingHostOutputs.set(id, { bridge, generation: generation + 1n })
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
          entry.error ??= new CameraError(code, 'factory claim')
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
  [coordinateRecorder](job: BunJob<Recording>, camera: Camera) {
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
      flush: () => enter(() => this.flushAsync()),
      restart: (
        settings: RecorderOptions,
        output: string | CustomOutput | null,
        onPublished: () => void,
        beforePublish: () => void,
        onInstalled: () => void,
      ) =>
        enter(() =>
          this.restartSession(
            { ...settings, audio: settings.audio ?? null },
            output,
            {},
            onPublished,
            beforePublish,
            onInstalled,
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
  ): BunJob<void> {
    this.assertOpen(true)
    if (this.restartPending)
      throw new CameraError(-4, 'restart already pending')
    const candidate = mergeSessionOptions(this.options, settings)
    const config = settings ? sessionFields(candidate) : undefined
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
                beforePublish?.()
                check(
                  n.zc_producer_job_restart_publish(native),
                  'restart publication',
                )
                published = true
                job.seal()
                onPublished?.()
              }
              await pause()
            }
            this.currentOptions = candidate
            onInstalled?.()
            this.sessionEpoch = this.readSessionState().id
            const old = [...this.deliveryBridges]
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
  }: {
    simulate?: boolean
    sampleRate?: number
    channels?: number
    blockFrames?: number
    startNs?: bigint
    device?: string
  } = {}) {
    this.sampleRate = sampleRate
    this.channels = channels
    this.blockFrames = blockFrames
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
  frames = 0
  error: unknown
  private stopped = false
  private closeJob?: Promise<void>
  private flushJob?: BunJob<void>
  private retainedRecorder = false
  private pendingAudio?: ReturnType<AudioCapture['read']>
  get closing() {
    return this.stopped
  }
  constructor(
    private camera: Camera,
    readonly recorder: Recorder,
    private audio: AudioCapture | undefined,
    private fps: number,
  ) {}
  private inputs(frame: Frame) {
    if (this.stopped) throw new CameraError(-2, 'recording stopped')
    const timestamp =
      this.camera.info().backend === 0
        ? (BigInt(this.frames) * 1_000_000_000n) / BigInt(this.fps)
        : frame.timestampNs
    const blocks: ProducerAudioBlock[] = []
    if (this.audio) {
      let count = 0
      const end = timestamp + 1_000_000_000n / BigInt(this.fps)
      while (count++ < 256) {
        let block = this.pendingAudio
        if (!block) {
          try {
            block = this.audio.read(0)
          } catch (error) {
            if (error instanceof CameraError && error.code === -3) break
            throw error
          }
        }
        if (block.timestampNs >= end) {
          this.pendingAudio = block
          break
        }
        this.pendingAudio = undefined
        blocks.push(block)
      }
    }
    return { timestamp, blocks }
  }
  write(frame: Frame) {
    const { timestamp, blocks } = this.inputs(frame)
    for (const block of blocks)
      this.recorder.writeAudio(block.data, block.timestampNs)
    this.recorder.write(frame, timestamp)
    this.frames++
  }
  writeAsync(frame: Frame): Promise<void> {
    const { timestamp, blocks } = this.inputs(frame)
    const job = this.recorder.writeAVAsync(frame, blocks, timestamp)
    this.frames++
    return Promise.resolve(job)
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
    this.flushJob = job
    this.stopped = true
    this.retainedRecorder = true
    this.camera.detach(this)
    this.audio?.close()
    this.pendingAudio = undefined
    return job
  }
  close() {
    guardOutputHook()
    if (this.closeJob) return this.closeJob
    this.stopped = true
    this.camera.detach(this)
    this.closeJob = (async () => {
      let failure = this.error
      try {
        this.audio?.close()
      } catch (error) {
        failure ??= error
      }
      try {
        if (this.retainedRecorder) await this.flushJob?.operationDone
        else await this.recorder.close()
      } catch (error) {
        failure ??= error
      }
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
