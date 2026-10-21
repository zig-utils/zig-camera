import { decodeMetadata } from './metadata'
import {
  native as n,
  ptr,
  storage,
  outPointer,
  handle,
  view,
  type Pointer,
} from './ffi'
export interface ModeRequest {
  handle: Pointer
  cameraId: Uint8Array
  config: Uint8Array
  pipeline: Uint8Array
  previousConfig: Uint8Array
  previousPipeline: Uint8Array
  previousStarted: boolean
  writable?: boolean
  previousWritable?: boolean
  nativeControls?: Uint8Array
  controls: Uint8Array
  controlCount: number
  controlRevision: bigint
  cancel: SharedArrayBuffer
  deadline: number
  capture?: {
    kind: 'rgb' | 'stream' | 'metadata' | 'file'
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
  stream?: { width: number; height: number; format: string }
  /** Main-thread-only enrichment; never transported by the worker. */
  callbackError?: unknown
}
declare const self: {
  onmessage: (event: { data: ModeRequest }) => void
  postMessage: (value: ModeResponse | ModeRequestHook) => void
  close: () => void
}
self.onmessage = ({ data: request }) => {
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
    check(
      n.zc_open_id_pipeline(
        ptr(selected),
        ptr(pipeline),
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
    // AF start/cancel consumes revisions too. Preserve them across every rollback.
    const count = new Uint32Array(1),
      revision = new BigUint64Array(1)
    check(n.zc_get_controls(result.handle, null, 0, ptr(count), ptr(revision)))
    if (revision[0] > result.controlRevision)
      result.controlRevision = revision[0]
    check(n.zc_stop(result.handle))
    result.started = false
    check(n.zc_close(result.handle))
    result.handle = 0 as Pointer
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
  let oldConsumed = false
  try {
    if (cancelled()) throw -5
    close()
    oldConsumed = true
    Atomics.store(new Int32Array(request.cancel), 1, 1)
    open(request.config, request.pipeline, true)
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
    }
    if (request.capture) {
      const frame = acquire(),
        token = view(frame).getBigUint64(0, true)
      let prepared = false
      try {
        hook('pre', frame)
        prepared = true
        const capture = request.capture
        if (capture.kind === 'rgb') {
          const d = view(frame)
          result.value = storage(
            d.getUint32(40, true) * d.getUint32(44, true) * 3,
          )
          check(
            n.zc_copy_rgb(
              ptr(frame),
              ptr(result.value),
              BigInt(result.value.length),
            ),
          )
        } else if (capture.kind === 'metadata') {
          result.value = storage(96)
          check(
            n.zc_get_frame_metadata(result.handle, token, ptr(result.value)),
          )
        } else if (capture.kind === 'file') {
          check(
            capture.dng
              ? n.zc_save_dng(result.handle, token, ptr(capture.path!))
              : n.zc_save_jpeg(
                  result.handle,
                  token,
                  ptr(capture.path!),
                  capture.quality ?? 98,
                ),
          )
          result.value = storage(96)
          check(
            n.zc_get_frame_metadata(result.handle, token, ptr(result.value)),
          )
        } else {
          const stream = storage(208)
          check(
            n.zc_get_stream(
              result.handle,
              token,
              capture.stream ?? 0,
              ptr(stream),
            ),
          )
          const d = view(stream),
            width = d.getUint32(0, true),
            height = d.getUint32(4, true)
          const name = new TextDecoder()
            .decode(stream.subarray(16, 48))
            .split('\0')[0]
          const size = new BigUint64Array(1)
          check(n.zc_stream_copy_size(ptr(stream), ptr(size)))
          if (size[0] > BigInt(Number.MAX_SAFE_INTEGER)) throw -1
          result.value = storage(Number(size[0]))
          check(
            n.zc_copy_stream(
              ptr(stream),
              ptr(result.value),
              BigInt(result.value.length),
            ),
          )
          result.stream = { width, height, format: name }
        }
      } finally {
        try {
          if (prepared) hook('post', frame)
        } finally {
          check(n.zc_release(result.handle, token))
        }
      }
    }
    if (cancelled()) throw -5
  } catch (code) {
    result.code = typeof code === 'number' ? code : -6
  }
  if (oldConsumed && (request.capture || result.code !== 0)) {
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
      result.restoreCode = typeof code === 'number' ? code : -6
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
      result.restoreCode = typeof code === 'number' ? code : -6
    }
  }
  Atomics.store(new Int32Array(request.cancel), 1, 5)
  self.postMessage(result)
  self.close()
}
