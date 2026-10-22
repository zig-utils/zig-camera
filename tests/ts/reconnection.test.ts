import { expect, test } from 'bun:test'
import {
  Camera,
  CameraWatch,
  CameraError,
  CameraCleanupError,
  Control,
  getTuningState,
  type Frame,
  type MappedStream,
} from '../../ts'
import { native as n } from '../../ts/ffi'
import type { ModeRequest } from '../../ts/mode-worker'
const cam = () =>
  new Camera({
    simulate: true,
    writable: true,
    width: 16,
    height: 16,
    buffers: 2,
    fifo: true,
    raw: true,
    unpackedRaw: true,
    lores: { width: 8, height: 8, rgb: true },
  })
const fast = { initialDelayMs: 0, maximumDelayMs: 0, pollMs: 2 }
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )

test('reconnection restores full configuration and exact controls without replacing old lease/map owners', async () => {
  const old = cam()
  let fresh: Camera | undefined,
    frame: Frame | undefined,
    map: MappedStream | undefined
  try {
    const vendor = old
      .controls()
      .records.find((r) => r.name === 'SyntheticInt64')!.id
    old.setControls([
      { id: Control.exposureTime, type: 'int', values: [12345] },
    ])
    old.setNativeControls([
      { id: vendor, kind: 'int64', value: 9007199254740993n },
    ])
    const revision = old.nativeControlSnapshot().revision
    old.start()
    frame = old.acquire()
    const held = frame.copyStreams(['main', 'raw', 'lores'])
    map = frame.mapStream('main')
    old.simulateDisconnect()
    const before = old.deviceState()
    const job = old.reconnect(fast)
    fresh = await job
    expect(job.recoveryState.attempts).toBe(1)
    expect(job.recoveryState.retryPending).toBe(false)
    expect(job.cameraId).toBe(old.cameraId)
    expect(fresh).not.toBe(old)
    expect(fresh.handle).not.toBe(old.handle)
    expect(fresh.cameraId).toBe(old.cameraId)
    expect(fresh.deviceState().connected).toBe(true)
    expect(old.deviceState()).toEqual(before)
    expect(() => frame!.copyStreams(['main', 'raw', 'lores'])).toThrow(
      CameraError,
    )
    expect(map.planes[0].bytes.byteLength).toBeGreaterThan(0)
    map.close()
    map = undefined
    expect(frame.copyStreams(['main', 'raw', 'lores'])).toEqual(held)
    expect(
      fresh
        .nativeControlSnapshot()
        .controls.records.find((r) => r.id === vendor)!.values[0].value,
    ).toBe(9007199254740993n)
    expect(fresh.nativeControlSnapshot().revision).toBeGreaterThan(revision)
    using captured = fresh.acquire()
    expect(
      captured.copyStreams(['main', 'raw', 'lores']).streams.lores!.width,
    ).toBe(8)
    expect(captured.metadata().exposureUs).toBe(12345)
    frame.release()
    frame = undefined
  } finally {
    map?.close()
    frame?.release()
    await fresh?.close()
    await old.close()
  }
})

test('worker retries only transient failed opens and never attempts rollback as another open', async () => {
  const old = cam(),
    Original = globalThis.Worker
  let failed = 2,
    attempts = 0
  class Transient extends Original {
    override postMessage(
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      const request = message as ModeRequest
      if (request.fresh) attempts++
      if (request.fresh && failed-- > 0) {
        queueMicrotask(() =>
          this.onmessage?.(
            new MessageEvent('message', {
              data: {
                handle: 0,
                code: -9,
                restoreCode: 0,
                controlCode: 0,
                restoreControlCode: 0,
                controlRevision: request.controlRevision,
                target: false,
                started: false,
              },
            }),
          ),
        )
      } else if (Array.isArray(options)) super.postMessage(message, options)
      else super.postMessage(message, options)
    }
  }
  let fresh: Camera | undefined
  globalThis.Worker = Transient
  try {
    old.simulateDisconnect()
    const job = old.reconnect({ ...fast, maxAttempts: 3 })
    fresh = await job
    expect(attempts).toBe(3)
    expect(job.recoveryState).toMatchObject({
      attempts: 3,
      maxAttempts: 3,
      exhausted: true,
      retryPending: false,
    })
    expect(job.lastOpenError).toMatchObject({ code: -9, restoreCode: 0 })
    expect(fresh.deviceState().running).toBe(false)
  } finally {
    globalThis.Worker = Original
    await fresh?.close()
    await old.close()
  }
})

test('absence or other camera IDs do not consume attempts; cancellation retires the manager watch', async () => {
  const old = cam(),
    discover = CameraWatch.prototype.discover
  CameraWatch.prototype.discover = () =>
    Object.freeze([
      {
        index: 0,
        id: 'different-camera',
        backend: 'synthetic',
        properties: [],
      },
    ])
  try {
    old.simulateDisconnect()
    const job = old.reconnect({ ...fast, maxAttempts: 1 })
    await Bun.sleep(8)
    expect(job.recoveryState.attempts).toBe(0)
    expect(() => old.reconnect(fast)).toThrow(CameraError)
    expect(job.cancel()).toBe(true)
    await expect(job.wait()).rejects.toThrow('job cancelled')
    await job.operationDone
    expect(getTuningState({ simulate: true }).managerUsers).toBe(1)
  } finally {
    CameraWatch.prototype.discover = discover
    await old.close()
  }
})

test('close cancels and joins reconnection and supports abort-listener close reentry', async () => {
  const old = cam(),
    discover = CameraWatch.prototype.discover
  CameraWatch.prototype.discover = () => []
  try {
    old.simulateDisconnect()
    const job = old.reconnect(fast)
    let nested: Promise<void> | undefined
    job.signal.addEventListener('abort', () => {
      nested = old.close()
    })
    const close = old.close()
    await close
    expect(nested).toBe(close)
    await expect(job.wait()).rejects.toMatchObject({ code: -2 })
    expect(job.done).toBe(true)
    expect(getTuningState({ simulate: true }).managerUsers).toBe(0)
  } finally {
    CameraWatch.prototype.discover = discover
    await old.close()
  }
})

test('new continuous AF and explicit scan/drop requirements are established on the replacement only', async () => {
  const old = cam()
  let fresh: Camera | undefined
  try {
    old.startContinuousAutofocus()
    old.simulateDisconnect()
    fresh = await old.reconnect({
      ...fast,
      start: true,
      dropFrames: 2,
      autofocus: true,
    })
    expect(
      fresh.controlSnapshot().controls.find((c) => c.id === Control.afMode)
        ?.values,
    ).toEqual([2])
    let focused = false
    for (let i = 0; i < 32 && !focused; i++) {
      using frame = await fresh.captureRequest()
      focused = frame.metadata().afState === 2
    }
    expect(focused).toBe(true)
    expect(old.deviceState().connected).toBe(false)
  } finally {
    await fresh?.close()
    await old.close()
  }
})

test('validation, healthy cameras and registration reentry cannot leak reconnection work', async () => {
  const old = cam()
  try {
    expect(() => old.reconnect(fast)).toThrow(CameraError)
    old.simulateDisconnect()
    for (const options of [
      { maxAttempts: 0 },
      { maxAttempts: 1025 },
      { initialDelayMs: -1 },
      { maximumDelayMs: 1, initialDelayMs: 2 },
      { pollMs: 0 },
      { start: false, dropFrames: 1 },
    ])
      expect(() => old.reconnect(options)).toThrow(RangeError)
    const controller = new AbortController(),
      signal = controller.signal,
      add = signal.addEventListener.bind(signal)
    let closing: Promise<void> | undefined
    Object.defineProperty(signal, 'addEventListener', {
      value: (...args: Parameters<typeof add>) => {
        closing = old.close()
        return add(...args)
      },
    })
    const job = old.reconnect({ ...fast, signal })
    await expect(job.wait()).rejects.toMatchObject({ code: -2 })
    await closing
    expect(job.recoveryState.attempts).toBe(0)
  } finally {
    await old.close()
  }
})

test('failed candidate constructor disposal retains an explicit retryable cleanup owner', async () => {
  const old = cam(),
    getInfo = n.zc_get_info,
    close = n.zc_close
  const mutable = n as unknown as {
    zc_get_info: (...args: Parameters<typeof getInfo>) => number
    zc_close: (...args: Parameters<typeof close>) => number
  }
  let error: unknown
  try {
    old.simulateDisconnect()
    mutable.zc_get_info = (...args) =>
      args[0] === old.handle ? getInfo(...args) : -6
    mutable.zc_close = (...args) =>
      args[0] === old.handle ? close(...args) : -6
    error = await failure(old.reconnect(fast))
    expect(error).toBeInstanceOf(CameraCleanupError)
    expect((error as CameraCleanupError).owners.length).toBe(1)
    expect(getTuningState({ simulate: true }).managerUsers).toBe(2)
  } finally {
    mutable.zc_get_info = getInfo
    mutable.zc_close = close
    if (error instanceof CameraCleanupError) await error.cleanup()
    await old.close()
  }
  expect(getTuningState({ simulate: true }).managerUsers).toBe(0)
})

test('transient exhaustion and control validation failures retain precise attempt counts', async () => {
  for (const code of [-9, -11, -1]) {
    const old = cam(),
      Original = globalThis.Worker
    let calls = 0
    class Failed extends Original {
      override postMessage(
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions,
      ) {
        const request = message as ModeRequest
        if (request.fresh) {
          calls++
          queueMicrotask(() =>
            this.onmessage?.(
              new MessageEvent('message', {
                data: {
                  handle: 0,
                  code,
                  controlCode: code === -9 ? 0 : code,
                  restoreCode: 0,
                  restoreControlCode: 0,
                  controlRevision: request.controlRevision,
                  target: false,
                  started: false,
                },
              }),
            ),
          )
        } else if (Array.isArray(options)) super.postMessage(message, options)
        else super.postMessage(message, options)
      }
    }
    globalThis.Worker = Failed
    try {
      old.simulateDisconnect()
      const job = old.reconnect({ ...fast, maxAttempts: 2 })
      await expect(job.wait()).rejects.toMatchObject({ code })
      expect(calls).toBe(code === -1 ? 1 : 2)
      expect(job.recoveryState.attempts).toBe(calls)
      expect(getTuningState({ simulate: true }).managerUsers).toBe(1)
    } finally {
      globalThis.Worker = Original
      await old.close()
    }
  }
})

test('cancellation after worker open joins candidate disposal before rejection', async () => {
  const old = cam(),
    Original = globalThis.Worker,
    reason = Error('cancel after worker open')
  let job: ReturnType<Camera['reconnect']> | undefined
  class Delayed extends Original {
    override postMessage(
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      const request = message as ModeRequest
      if (request.fresh) {
        const deliver = this.onmessage
        this.onmessage = (event) => {
          if (event.data.code === 0 && event.data.handle) {
            expect(job!.cancel(reason)).toBe(true)
            setTimeout(() => deliver?.call(this, event), 2)
          } else deliver?.call(this, event)
        }
      }
      if (Array.isArray(options)) super.postMessage(message, options)
      else super.postMessage(message, options)
    }
  }
  globalThis.Worker = Delayed
  try {
    old.simulateDisconnect()
    job = old.reconnect({ ...fast, start: true })
    expect(await failure(job)).toBe(reason)
    await job.operationDone
    expect(getTuningState({ simulate: true }).managerUsers).toBe(1)
    expect(old.deviceState().connected).toBe(false)
  } finally {
    globalThis.Worker = Original
    await old.close()
  }
})

test('pre-abort and monotonic deadline retire watches without spending an open attempt', async () => {
  const old = cam(),
    discover = CameraWatch.prototype.discover
  CameraWatch.prototype.discover = () => []
  try {
    old.simulateDisconnect()
    const aborted = new AbortController()
    aborted.abort(Error('not admitted'))
    const early = old.reconnect({ ...fast, signal: aborted.signal })
    await expect(early.wait()).rejects.toThrow('not admitted')
    await early.operationDone
    const deadline = old.reconnect({ ...fast, timeoutMs: 8 })
    await expect(deadline.wait()).rejects.toMatchObject({ code: -3 })
    expect(deadline.recoveryState.attempts).toBe(0)
    expect(getTuningState({ simulate: true }).managerUsers).toBe(1)
  } finally {
    CameraWatch.prototype.discover = discover
    await old.close()
  }
})

test('replacement owns tuning after a completion callback closes the source and captures new frames', async () => {
  const profile = '{"version":2,"algorithms":[]}'
  const old = new Camera({
    simulate: true,
    width: 16,
    height: 16,
    tuning: profile,
  })
  let fresh: Camera | undefined,
    called = false
  try {
    old.start()
    old.simulateDisconnect()
    const job = old.reconnect({
      ...fast,
      signalFunction: async (done) => {
        expect(done.value?.cameraId).toBe(old.cameraId)
        await old.close()
        using frame = await done.value!.captureRequest()
        expect(frame.width).toBe(16)
        called = true
      },
    })
    fresh = await job
    await job.cleanupDone
    expect(job.callbackError).toBeUndefined()
    expect(called).toBe(true)
    expect(getTuningState({ simulate: true })).toMatchObject({
      custom: true,
      sessionUsers: 1,
      managerUsers: 1,
    })
  } finally {
    await fresh?.close()
    await old.close()
  }
  expect(getTuningState({ simulate: true }).custom).toBe(false)
})

test('request pump preparation fails before publication and disposes the unclaimed replacement', async () => {
  const old = cam(),
    schedule = globalThis.setTimeout,
    reason = Error('pump preparation failed')
  old.setRequestCallbacks({ pre() {} })
  old.simulateDisconnect()
  globalThis.setTimeout = ((...args: Parameters<typeof schedule>) => {
    if (args[1] === 0) throw reason
    return schedule(...args)
  }) as typeof schedule
  try {
    const job = old.reconnect({ ...fast, start: true })
    expect(await failure(job)).toBe(reason)
    expect(job.phase).toBe(5)
    expect(getTuningState({ simulate: true }).managerUsers).toBe(1)
  } finally {
    globalThis.setTimeout = schedule
    await old.close()
  }
})
