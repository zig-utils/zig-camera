import {
  copyNativeStreams,
  type CapturedStreams,
  type StreamName,
} from './streams'
import type { PreparedExif } from './exif'
import { decodeMetadata } from './metadata'
import { decodeCatalog } from './catalog'
import {
  readDeviceState,
  decodeDeviceState,
  type DeviceState,
} from './device-state'
import {
  encodeNativeImage,
  stageNativeImage,
  type ImageProfile,
} from './images'
import {
  native as n,
  ptr,
  storage,
  outPointer,
  handle,
  view,
  CameraError,
  type Pointer,
} from './ffi'
export interface ModeRequest {
  /** Reconnection creates a separate owner. Never reopen a failed candidate as rollback. */
  fresh?: boolean
  disposeOnly?: boolean
  targetStarted?: boolean
  handle: Pointer
  cameraId: Uint8Array
  config: Uint8Array
  pipeline: Uint8Array
  previousConfig: Uint8Array
  previousPipeline: Uint8Array
  mainFormat?: number
  previousMainFormat?: number
  processed?: Uint8Array
  previousProcessed?: Uint8Array
  previousStarted: boolean
  writable?: boolean
  previousWritable?: boolean
  orientation?: number
  strictOrientation?: boolean
  previousOrientation?: number
  previousStrictOrientation?: boolean
  nativeControls?: Uint8Array
  controls: Uint8Array
  controlCount: number
  controlRevision: bigint
  cancel: SharedArrayBuffer
  deadline: number
  capture?: {
    kind:
      | 'rgb'
      | 'stream'
      | 'streams'
      | 'metadata'
      | 'file'
      | 'encoded'
      | 'request-stop'
    streams?: StreamName[]
    imageOptions?: Uint8Array
    imageProfile?: ImageProfile
    imageExif?: PreparedExif
    fileOutput?: Pointer
    stream?: number
    path?: Uint8Array
    dng?: boolean
    quality?: number
  }
  autofocus?: boolean
  dropFrames: number
  requestHooks?: { pre: boolean; post: boolean; control: SharedArrayBuffer }
}
export interface ModeRequestHook {
  kind: 'request-hook'
  ticket: number
  phase: 'pre' | 'post'
  handle: Pointer
  frame: Uint8Array
}
export interface ModeResponse {
  deviceLoss?: Readonly<DeviceState>
  handle: Pointer
  code: number
  restoreCode: number
  controlCode: number
  restoreControlCode: number
  controlRevision: bigint
  autofocusState?: number
  target: boolean
  started: boolean
  value?: Uint8Array
  requestFrame?: Uint8Array
  requestCleanupCode?: number
  bundle?: CapturedStreams
  stream?: { width: number; height: number; format: string }
  /** Main-thread-only enrichment; never transported by the worker. */
  callbackError?: unknown
}
declare const self: {
  onmessage: (event: { data: ModeRequest }) => void
  postMessage: (
    value: ModeResponse | ModeRequestHook,
    transfer?: ArrayBuffer[],
  ) => void
}
self.onmessage = ({ data: request }) => {
  const status = (error: unknown) =>
    typeof error === 'number'
      ? error
      : error instanceof CameraError
        ? error.code
        : -6
  const result: ModeResponse = {
    handle: request.handle,
    code: 0,
    restoreCode: 0,
    controlCode: 0,
    restoreControlCode: 0,
    controlRevision: request.controlRevision,
    target: false,
    started: request.previousStarted,
  }
  const cancelled = () =>
    Atomics.load(new Int32Array(request.cancel), 0) !== 0 ||
    Date.now() >= request.deadline
  const check = (code: number) => {
    if (code !== 0) throw code
  }
  const open = (
    config: Uint8Array,
    pipeline: Uint8Array,
    start: boolean,
    restoring = false,
  ) => {
    const out = outPointer()
    const selected = config.slice()
    view(selected).setUint32(12, 0, true)
    const mainFormat =
      (restoring ? request.previousMainFormat : request.mainFormat) ?? 1
    const processed = restoring ? request.previousProcessed : request.processed
    check(
      processed
        ? n.zc_open_id_processed_pipeline(
            ptr(selected),
            ptr(pipeline),
            ptr(processed),
            (restoring ? request.previousOrientation : request.orientation) ??
              1,
            (
              restoring
                ? request.previousStrictOrientation
                : request.strictOrientation
            )
              ? 1
              : 0,
            ptr(request.cameraId),
            request.cameraId.length,
            ptr(out),
          )
        : mainFormat !== 1
          ? n.zc_open_id_formatted_pipeline(
              ptr(selected),
              ptr(pipeline),
              mainFormat,
              (restoring ? request.previousOrientation : request.orientation) ??
                1,
              (
                restoring
                  ? request.previousStrictOrientation
                  : request.strictOrientation
              )
                ? 1
                : 0,
              ptr(request.cameraId),
              request.cameraId.length,
              ptr(out),
            )
          : n.zc_open_id_oriented_pipeline(
              ptr(selected),
              ptr(pipeline),
              (restoring ? request.previousOrientation : request.orientation) ??
                1,
              (
                restoring
                  ? request.previousStrictOrientation
                  : request.strictOrientation
              )
                ? 1
                : 0,
              ptr(request.cameraId),
              request.cameraId.length,
              ptr(out),
            ),
    )
    result.handle = handle(out)
    result.started = false
    if (restoring ? request.previousWritable : request.writable)
      check(n.zc_enable_writable(result.handle))
    const revision = new BigUint64Array(1)
    const replay = n.zc_restore_controls(
      result.handle,
      request.controlCount ? ptr(request.controls) : null,
      request.controlCount,
      result.controlRevision,
      ptr(revision),
    )
    if (replay !== 0) {
      if (restoring) result.restoreControlCode = replay
      else result.controlCode = replay
      check(replay)
    }
    result.controlRevision = revision[0]
    if (
      request.nativeControls &&
      view(request.nativeControls).getUint32(12, true)
    ) {
      const replay = n.zc_restore_native_controls(
        result.handle,
        ptr(request.nativeControls),
        BigInt(request.nativeControls.length),
        result.controlRevision,
        ptr(revision),
      )
      if (replay !== 0) {
        if (restoring) result.restoreControlCode = replay
        else result.controlCode = replay
        check(replay)
      }
      result.controlRevision = revision[0]
    }
    if (start) {
      check(n.zc_start(result.handle))
      result.started = true
    }
  }
  const close = () => {
    if (!result.handle) return
    observeLoss()
    // AF start/cancel consumes revisions too. Preserve them across every rollback.
    const count = new Uint32Array(1),
      revision = new BigUint64Array(1)
    check(n.zc_get_controls(result.handle, null, 0, ptr(count), ptr(revision)))
    if (revision[0] > result.controlRevision)
      result.controlRevision = revision[0]
    check(n.zc_stop(result.handle))
    result.started = false
    const finalState = storage(32)
    check(n.zc_close_with_device_state(result.handle, ptr(finalState)))
    result.handle = 0 as Pointer
    const state = decodeDeviceState(finalState)
    if (!state.connected) result.deviceLoss ??= state
  }
  const observeLoss = () => {
    if (result.handle && !result.deviceLoss) {
      const state = readDeviceState(result.handle)
      if (!state.connected) result.deviceLoss = state
    }
  }
  if (request.disposeOnly) {
    try {
      close()
    } catch (code) {
      result.code = status(code)
    }
    observeLoss()
    self.postMessage(result)
    return
  }
  let focusRevision: bigint | undefined
  let hookTicket = 0
  const hook = (phase: 'pre' | 'post', frame: Uint8Array) => {
    if (!request.requestHooks?.[phase]) return
    if (cancelled()) throw -5
    if (hookTicket === 0x7fffffff) throw -2
    const control = new Int32Array(request.requestHooks.control)
    Atomics.store(control, 0, ++hookTicket)
    Atomics.store(control, 2, 0)
    Atomics.store(control, 1, 0) // pending; main claims 1, retires 2; unclaimed cancellation 3
    self.postMessage({
      kind: 'request-hook',
      ticket: hookTicket,
      phase,
      handle: result.handle,
      frame: frame.slice(),
    })
    while (true) {
      const state = Atomics.load(control, 1)
      if (state === 2) {
        check(Atomics.load(control, 2))
        break
      }
      if (state === 3) throw -5
      // Once claimed, a callback/map scope must retire before any frame release.
      if (cancelled() && Atomics.compareExchange(control, 1, 0, 3) === 0)
        throw -5
      Atomics.wait(control, 1, state, 20)
    }
    if (cancelled()) throw -5
  }
  const recycle = (frame: Uint8Array) => {
    try {
      hook('pre', frame)
      hook('post', frame)
    } finally {
      check(n.zc_release(result.handle, view(frame).getBigUint64(0, true)))
    }
  }
  const acquire = () => {
    const frame = storage(456)
    while (true) {
      if (cancelled()) throw -5
      const code = n.zc_acquire(result.handle, 20, ptr(frame))
      if (code === 0) {
        if (focusRevision !== undefined) {
          const metadata = storage(96)
          const token = view(frame).getBigUint64(0, true)
          let accepted = false
          try {
            check(n.zc_get_frame_metadata(result.handle, token, ptr(metadata)))
            const m = decodeMetadata(metadata)
            accepted =
              !!(m.validMask & 1) &&
              m.controlRevision >= focusRevision &&
              m.afState === 2
          } finally {
            if (!accepted) recycle(frame)
          }
          if (!accepted) continue
        }
        return frame
      }
      if (code !== -3) throw code
    }
  }
  let retainedFrame: Uint8Array | undefined
  let oldConsumed = false
  try {
    if (cancelled()) throw -5
    if (request.fresh && request.handle) throw -1
    close()
    oldConsumed = true
    Atomics.store(new Int32Array(request.cancel), 1, 1)
    open(request.config, request.pipeline, request.targetStarted ?? true)
    result.target = true
    Atomics.store(new Int32Array(request.cancel), 1, 3)
    for (let i = 0; i < request.dropFrames; i++) {
      const frame = acquire()
      recycle(frame)
    }
    if (request.autofocus) {
      const id = new BigUint64Array(1),
        state = new Uint32Array(1)
      check(n.zc_autofocus_start(result.handle, ptr(id)))
      try {
        while (true) {
          if (cancelled()) throw -5
          const code = n.zc_autofocus_wait(result.handle, id[0], 0, ptr(state))
          result.autofocusState = state[0]
          if (!code) {
            if (state[0] !== 3) throw -6
            break
          }
          if (code !== -3) throw code
          const frame = acquire()
          recycle(frame)
        }
      } finally {
        check(n.zc_autofocus_cancel(result.handle, id[0]))
      }
      const count = new Uint32Array(1),
        revision = new BigUint64Array(1)
      check(
        n.zc_get_controls(result.handle, null, 0, ptr(count), ptr(revision)),
      )
      result.controlRevision = revision[0]
      focusRevision = revision[0]
      // A successful observation can precede delivery of older ready frames.
      // Recycle one full buffer set through the focused-frame predicate before
      // publishing a permanent mode or selecting a temporary capture.
      const info = storage(680)
      check(n.zc_get_info(result.handle, ptr(info)))
      for (let i = 0; i < view(info).getUint32(4, true); i++) {
        const frame = acquire()
        recycle(frame)
      }
      if (request.fresh) {
        // A scan changes AfMode. Recover the original persistent recipe after
        // proving that scan completed; one-shot triggers are never replayed.
        const native = request.nativeControls,
          hasNativeAf =
            native && decodeCatalog(native).records.some((r) => r.appId === 13),
          legacy = view(request.controls)
        let hasLegacyAf = false
        for (let i = 0; i < request.controlCount; i++)
          if (legacy.getUint32(i * 144, true) === 13) hasLegacyAf = true
        const revision = new BigUint64Array(1)
        const replay = (code: number) => {
          if (code) result.controlCode = code
          check(code)
        }
        if (!hasLegacyAf && !hasNativeAf) {
          const lens = view(request.config).getFloat32(32, true),
            fallback = storage(lens >= 0 ? 288 : 144),
            d = view(fallback)
          d.setUint32(0, 13, true)
          d.setUint32(4, 2, true)
          d.setUint32(8, 1, true)
          d.setFloat64(16, lens >= 0 ? 0 : 2, true)
          if (lens >= 0) {
            d.setUint32(144, 12, true)
            d.setUint32(148, 3, true)
            d.setUint32(152, 1, true)
            d.setFloat64(160, lens, true)
          }
          replay(
            n.zc_set_controls(
              result.handle,
              ptr(fallback),
              fallback.length / 144,
              ptr(revision),
            ),
          )
        }
        if (request.controlCount)
          replay(
            n.zc_set_controls(
              result.handle,
              ptr(request.controls),
              request.controlCount,
              ptr(revision),
            ),
          )
        if (native && view(native).getUint32(12, true)) {
          // State/update catalogs share records; the setter revalidates every
          // exact payload against the replacement camera's current control map.
          const update = native.slice()
          view(update).setUint32(8, 6, true)
          replay(
            n.zc_set_native_controls(
              result.handle,
              ptr(update),
              BigInt(update.length),
              ptr(revision),
            ),
          )
        }
        if (revision[0]) result.controlRevision = revision[0]
        focusRevision = undefined
      }
    }
    if (request.capture) {
      const frame = acquire(),
        token = view(frame).getBigUint64(0, true)
      let prepared = false
      let complete = false
      try {
        hook('pre', frame)
        prepared = true
        const capture = request.capture
        if (capture.kind === 'request-stop') {
          // Transfer the existing acquisition only after the post hook retires.
        } else if (capture.kind === 'streams') {
          result.bundle = copyNativeStreams(
            result.handle,
            token,
            capture.streams!,
          )
        } else if (capture.kind === 'rgb') {
          const stream = storage(208)
          check(
            n.zc_get_stream(
              result.handle,
              token,
              capture.stream ?? 0,
              ptr(stream),
            ),
          )
          const d = view(stream)
          result.value = storage(
            d.getUint32(0, true) * d.getUint32(4, true) * 3,
          )
          check(
            n.zc_copy_stream_rgb(
              result.handle,
              token,
              capture.stream ?? 0,
              ptr(result.value),
              BigInt(result.value.length),
            ),
          )
        } else if (capture.kind === 'metadata') {
          result.value = storage(96)
          check(
            n.zc_get_frame_metadata(result.handle, token, ptr(result.value)),
          )
        } else if (capture.kind === 'encoded') {
          result.value = encodeNativeImage(
            result.handle,
            token,
            capture.imageOptions!,
            capture.stream,
            capture.imageProfile,
            capture.imageExif ??
              (view(capture.imageOptions!).getUint32(4, true) === 1
                ? { captureMetadata: true }
                : undefined),
          )
        } else if (capture.kind === 'file') {
          if (!capture.fileOutput) throw -2
          const options = capture.imageOptions ?? storage(20)
          if (!capture.imageOptions) {
            n.zc_default_image_options(ptr(options))
            view(options).setUint32(4, capture.dng ? 6 : 1, true)
            view(options).setUint32(8, capture.quality ?? 98, true)
          }
          stageNativeImage(
            capture.fileOutput,
            result.handle,
            token,
            options,
            capture.stream ?? (view(options).getUint32(4, true) === 6 ? 1 : 0),
            capture.imageProfile,
            capture.imageExif ??
              (view(options).getUint32(4, true) === 1
                ? { captureMetadata: true }
                : undefined),
          )
          result.value = storage(96)
          check(
            n.zc_get_frame_metadata(result.handle, token, ptr(result.value)),
          )
        } else {
          const name = (['main', 'raw', 'lores'] as const)[capture.stream ?? 0]
          const selected = copyNativeStreams(result.handle, token, [name])
            .streams[name]!
          result.value = selected.data
          result.stream = {
            width: selected.width,
            height: selected.height,
            format: selected.format,
          }
        }
        complete = true
      } finally {
        try {
          if (prepared) hook('post', frame)
          if (complete && request.capture.kind === 'request-stop')
            retainedFrame = frame
        } finally {
          if (retainedFrame !== frame) {
            const rc = n.zc_release(result.handle, token)
            if (rc === -4) {
              retainedFrame = frame
              result.requestCleanupCode = rc
            }
            check(rc)
          }
        }
      }
      if (retainedFrame) {
        check(n.zc_stop(result.handle))
        result.started = false
      }
    }
    if (cancelled()) throw -5
  } catch (code) {
    result.code = status(code)
  }
  if (result.code !== 0 && retainedFrame) {
    const rc = n.zc_release(
      result.handle,
      view(retainedFrame).getBigUint64(0, true),
    )
    if (rc !== 0) result.requestCleanupCode = rc
    // BUSY leaves ownership intact; expose it to the main-thread cleanup path.
    if (rc !== -4) retainedFrame = undefined
  }
  if (retainedFrame) result.requestFrame = retainedFrame
  if (request.fresh && !request.handle && result.code !== 0) {
    try {
      close()
    } catch (code) {
      result.restoreCode = status(code)
    }
  } else if (
    oldConsumed &&
    ((request.capture && request.capture.kind !== 'request-stop') ||
      result.code !== 0)
  ) {
    try {
      Atomics.store(new Int32Array(request.cancel), 1, 4)
      close()
      open(
        request.previousConfig,
        request.previousPipeline,
        request.previousStarted,
        true,
      )
      result.target = false
    } catch (code) {
      result.restoreCode = status(code)
    }
  } else if (
    !oldConsumed &&
    !result.started &&
    request.previousStarted &&
    result.handle
  ) {
    try {
      check(n.zc_start(result.handle))
      result.started = true
    } catch (code) {
      result.restoreCode = status(code)
    }
  }
  Atomics.store(new Int32Array(request.cancel), 1, 5)
  // Paired stream views share one owned buffer. Move it once rather than
  // cloning every pixel during worker publication; no DMA backing escapes.
  const transfers = new Set<ArrayBuffer>()
  if (result.bundle)
    for (const stream of Object.values(result.bundle.streams)) {
      if (stream && stream.data.buffer instanceof ArrayBuffer)
        transfers.add(stream.data.buffer)
    }
  observeLoss()
  if (!result.deviceLoss && (result.code === -11 || result.restoreCode === -11))
    result.deviceLoss = {
      connected: false,
      running: false,
      leased: 0,
      ready: 0,
      status: -11,
      disconnectEvent: 0n,
    }
  self.postMessage(result, [...transfers])
  // Bun has no WorkerGlobalScope.close(). The parent retires this worker only
  // after consuming the owned-handle response; throwing here could race that
  // handoff and turn a recoverable candidate into an unreachable native owner.
}
