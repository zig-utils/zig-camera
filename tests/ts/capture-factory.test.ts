import { expect, test } from 'bun:test'
import { Camera, CaptureAllocator, CameraError, Control, type CaptureFactoryContext, type CaptureFactoryBuffers } from '../../ts'
import { CaptureOpenScope } from '../../ts/capture-open-scope'
import { captureAllocatorHandle } from '../../ts/capture-allocator'
import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, writeSync } from 'node:fs'
const base = { simulate: true, width: 32, height: 24, buffers: 2, fifo: true }
const linux = test.skipIf(process.platform !== 'linux')
const os = process.platform === 'linux' ? dlopen('libc.so.6', {
  memfd_create: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
  ftruncate: { args: [FFIType.i32, FFIType.i64], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
}).symbols : undefined
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve } }
function files(context: CaptureFactoryContext): CaptureFactoryBuffers {
  const fds: number[] = []
  try {
    const buffers = context.layout.streams.map(stream => Array.from({ length: stream.bufferCount }, (_, index) => {
      const fd = os!.memfd_create(Buffer.from('capture-factory\0'), 3)
      if (fd < 0) throw Error('memfd_create')
      fds.push(fd)
      const offset = 4093n + BigInt(index), size = offset + stream.frameBytes + 17n
      if (os!.ftruncate(fd, size) !== 0) throw Error('ftruncate')
      writeSync(fd, Buffer.alloc(Number(size), 0x73), 0, Number(size), 0)
      if (os!.fcntl(fd, 1033, 6) !== 0) throw Error('seals')
      return { fd, offset }
    }))
    return { buffers, release() { for (const fd of fds.splice(0)) closeSync(fd) } }
  } catch (error) { for (const fd of fds) closeSync(fd); throw error }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() >= deadline) throw Error('condition deadline'); await Bun.sleep(1) }
}

test('native scopes retain allocator pins until a Bun worker actually detaches or exits', async () => {
  const allocator = new CaptureAllocator({ simulate: true })
  try {
    for (let i = 0; i < 8; i++) {
      const scope = new CaptureOpenScope(captureAllocatorHandle(allocator)!, undefined, false, Infinity)
      const worker = new Worker(new URL('./fixtures/capture-scope-worker.ts', import.meta.url).href)
      const entered = new Promise<void>((resolve, reject) => { worker.onmessage = () => resolve(); worker.onerror = event => reject(Error(event.message)) })
      try {
        worker.postMessage({ id: scope.id, explicit: !!(i % 2) }); await entered
        expect(allocator.state.pins).toBe(1)
        if (!(i % 2)) {
          expect(scope.state().threads).toBe(1)
          expect(() => scope.take()).toThrow(CameraError)
          expect(() => allocator.close()).toThrow(CameraError)
        }
        worker.terminate(); await scope.waitDetached()
        expect(Number(scope.take().handle)).toBe(0)
      } finally { worker.terminate(); await scope.waitDetached(); await scope.close() }
      expect(allocator.state.pins).toBe(0)
    }
  } finally { allocator.close() }
})

test('automatic capture factories validate options and reject unavailable hosts', () => {
  expect(() => new CaptureAllocator({ factory: 3 as never })).toThrow(RangeError)
  expect(() => new CaptureAllocator({ factory: () => ({ buffers: [] }), imported: false })).toThrow(RangeError)
  if (process.platform !== 'linux') expect(() => new CaptureAllocator({ simulate: true, factory: () => ({ buffers: [] }) })).toThrow(CameraError)
})

linux('automatic factories see negotiated streams and join asynchronous input release before initial publication', async () => {
  let calls = 0, releases = 0, ticks = 0
  const entered = deferred(), finish = deferred()
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 3, factory: async context => {
    calls++; expect(Object.isFrozen(context)).toBe(true); expect(context.layout.streams.map(s => s.width)).toEqual([32, 16, 32])
    expect(context.restoring).toBe(false); expect(typeof context.requestId).toBe('bigint'); expect(context.operationId).toBeGreaterThan(0n)
    await Bun.sleep(5)
    const input = files(context)
    return { buffers: input.buffers, async release() { releases++; entered.resolve(); await finish.promise; input.release!() } }
  } })
  let camera: Camera | undefined, published = false
  const timer = setInterval(() => ticks++, 1)
  const options = { ...base, allocator, writable: true, raw: true, lores: { width: 16, height: 8, format: 'NV12' as const } }
  try {
    expect(() => new Camera(options)).toThrow('Camera.open')
    const opening = Camera.open(options).then(value => { published = true; return value })
    await entered.promise
    expect(published).toBe(false); expect(allocator.state.borrowed).toBe(1)
    expect(() => allocator.close()).toThrow(CameraError)
    finish.resolve(); camera = await opening
    expect(ticks).toBeGreaterThan(0); expect(calls).toBe(1); expect(releases).toBe(1)
    camera.start(); using frame = camera.acquire(); using exported = frame.exportFrame()
    expect(exported.info().staged).toBe(false); expect(exported.info().planes[0].offset).toBeGreaterThanOrEqual(4093n)
    expect(frame.copyRGB().length).toBe(32 * 24 * 3)
    exported.close(); frame.release(); await camera.close(); camera = undefined
    const reused = await Camera.open(options); await reused.close()
    expect(calls).toBe(1); expect(allocator.state.pins).toBe(0); expect(allocator.state.reuses).toBeGreaterThan(0n)
  } finally { finish.resolve(); clearInterval(timer); await camera?.close(); allocator.close() }
})

linux('cancellation joins late factory inputs and their release without publishing or leaking a scope', async () => {
  const entered = deferred(), supply = deferred(), releaseStarted = deferred(), releaseFinish = deferred(), controller = new AbortController()
  let released = 0, seen: AbortSignal | undefined, settled = false
  const allocator = new CaptureAllocator({ simulate: true, factory: async context => {
    seen = context.signal; entered.resolve(); await supply.promise
    const input = files(context)
    return { buffers: input.buffers, async release() { released++; releaseStarted.resolve(); await releaseFinish.promise; input.release!() } }
  } })
  try {
    const opening = Camera.open({ ...base, allocator }, { signal: controller.signal }).then(value => value.close(), error => error).then(value => { settled = true; return value })
    await entered.promise; controller.abort(Error('cancel factory open')); await until(() => !!seen?.aborted)
    expect(settled).toBe(false); expect(() => allocator.close()).toThrow(CameraError)
    supply.resolve(); await releaseStarted.promise; expect(settled).toBe(false)
    releaseFinish.resolve(); expect(await opening).toBeInstanceOf(Error)
    expect(released).toBe(1); expect(allocator.state.pins).toBe(0); expect(allocator.state.borrowed).toBe(0); expect(allocator.state.entries).toBe(0)
  } finally { supply.resolve(); releaseFinish.resolve(); allocator.close() }
})

linux('factory failures preserve the source profile and runtime controls during mode rollback', async () => {
  let calls = 0, released = 0
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 3, factory: context => {
    calls++
    if (context.layout.streams[0].width === 64) throw new Error('target storage unavailable')
    const input = files(context); return { buffers: input.buffers, release() { released++; input.release!() } }
  } })
  let camera: Camera | undefined
  try {
    camera = await Camera.open({ ...base, allocator }); camera.start()
    const source = camera.captureLayout()
    camera.setControls([{ id: Control.brightness, type: 'float', values: [0.25] }])
    const failed = await Promise.resolve(camera.switchModeAndCaptureRGB({ ...base, width: 64, height: 48 })).then(() => undefined, error => error)
    expect(failed).toBeInstanceOf(Error); expect(camera.captureLayout()).toEqual(source)
    using frame = camera.acquire(); expect(frame.copyRGB().length).toBe(32 * 24 * 3)
    expect(calls).toBe(2); expect(released).toBe(1); expect(allocator.state.pins).toBe(0)
  } finally { await camera?.close(); allocator.close() }
})

linux('automatic target allocation reuses source storage through capture and coordinated mode ownership', async () => {
  const widths: number[] = []
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 3, factory: context => { widths.push(context.layout.streams[0].width); return files(context) } })
  let camera: Camera | undefined
  try {
    camera = await Camera.open({ ...base, allocator }); camera.start()
    const source = camera.captureLayout()
    expect((await camera.switchModeAndCaptureRGB({ ...base, width: 64, height: 48 })).length).toBe(64 * 48 * 3)
    expect(camera.captureLayout()).toEqual(source); expect(widths).toEqual([32, 64])
    expect((await camera.switchModeAndCaptureRGB({ ...base, width: 64, height: 48 })).length).toBe(64 * 48 * 3)
    expect(widths).toEqual([32, 64]); expect(allocator.state.pins).toBe(0)
  } finally { await camera?.close(); allocator.close() }
})

linux('factory timeout status completes and input release failures retain diagnostics for explicit caller recovery', async () => {
  let attempts = 0, returned: CaptureFactoryBuffers | undefined, releases = 0
  const allocator = new CaptureAllocator({ simulate: true, factory: context => {
    if (++attempts === 1) throw new CameraError(-3, 'factory timed out')
    const input = files(context)
    returned = { buffers: input.buffers, release() { releases++; input.release!(); throw Error('input release diagnostic') } }
    return returned
  } })
  try {
    const first = await Camera.open({ ...base, allocator }).then(async value => { await value.close(); return undefined }, error => error)
    expect(first).toBeInstanceOf(Error); expect(attempts).toBe(1); expect(allocator.state.pins).toBe(0)
    const failed = await Camera.open({ ...base, allocator }).then(async value => { await value.close(); return undefined }, error => error)
    expect(failed).toBeInstanceOf(AggregateError)
    const collected: unknown[] = []
    const collect = (error: unknown) => { collected.push(error); if (error instanceof AggregateError) for (const item of error.errors) collect(item) }
    collect(failed)
    expect(collected.some(error => (error as { returnedInputs?: unknown })?.returnedInputs === returned)).toBe(true)
    expect(releases).toBe(1); expect(allocator.state.borrowed).toBe(0); expect(allocator.state.pins).toBe(0)
    allocator.trim(); expect(allocator.state.entries).toBe(0)
  } finally { allocator.close() }
})

linux('same-layout overlapping cameras allocate independent bounded sets while old mappings remain valid', async () => {
  let calls = 0
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 2, factory: context => { calls++; return files(context) } })
  let first: Camera | undefined, second: Camera | undefined
  try {
    first = await Camera.open({ ...base, allocator }); first.start()
    const frame = first.acquire(), map = frame.mapStream('main'); frame.release()
    try {
      second = await Camera.open({ ...base, allocator })
      expect(allocator.state.borrowed).toBe(2)
      const third = await Camera.open({ ...base, allocator }).then(async value => { await value.close(); return undefined }, error => error)
      expect(third).toBeInstanceOf(Error); expect(calls).toBe(3)
      await second.close(); second = undefined
      expect(map.planes[0].bytes.length).toBeGreaterThan(0)
    } finally { map.close() }
  } finally { await second?.close(); await first?.close(); allocator.close() }
})

linux('cancelled target preparation can provision mandatory rollback after the source profile was trimmed', async () => {
  const target = deferred(), finish = deferred()
  const calls: { width: number; restoring: boolean; aborted: boolean }[] = []
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 2, factory: async context => {
    calls.push({ width: context.layout.streams[0].width, restoring: context.restoring, aborted: context.signal.aborted })
    if (context.layout.streams[0].width === 64) {
      allocator.trim() // force restoration to require a fresh factory request
      target.resolve(); await finish.promise
    }
    return files(context)
  } })
  let camera: Camera | undefined
  try {
    camera = await Camera.open({ ...base, allocator }); camera.start()
    const job = camera.switchModeAndCaptureRGB({ ...base, width: 64, height: 48 })
    const failed = Promise.resolve(job).then(() => undefined, error => error)
    await target.promise; job.cancel(Error('cancel target preparation')); finish.resolve()
    expect(await failed).toBeInstanceOf(Error); await job.cleanupDone
    expect(calls).toEqual([{ width: 32, restoring: false, aborted: false }, { width: 64, restoring: false, aborted: false }, { width: 32, restoring: true, aborted: false }])
    expect(camera.captureLayout().streams[0].width).toBe(32)
    using frame = camera.acquire(); expect(frame.copyRGB().length).toBe(32 * 24 * 3)
    expect(allocator.state.pins).toBe(0)
  } finally { finish.resolve(); await camera?.close(); allocator.close() }
})

linux('factory mode worker constructor and dispatch failures restore caller ownership and retire opening scopes', async () => {
  const allocator = new CaptureAllocator({ simulate: true, factory: files }), Original = globalThis.Worker
  let camera: Camera | undefined
  try {
    camera = await Camera.open({ ...base, allocator }); camera.start()
    const original = camera.handle
    for (const dispatch of [false, true]) {
      class Broken extends Original {
        constructor(...args: ConstructorParameters<typeof Original>) {
          if (!dispatch) throw Error('factory worker constructor fault')
          super(...args)
        }
        override postMessage() { throw Error('factory worker dispatch fault') }
      }
      globalThis.Worker = Broken
      try {
        const error = await Promise.resolve(camera.switchMode({ ...base, width: 64, height: 48 })).then(() => undefined, error => error)
        expect(error).toBeInstanceOf(Error); expect(camera.handle).toBe(original)
        expect(camera.info().width).toBe(32); expect(allocator.state.pins).toBe(0)
      } finally { globalThis.Worker = Original }
    }
    using frame = camera.acquire(); expect(frame.copyRGB().length).toBe(32 * 24 * 3)
  } finally { globalThis.Worker = Original; await camera?.close(); allocator.close() }
})

linux('a factory worker fault before native entry recovers the retained source handle instead of losing it', async () => {
  const allocator = new CaptureAllocator({ simulate: true, factory: files }), Original = globalThis.Worker
  let camera: Camera | undefined
  try {
    camera = await Camera.open({ ...base, allocator }); camera.start()
    const original = camera.handle
    globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
      if (!String(url).endsWith('/mode-worker.ts')) return new Original(url, options)
      return {
        onmessage: undefined,
        onerror: undefined as ((event: { message: string }) => void) | undefined,
        postMessage() { queueMicrotask(() => this.onerror?.({ message: 'pre-entry factory worker fault' })) },
        terminate() {},
      }
    } as unknown as typeof Worker
    try {
      const error = await Promise.resolve(camera.switchMode({ ...base, width: 64, height: 48 })).then(() => undefined, error => error)
      expect(error).toBeInstanceOf(Error); expect(camera.handle).toBe(original)
      expect(camera.info().width).toBe(32); expect(allocator.state.pins).toBe(0)
    } finally { globalThis.Worker = Original }
    using frame = camera.acquire(); expect(frame.copyRGB().length).toBe(32 * 24 * 3)
  } finally { globalThis.Worker = Original; await camera?.close(); allocator.close() }
})

linux('pre-abort and expired initial deadlines skip application factories and retire their scope pins', async () => {
  let calls = 0
  const allocator = new CaptureAllocator({ simulate: true, factory: context => { calls++; return files(context) } })
  const controller = new AbortController(), reason = Error('skip initial allocation')
  controller.abort(reason)
  try {
    expect(await Camera.open({ ...base, allocator }, { signal: controller.signal }).catch(error => error)).toBe(reason)
    expect(await Camera.open({ ...base, allocator }, { timeoutMs: 0 }).catch(error => error)).toMatchObject({ code: -3 })
    expect(calls).toBe(0); expect(allocator.state.pins).toBe(0)
  } finally { allocator.close() }
})
