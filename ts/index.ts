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
export interface CameraOptions {
  simulate?: boolean
  width?: number
  height?: number
  buffers?: number
  cameraIndex?: number
  fifo?: boolean
  raw?: boolean
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
  private requests: CaptureRequest[] = []
  private focusJobs = 0
  readonly options: CameraOptions
  constructor(options: CameraOptions = {}) {
    this.options = { ...options }
    const cfg = fields(72, n.zc_default_config, [
      options.width,
      options.height,
      options.buffers,
      options.cameraIndex,
      options.fifo ? 0 : 1,
    ])
    if (options.raw) view(cfg).setUint32(36, 1, true)
    if (options.rawFormat) {
      const name = cstring(options.rawFormat)
      if (name.length > 32) throw new RangeError('raw format too long')
      cfg.set(name, 40)
    }
    // Backend is selected at build time; the explicit environment override used
    // by the core is process-wide. Never silently substitute simulation.
    const pipeline = fields(44, n.zc_default_pipeline_options, [
      undefined,
      undefined,
      { still: 0, preview: 1, video: 2 }[options.role ?? 'still'],
    ])
    if (options.sensor) {
      ;[
        options.sensor.width,
        options.sensor.height,
        options.sensor.bitDepth,
      ].forEach((x, i) => view(pipeline).setUint32(20 + i * 4, uint(x), true))
    }
    if (options.lores) {
      view(pipeline).setUint32(32, uint(options.lores.width), true)
      view(pipeline).setUint32(36, uint(options.lores.height), true)
      view(pipeline).setUint32(40, options.lores.rgb ? 1 : 0, true)
    }
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
    if (!this.handle || this.closing || this.stopJob)
      throw new CameraError(-2, 'camera unavailable')
  }
  info() {
    this.assertOpen()
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
    if (this.previewHandle) throw new CameraError(-4, 'preview already active')
    const info = this.info(),
      name = cstring(title),
      out = outPointer()
    check(n.zc_preview_open(ptr(name), info.width, info.height, ptr(out)))
    this.previewHandle = handle(out)
    this.start()
    this.ensurePump()
  }
  stopPreview() {
    if (this.previewHandle) {
      check(n.zc_preview_close(this.previewHandle))
      this.previewHandle = 0 as Pointer
    }
  }
  startRecording(
    recorder: Recorder,
    options: { fps?: number; audio?: AudioCapture } = {},
  ) {
    this.assertOpen()
    if (this.recording) throw new CameraError(-4, 'recording active')
    const info = this.info()
    if (info.width !== recorder.width || info.height !== recorder.height)
      throw new RangeError('recorder geometry mismatch')
    this.start()
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
  detach(recording: Recording) {
    if (this.recording === recording) this.recording = undefined
    this.failedRecordings.delete(recording)
  }
  private ensurePump() {
    if (this.timer === undefined) this.timer = setTimeout(() => this.pump(), 0)
  }
  private pump() {
    this.timer = undefined
    if (!this.handle || this.closing) return
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
    try {
      frame = this.acquire(0)
      if (this.recording) {
        try {
          this.recording.write(frame)
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
    if (
      this.recording ||
      this.previewHandle ||
      this.requests.length ||
      this.focusJobs
    )
      this.timer = setTimeout(() => this.pump(), 1)
  }
  stop(): Promise<void> {
    if (this.stopJob) return this.stopJob
    this.assertOpen()
    return this.stopWork()
  }
  private stopWork(): Promise<void> {
    if (this.stopJob) return this.stopJob
    const recordings = [...this.failedRecordings]
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
        check(n.zc_close(this.handle))
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
  io?: { maxBytes: number; maxOperations: number; waitMs?: number }
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
    private handle: Pointer,
  ) {}
  get status(): PreparationState {
    if (this.closed) throw new CameraError(-2, 'closed preparation job')
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
    if (this.closed || this.recorder.closing) return false
    return n.zc_preparation_job_cancel(this.handle) === 0
  }
  async wait({
    timeoutMs = 30_000,
    signal,
  }: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const deadline = performance.now() + timeoutMs
    while (true) {
      if (this.recorder.closing) {
        try {
          await this.recorder.closed
        } catch {
          /* read terminal job after cleanup */
        }
      }
      const state = this.status
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
    if (this.closed) return
    if (this.recorder.closing) throw new CameraError(-4, 'recorder closing')
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
export class Recorder {
  handle: Pointer
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly options: RecorderOptions
  closing = false
  closed?: Promise<void>
  outputErrors = new Map<bigint, number>()
  private jobs = new Set<PreparationJob>()
  private tasks = 0
  private finalStats?: RecordingStats
  constructor(path: string | null, options: RecorderOptions) {
    this.options = { ...options }
    this.width = uint(options.width)
    this.height = uint(options.height)
    this.fps = options.fps ?? 30
    const cfg = fields(32, n.zc_default_video_config, [
      this.width,
      this.height,
      this.fps,
      1,
      Codec[options.codec ?? 'mjpeg'],
      options.bitrate,
      options.quality,
      options.gop,
    ])
    const opts = fields(24, n.zc_default_recording_options, [
      undefined,
      options.audio?.sampleRate ?? 0,
      options.audio?.channels ?? 1,
      options.audio?.bufferFrames,
      options.audio?.maxBlocks,
      options.exclusive ? 1 : 0,
    ])
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
  assertOpen() {
    if (!this.handle || this.closing)
      throw new CameraError(-2, 'closed recorder')
  }
  write(frame: Frame, timestampNs = frame.timestampNs) {
    this.assertOpen()
    if (!frame.token) throw new CameraError(-5, 'released frame')
    check(n.zc_video_write(this.handle, ptr(frame.descriptor), timestampNs))
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
  }
  stats(): RecordingStats {
    if (!this.handle && this.finalStats) return this.finalStats
    this.assertOpen()
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
  addOutput(path: string) {
    this.assertOpen()
    const name = cstring(path),
      id = new BigUint64Array(1)
    check(n.zc_video_add_output(this.handle, ptr(name), ptr(id)))
    if (this.options.io) this.setIO(id[0], this.options.io)
    return id[0]
  }
  removeOutput(id: bigint | number) {
    this.assertOpen()
    check(n.zc_video_remove_output(this.handle, BigInt(id)))
  }
  setIO(
    id: bigint | number,
    options: { maxBytes: number; maxOperations: number; waitMs?: number },
  ) {
    this.assertOpen()
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
  split(path: string, id: bigint | number = 0n) {
    return this.prepare(path, BigInt(id), false)
  }
  recover(path: string, id: bigint | number = 0n) {
    return this.prepare(path, BigInt(id), true)
  }
  private prepare(path: string, id: bigint, recovery: boolean) {
    this.assertOpen()
    const name = cstring(path),
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
    pattern: string,
    options: { nextIndex?: bigint; durationMs?: number; maxBytes?: number },
  ) {
    this.assertOpen()
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
    pattern: string,
    {
      nextIndex = 1n,
      maxAttempts = 3,
      retryDelayMs = 100,
      maxDelayMs = 5000,
    }: {
      nextIndex?: bigint
      maxAttempts?: number
      retryDelayMs?: number
      maxDelayMs?: number
    } = {},
  ) {
    this.assertOpen()
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
  stopAutomatic(id: bigint | number = 0n) {
    this.assertOpen()
    check(
      n.zc_video_set_automatic(this.handle, BigInt(id), null, 0n, 0, 0n, 0n),
    )
  }
  automaticState(id: bigint | number = 0n) {
    this.assertOpen()
    const data = storage(16)
    check(n.zc_video_automatic_state(this.handle, BigInt(id), ptr(data)))
    return {
      nextIndex: u64(data),
      errorCode: view(data).getInt32(8, true),
      pending: !!view(data).getUint32(12, true),
    }
  }
  recoveryState(id: bigint | number = 0n) {
    this.assertOpen()
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
  private admit() {
    this.assertOpen()
    if (this.tasks >= 16) throw new CameraError(-4, 'lifecycle queue')
    this.tasks++
  }
  async drain(id: bigint | number = 0n) {
    this.admit()
    const out = outPointer()
    try {
      check(n.zc_video_drain_output_async(this.handle, BigInt(id), ptr(out)))
      const result = await nativeTask('drain', handle(out))
      check(result.code, 'drain')
    } finally {
      this.tasks--
    }
  }
  async snapshot(path: string) {
    this.admit()
    const name = cstring(path),
      out = outPointer()
    try {
      check(n.zc_video_freeze_buffer(this.handle, ptr(name), ptr(out)))
      const result = await nativeTask('snapshot', handle(out))
      check(result.code, 'snapshot')
    } finally {
      this.tasks--
    }
  }
  close(): Promise<void> {
    if (this.closed) return this.closed
    if (!this.handle) return Promise.resolve()
    this.finalStats = this.stats()
    this.closing = true
    this.closed = (async () => {
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
      this.closing = false
      if (result.results) {
        for (let i = 0; i < result.count; i++) {
          const data = result.results.subarray(i * 32, (i + 1) * 32)
          const code = view(data).getInt32(16, true)
          if (code) this.outputErrors.set(u64(data), code)
        }
      }
      check(result.code, 'recorder close')
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
  private pendingAudio?: ReturnType<AudioCapture['read']>
  constructor(
    private camera: Camera,
    readonly recorder: Recorder,
    private audio: AudioCapture | undefined,
    private fps: number,
  ) {}
  write(frame: Frame) {
    if (this.stopped) throw new CameraError(-2, 'recording stopped')
    const timestamp =
      this.camera.info().backend === 0
        ? (BigInt(this.frames) * 1_000_000_000n) / BigInt(this.fps)
        : frame.timestampNs
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
        this.recorder.writeAudio(block.data, block.timestampNs)
      }
    }
    this.recorder.write(frame, timestamp)
    this.frames++
  }
  split(path: string, id: bigint | number = 0n) {
    return this.recorder.split(path, id)
  }
  close() {
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
        await this.recorder.close()
      } catch (error) {
        failure ??= error
      }
      if (failure) throw failure
    })()
    return this.closeJob
  }
}
