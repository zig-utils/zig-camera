import type { CameraOptions, ModeJobOptions, PreviewOptions } from './index'
import { copyConfiguration } from './config'
import { decodeMetadata } from './metadata'
import { prepareImageFactory, type ImageOptions } from './images'
import { preparePreviewConfiguration } from './preview-options'
import { BunJob, snapshotJobOptions } from './jobs'
import { native as n, ptr, storage, check } from './ffi'
export interface CaptureFilePattern {
  pattern: string
  count: number
  startIndex?: number
  padTo?: number
}
export type CaptureFileTargets = readonly string[] | CaptureFilePattern
export interface CaptureFileRecord {
  readonly index: number
  readonly path: string
  readonly metadata: Readonly<
    Omit<ReturnType<typeof decodeMetadata>, 'crop'>
  > & { readonly crop: Readonly<ReturnType<typeof decodeMetadata>['crop']> }
}
export interface CaptureFilesProgress {
  readonly completed: number
  readonly recentFiles: readonly CaptureFileRecord[]
  readonly stage:
    | 'queued'
    | 'preparing'
    | 'waiting'
    | 'capturing'
    | 'progress'
    | 'stopping'
    | 'finished'
  readonly currentIndex?: number
  readonly currentPath?: string
  readonly stopped: boolean
}
export interface CaptureFilesOptions
  extends ModeJobOptions<CaptureFilesProgress>, ImageOptions {
  previewMode?: CameraOptions
  captureMode?: CameraOptions
  initialDelayMs?: number
  intervalMs?: number
  captureTimeoutMs?: number
  /** Existing configured preview is reused. Default true opens SDL when absent. */
  preview?: boolean | PreviewOptions
  /** Bounded metadata history; default 64, range 0..4096. Files are never queued in bulk. */
  retainResults?: number
  /** Synchronous progress after a completed/joined file. Cancel the parent job to stop. */
  onFile?: (file: CaptureFileRecord) => void
}
export class CaptureFilesJob extends BunJob<CaptureFilesProgress> {
  constructor(
    operation: (
      job: BunJob<CaptureFilesProgress>,
    ) => Promise<CaptureFilesProgress>,
    release: () => void,
    options: ModeJobOptions<CaptureFilesProgress>,
    private readonly observation: () => CaptureFilesProgress,
  ) {
    super(operation, release, options)
  }
  get partial() {
    return this.observation()
  }
}
export class CaptureFilesState {
  completed = 0
  stage: CaptureFilesProgress['stage'] = 'queued'
  currentIndex?: number
  currentPath?: string
  stopped = false
  private recent: CaptureFileRecord[] = []
  private cursor = 0
  constructor(private readonly keep: number) {}
  record(
    index: number,
    path: string,
    metadata: ReturnType<typeof decodeMetadata>,
  ): CaptureFileRecord {
    const value = Object.freeze({
      index,
      path,
      metadata: Object.freeze({
        ...metadata,
        crop: Object.freeze({ ...metadata.crop }),
      }),
    })
    this.completed++
    if (this.keep) {
      if (this.recent.length < this.keep) this.recent.push(value)
      else {
        this.recent[this.cursor] = value
        this.cursor = (this.cursor + 1) % this.keep
      }
    }
    return value
  }
  snapshot = (): CaptureFilesProgress =>
    Object.freeze({
      completed: this.completed,
      recentFiles: Object.freeze(
        this.cursor
          ? [
              ...this.recent.slice(this.cursor),
              ...this.recent.slice(0, this.cursor),
            ]
          : [...this.recent],
      ),
      stage: this.stage,
      currentIndex: this.currentIndex,
      currentPath: this.currentPath,
      stopped: this.stopped,
    })
}
function integer(value: unknown, min: number, max: number, label: string) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new RangeError(`invalid ${label}`)
  return value
}
function duration(value: unknown, label: string) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER / 1e6
  )
    throw new RangeError(`invalid ${label}`)
  return value
}
export function prepareCaptureFiles(
  targets: CaptureFileTargets,
  source: CaptureFilesOptions,
  previous: CameraOptions,
) {
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new TypeError('invalid capture series options')
  const initialDelayMs = source.initialDelayMs ?? 1000,
    intervalMs = source.intervalMs ?? 1000,
    captureTimeoutMs = source.captureTimeoutMs ?? 5000,
    previewMode = source.previewMode,
    captureMode = source.captureMode,
    preview = source.preview,
    retainResults = source.retainResults ?? 64,
    onFile = source.onFile,
    autofocus = source.autofocus,
    autofocusPolicy = source.autofocusPolicy,
    dropFrames = source.dropFrames ?? 0
  duration(initialDelayMs, 'initial capture delay')
  duration(intervalMs, 'capture interval')
  duration(captureTimeoutMs, 'capture timeout')
  integer(retainResults, 0, 4096, 'capture result retention')
  integer(dropFrames, 0, 0xffffffff, 'frame drop count')
  if (onFile !== undefined && typeof onFile !== 'function')
    throw new TypeError('invalid file progress callback')
  const jobOptions = snapshotJobOptions(source)
  if (
    preview !== undefined &&
    typeof preview !== 'boolean' &&
    (!preview || typeof preview !== 'object' || Array.isArray(preview))
  )
    throw new TypeError('invalid series preview')
  const preparedPreview =
    preview === false
      ? undefined
      : preparePreviewConfiguration(
          typeof preview === 'object' ? preview : undefined,
        )
  let count: number, path: (index: number) => string
  if (Array.isArray(targets)) {
    count = targets.length
    integer(count, 1, Number.MAX_SAFE_INTEGER, 'capture file count')
    const names: string[] = []
    for (let i = 0; i < count; i++) {
      const value = targets[i]
      if (typeof value !== 'string')
        throw new TypeError('capture paths must be strings')
      names.push(value)
    }
    path = (index) => names[index]
  } else {
    if (!targets || typeof targets !== 'object')
      throw new TypeError('invalid capture targets')
    const pattern = (targets as CaptureFilePattern).pattern,
      requested = (targets as CaptureFilePattern).count,
      start = (targets as CaptureFilePattern).startIndex ?? 0,
      pad = (targets as CaptureFilePattern).padTo ?? 3
    if (typeof pattern !== 'string')
      throw new TypeError('capture pattern must be a string')
    count = integer(requested, 1, Number.MAX_SAFE_INTEGER, 'capture file count')
    integer(start, 0, Number.MAX_SAFE_INTEGER, 'capture start index')
    integer(pad, 0, 16, 'capture index padding')
    if (count - 1 > Number.MAX_SAFE_INTEGER - start)
      throw new RangeError('capture index overflow')
    path = (index) =>
      pattern.replaceAll('{index}', String(start + index).padStart(pad, '0'))
  }
  const image = prepareImageFactory(source)
  let raw = false
  const validate = (name: string) => {
    const prepared = image(name)
    if (prepared.path!.length < 2 || prepared.path!.length > 4097)
      throw new RangeError('capture path must be 1..4096 UTF-8 bytes')
    raw ||= prepared.format === 6
  }
  if (Array.isArray(targets)) for (let i = 0; i < count; i++) validate(path(i))
  else {
    validate(path(0))
    validate(path(count - 1))
  }
  if (
    previewMode !== undefined &&
    (!previewMode ||
      typeof previewMode !== 'object' ||
      Array.isArray(previewMode))
  )
    throw new TypeError('invalid preview mode')
  if (
    captureMode !== undefined &&
    (!captureMode ||
      typeof captureMode !== 'object' ||
      Array.isArray(captureMode))
  )
    throw new TypeError('invalid capture mode')
  const preparedCapture = copyConfiguration(captureMode ?? { role: 'still' })
  if (raw) {
    preparedCapture.raw = true
    preparedCapture.unpackedRaw = true
  }
  return {
    count,
    path,
    image,
    initialDelayMs,
    intervalMs,
    captureTimeoutMs,
    preview: preparedPreview,
    previewMode: copyConfiguration(
      previewMode ?? { ...previous, role: 'preview' },
    ),
    captureMode: preparedCapture,
    retainResults,
    onFile,
    jobOptions,
    modeOptions: { autofocus, autofocusPolicy, dropFrames },
  }
}
function clock() {
  const out = new BigUint64Array(1)
  check(n.zc_capture_clock_ns(ptr(out)), 'capture series clock')
  return out[0]
}
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
/** Home's relative interval is polled through cancellable, bounded host timers. */
export async function waitCaptureInterval<T>(ms: number, job: BunJob<T>) {
  job.check()
  if (ms === 0) return
  const state = storage(32),
    remaining = new BigUint64Array(1)
  n.zc_default_capture_delay(ptr(state))
  check(
    n.zc_capture_delay_arm(ptr(state), clock(), BigInt(Math.round(ms * 1e6))),
    'capture idle interval',
  )
  for (;;) {
    job.check()
    check(
      n.zc_capture_delay_remaining(ptr(state), clock(), ptr(remaining)),
      'capture idle interval',
    )
    if (remaining[0] === 0n) return
    const chunk = remaining[0] > 1_000_000_000n ? 1_000_000_000n : remaining[0]
    await sleep(Math.max(1, Math.ceil(Number(chunk) / 1e6)), job.signal)
  }
}
