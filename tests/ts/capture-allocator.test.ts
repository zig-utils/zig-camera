import { expect, test } from 'bun:test'
import { Camera, CaptureAllocator, CameraError, Recorder, type Recording, type CustomOutput, type OutputPacket, type OutputStreams, type Frame, type MappedStream } from '../../ts'
const failure = (job: PromiseLike<unknown>) => Promise.resolve(job).then(() => undefined, error => error)
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 1))
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000
  while (!predicate()) { if (performance.now() >= deadline) throw Error('test timeout'); await pause() }
}
const base = { simulate: true, width: 32, height: 24, buffers: 2, fifo: true }
const target = { width: 64, height: 48, buffers: 2, fifo: true }

test('persistent allocator validates options backend and closed or forged configuration owners', async () => {
  for (const options of [{ maxEntries: 0 }, { maxEntries: 17 }, { maxBytes: 0 }, { maxBytes: 1.5 }, { maxBytes: 9 * 1024 ** 3 }, { heapPath: 'x' }])
    expect(() => new CaptureAllocator({ simulate: true, ...options })).toThrow(RangeError)
  expect(() => new CaptureAllocator({ simulate: false })).toThrow(CameraError)
  expect(() => new Camera({ ...base, allocator: {} as CaptureAllocator })).toThrow(RangeError)
  const allocator = new CaptureAllocator({ simulate: true })
  expect(() => new Camera({ ...base, simulate: false, allocator })).toThrow(RangeError)
  allocator.close()
  expect(allocator.closed).toBe(true)
  allocator.close()
  expect(() => allocator.state).toThrow(CameraError)
  expect(() => new Camera({ ...base, allocator })).toThrow(CameraError)
})

test('persistent allocator retains frame/map borrowers across camera close and trims only idle storage', async () => {
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 2, maxBytes: 65536 })
  const old = new Camera({ ...base, allocator, writable: true, raw: true, lores: { width: 16, height: 8 } })
  let frame: Frame | undefined, map: MappedStream | undefined, replacement: Camera | undefined
  try {
    old.start(); frame = old.acquire(); map = frame.mapStream('main')
    frame.release(); frame = undefined
    expect(() => allocator.close()).toThrow(CameraError)
    replacement = new Camera(old.options)
    expect(allocator.state.borrowed).toBe(2)
    expect(allocator.state.allocations).toBe(12n)
    await replacement.close(); replacement = undefined
    allocator.trim()
    expect(allocator.state.entries).toBe(1)
    expect(map.planes[0].bytes.byteLength).toBeGreaterThan(0)
    map.close(); map = undefined
    await old.close()
    const reopened = new Camera({ ...base, allocator, raw: true, lores: { width: 16, height: 8 } })
    try {
      expect(allocator.state.allocations).toBe(12n)
      expect(allocator.state.reuses).toBe(1n)
      reopened.start()
      using captured = reopened.acquire()
      expect(captured.copyStream('lores').width).toBe(16)
    } finally { await reopened.close() }
  } finally { map?.close(); frame?.release(); await replacement?.close(); await old.close(); allocator.close() }
})

test('temporary paired-stream jobs share persistent mode backing and keep a native worker pin through callbacks', async () => {
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 2, maxBytes: 65536 })
  const camera = new Camera({ ...base, allocator, writable: true })
  camera.start()
  let callbacks = 0
  camera.preCallback = request => {
    if (request.width === 64) {
      callbacks++
      expect(allocator.state.pins).toBeGreaterThan(0)
      expect(() => allocator.close()).toThrow(CameraError)
    }
  }
  try {
    for (let i = 0; i < 3; i++) {
      const result = await camera.switchModeAndCaptureStreams({ ...target, raw: true, unpackedRaw: true, lores: { width: 16, height: 8 } }, ['main', 'raw', 'lores'])
      expect(result.streams.main!.width).toBe(64)
      expect(result.streams.raw!.width).toBe(64)
      expect(result.streams.lores!.width).toBe(16)
      expect(camera.options.allocator).toBe(allocator)
      expect(camera.info().width).toBe(32)
      expect(allocator.state.pins).toBe(0)
      expect(allocator.state.borrowed).toBe(1)
    }
    expect(callbacks).toBeGreaterThan(0)
    expect(allocator.state.preparations).toBe(2n)
    expect(allocator.state.allocations).toBe(8n)
    expect(allocator.state.reuses).toBeGreaterThanOrEqual(5n)
  } finally { await camera.close(); allocator.close() }
})

test('permanent mode switches inherit the allocator and reject replacement owners before dispatch', async () => {
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 2, maxBytes: 65536 })
  const other = new CaptureAllocator({ simulate: true })
  const camera = new Camera({ ...base, allocator })
  try {
    camera.start()
    expect(() => camera.switchMode({ ...target, allocator: other })).toThrow(CameraError)
    await camera.switchMode({ ...target, format: 'YUV420' })
    expect(camera.options.allocator).toBe(allocator)
    expect(camera.info().width).toBe(64)
    await camera.switchMode({ width: 32, height: 24, buffers: 2, fifo: true })
    expect(allocator.state.preparations).toBe(2n)
    expect(allocator.state.allocations).toBe(4n)
    expect(allocator.state.reuses).toBe(1n)
    expect(allocator.state.pins).toBe(0)
  } finally { await camera.close(); allocator.close(); other.close() }
})

test('oversized target allocation fails without evicting old backing and rollback reuses it', async () => {
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 1, maxBytes: 8000 })
  const camera = new Camera({ ...base, allocator })
  try {
    camera.start()
    expect(await failure(camera.switchMode(target))).toBeInstanceOf(CameraError)
    expect(camera.info().width).toBe(32)
    expect(allocator.state.allocations).toBe(2n)
    expect(allocator.state.borrowed).toBe(1)
    expect(allocator.state.pins).toBe(0)
    using frame = camera.acquire()
    expect(frame.copyRGB().length).toBe(32 * 24 * 3)
  } finally { await camera.close(); allocator.close() }
})

test('idle layout eviction allows bounded one-entry mode changes without retaining previous allocations', async () => {
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 1, maxBytes: 65536 })
  const camera = new Camera({ ...base, allocator })
  try {
    camera.start()
    await camera.switchMode(target)
    await camera.switchMode({ ...base })
    expect(allocator.state.entries).toBe(1)
    expect(allocator.state.retired).toBe(2n)
    expect(allocator.state.preparations).toBe(3n)
    expect(allocator.state.allocations).toBe(6n)
    expect(allocator.state.usedBytes).toBeLessThanOrEqual(allocator.state.maxBytes)
  } finally { await camera.close(); allocator.close() }
})

test('queued cancellation releases all allocator pins and preserves the source camera', async () => {
  const allocator = new CaptureAllocator({ simulate: true, maxBytes: 65536 })
  const camera = new Camera({ ...base, allocator })
  try {
    camera.start()
    const job = camera.switchMode(target)
    job.cancel(Error('cancel allocator mode'))
    expect(await failure(job)).toBeInstanceOf(Error)
    await job.cleanupDone
    expect(allocator.state.pins).toBe(0)
    expect(allocator.state.borrowed).toBe(1)
  } finally { await camera.close(); allocator.close() }
})

test('active target cancellation restores the source before retiring its worker pin', async () => {
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 2, maxBytes: 65536 })
  const camera = new Camera({ ...base, allocator })
  let job: ReturnType<Camera['switchModeAndCaptureRGB']> | undefined, cancelled = false
  camera.preCallback = request => {
    if (request.width === 64 && !cancelled) {
      cancelled = true
      expect(allocator.state.pins).toBeGreaterThan(0)
      job!.cancel(Error('cancel active allocator capture'))
    }
  }
  try {
    camera.start(); job = camera.switchModeAndCaptureRGB(target)
    expect(await failure(job)).toBeInstanceOf(Error)
    await job.cleanupDone
    expect(cancelled).toBe(true)
    expect(camera.info().width).toBe(32)
    expect(camera.stats().leased).toBe(0)
    expect(allocator.state.pins).toBe(0)
    expect(allocator.state.borrowed).toBe(1)
  } finally { await camera.close(); allocator.close() }
})

test('worker construction failure retires the pin acquired before the thread exists', async () => {
  const allocator = new CaptureAllocator({ simulate: true })
  const camera = new Camera({ ...base, allocator }), Original = globalThis.Worker
  let observed = false
  class Broken extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      if (allocator.state.pins === 1) {
        observed = true
        throw Error('injected allocator worker construction failure')
      }
      super(...args)
    }
  }
  try {
    camera.start(); globalThis.Worker = Broken
    expect(await failure(camera.switchMode(target))).toBeInstanceOf(Error)
    expect(observed).toBe(true)
    expect(allocator.state.pins).toBe(0)
  } finally { globalThis.Worker = Original; await camera.close(); allocator.close() }
})

test('failed worker dispatch retires its already-acquired allocator pin', async () => {
  const allocator = new CaptureAllocator({ simulate: true })
  const camera = new Camera({ ...base, allocator }), Original = globalThis.Worker
  let observed = false
  class Broken extends Original {
    override postMessage() {
      observed = allocator.state.pins === 1
      throw Error('injected allocator dispatch failure')
    }
  }
  try {
    camera.start(); globalThis.Worker = Broken
    expect(await failure(camera.switchMode(target))).toBeInstanceOf(Error)
    expect(observed).toBe(true)
    expect(allocator.state.pins).toBe(0)
  } finally { globalThis.Worker = Original; await camera.close(); allocator.close() }
})

test('reconnect allocates independent backing while a disconnected camera keeps a mapped request', async () => {
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 2, maxBytes: 65536 })
  const old = new Camera({ ...base, allocator, writable: true })
  let fresh: Camera | undefined, frame: Frame | undefined, map: MappedStream | undefined
  try {
    old.start(); frame = old.acquire(); map = frame.mapStream('main'); old.simulateDisconnect()
    fresh = await old.reconnect({ initialDelayMs: 0, maximumDelayMs: 0, pollMs: 2 })
    expect(fresh.options.allocator).toBe(allocator)
    expect(allocator.state.borrowed).toBe(2)
    expect(allocator.state.allocations).toBe(4n)
    expect(allocator.state.pins).toBe(0)
    expect(map.planes[0].bytes.byteLength).toBeGreaterThan(0)
    map.close(); map = undefined; frame.release(); frame = undefined
    await old.close(); allocator.trim()
    expect(allocator.state.entries).toBe(1)
    using captured = fresh.acquire()
    expect(captured.copyRGB().length).toBe(32 * 24 * 3)
  } finally { map?.close(); frame?.release(); await fresh?.close(); await old.close(); allocator.close() }
})

class Sink implements CustomOutput {
  packets = 0
  streams(_: OutputStreams) {}
  outputframe(_: OutputPacket) { this.packets++ }
}
test.if(process.env.ZC_TEST_CODECS === '1')('eight coordinated encoders retain one shared capture allocation per active camera mode', async () => {
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 2, maxBytes: 65536 })
  const camera = new Camera({ ...base, allocator }), recorders: Recorder[] = [], old: Recording[] = []
  try {
    for (let i = 0; i < 8; i++) {
      const recorder = await Recorder.open(new Sink(), { width: 32, height: 24, fps: 25, codec: 'mjpeg' })
      recorders.push(recorder); old.push(camera.startRecording(recorder))
    }
    await until(() => old.every(recording => recording.stats().completed >= 1n))
    const next = await camera.switchRecordingsModeAsync(target, old.map(recording => ({ recording, output: new Sink() })))
    await until(() => next.every(recording => recording.stats().completed >= 2n))
    expect(next.length).toBe(8)
    expect(camera.options.allocator).toBe(allocator)
    expect(allocator.state.allocations).toBe(4n)
    expect(allocator.state.preparations).toBe(2n)
    expect(allocator.state.borrowed).toBe(1)
    expect(allocator.state.pins).toBe(0)
  } finally { await camera.close(); for (const recorder of recorders) await recorder.close(); allocator.close() }
})
test.if(process.env.ZC_TEST_CODECS === '1')('coordinated recorder mode switching retains the same allocator through fresh recording pumps', async () => {
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 2, maxBytes: 65536 })
  const camera = new Camera({ ...base, allocator })
  const firstOutput = new Sink(), secondOutput = new Sink()
  const recorder = await Recorder.open(firstOutput, { width: 32, height: 24, fps: 25, codec: 'mjpeg' })
  let first: Recording | undefined, second: Recording | undefined
  try {
    first = camera.startRecording(recorder)
    await until(() => first!.frames >= 2)
    second = await first.switchModeAsync(target, { fps: 25, quality: 65 }, secondOutput)
    await until(() => second!.frames >= 2)
    expect(camera.options.allocator).toBe(allocator)
    expect(allocator.state.borrowed).toBe(1)
    expect(allocator.state.pins).toBe(0)
    expect(allocator.state.allocations).toBe(4n)
    expect(firstOutput.packets).toBeGreaterThan(0)
    expect(secondOutput.packets).toBeGreaterThan(0)
  } finally { await second?.close(); await first?.close(); await recorder.close(); await camera.close(); allocator.close() }
})
