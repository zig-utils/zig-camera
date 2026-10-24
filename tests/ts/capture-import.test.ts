import { expect, test } from 'bun:test'
import { Camera, CaptureAllocator, CameraError, type CaptureLayout, type CaptureImportBuffer } from '../../ts'
import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, fstatSync, writeSync } from 'node:fs'

const base = { simulate: true, width: 32, height: 24, buffers: 2, fifo: true }
const os = process.platform === 'linux' ? dlopen('libc.so.6', {
  memfd_create: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
  ftruncate: { args: [FFIType.i32, FFIType.i64], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  dup: { args: [FFIType.i32], returns: FFIType.i32 },
}).symbols : undefined
const linux = test.skipIf(process.platform !== 'linux')
function files(layout: CaptureLayout, sealed = true) {
  const fds: number[] = [], plans: CaptureImportBuffer[][] = []
  let cost = 0n
  try {
    for (const stream of layout.streams) {
      const list: CaptureImportBuffer[] = []
      for (let i = 0; i < stream.bufferCount; i++) {
        const fd = os!.memfd_create(Buffer.from('capture-import\0'), 3)
        if (fd < 0) throw Error('memfd_create')
        fds.push(fd)
        const offset = 4093n + BigInt(i), length = offset + stream.frameBytes + 71n
        if (os!.ftruncate(fd, length) !== 0) throw Error('ftruncate')
        writeSync(fd, Buffer.alloc(Number(length), 0xb7), 0, Number(length), 0)
        if (sealed && os!.fcntl(fd, 1033, 6) !== 0) throw Error('memfd seals')
        list.push({ fd, offset }); cost += length
      }
      plans.push(list)
    }
    return { plans, fds, cost, close() { for (const fd of fds.splice(0)) closeSync(fd) } }
  } catch (error) { for (const fd of fds) closeSync(fd); throw error }
}
async function recipe(options = base) {
  const camera = new Camera(options)
  try { return camera.captureLayout() } finally { await camera.close() }
}

test('capture layout snapshots own exact stream geometry and survive camera close', async () => {
  for (const format of ['BGR888', 'YUV420', 'NV12', 'RGB161616'] as const) {
    const camera = new Camera({ ...base, writable: true, format, raw: true, lores: { width: 16, height: 8, format } })
    try {
      const layout = camera.captureLayout()
      expect(layout.backend).toBe('synthetic'); expect(layout.cameraId).toBe(camera.cameraId)
      expect(Object.isFrozen(layout)).toBe(true); expect(Object.isFrozen(layout.streams)).toBe(true)
      expect(layout.streams.map(s => s.width)).toEqual([32, 16, 32])
      camera.start()
      using frame = camera.acquire()
      for (const [index, name] of (['main', 'lores', 'raw'] as const).entries()) {
        using mapped = frame.mapStream(name)
        expect(layout.streams[index].frameBytes).toBe(mapped.planes.reduce((n, plane) => n + BigInt(plane.bytes.length), 0n))
        expect(layout.streams[index].bufferCount).toBe(2)
      }
      frame.release(); await camera.close()
      expect(layout.streams[0].width).toBe(32)
      expect(() => camera.captureLayout()).toThrow(CameraError)
    } finally { await camera.close() }
  }
})

test('imported allocator validates mode and rejects unsupported hosts explicitly', () => {
  expect(() => new CaptureAllocator({ simulate: true, imported: 'yes' as unknown as boolean })).toThrow(RangeError)
  expect(() => new CaptureAllocator({ imported: true, heapPath: '/dev/dma_heap/x' })).toThrow(RangeError)
  if (process.platform !== 'linux') expect(() => new CaptureAllocator({ simulate: true, imported: true })).toThrow(CameraError)
  const managed = new CaptureAllocator({ simulate: true })
  try { expect(() => managed.importBuffers({} as CaptureLayout, [])).toThrow(RangeError) } finally { managed.close() }
})

linux('imported memfds charge whole backing, reject aliases and mutable files, and duplicate caller ownership', async () => {
  const layout = await recipe(), mutable = files(layout, false), source = files(layout)
  const allocator = new CaptureAllocator({ simulate: true, imported: true, maxBytes: Number(source.cost), maxEntries: 2 })
  try {
    expect(allocator.imported).toBe(true)
    expect(() => allocator.importBuffers(layout, mutable.plans)).toThrow(CameraError)
    expect(allocator.state.entries).toBe(0)
    const duplicate = os!.dup(source.plans[0][0].fd)
    expect(duplicate).toBeGreaterThanOrEqual(0)
    try { expect(() => allocator.importBuffers(layout, [[source.plans[0][0], { fd: duplicate, offset: 0n }]])).toThrow(CameraError) } finally { closeSync(duplicate) }
    expect(allocator.state.entries).toBe(0)
    allocator.importBuffers(layout, source.plans)
    expect(allocator.state.usedBytes).toBe(source.cost)
    expect(() => allocator.importBuffers(layout, source.plans)).toThrow(CameraError)
    const extra = files(layout)
    try { expect(() => allocator.importBuffers(layout, extra.plans)).toThrow(CameraError) } finally { extra.close() }
    for (const fd of source.fds) expect(fstatSync(fd).size).toBeGreaterThan(4093)
    source.close()
    const camera = new Camera({ ...base, writable: true, allocator })
    try {
      camera.start(); using frame = camera.acquire(); using exported = frame.exportFrame()
      expect(exported.info().staged).toBe(false)
      expect(exported.info().planes[0].offset).toBeGreaterThanOrEqual(4093n)
      expect(frame.copyRGB().length).toBe(32 * 24 * 3)
      expect(() => allocator.close()).toThrow(CameraError)
    } finally { await camera.close() }
    expect(allocator.state.borrowed).toBe(0)
    allocator.trim()
    expect(allocator.state.usedBytes).toBe(0n)
    expect(() => new Camera({ ...base, allocator })).toThrow(CameraError)
  } finally { mutable.close(); source.close(); allocator.close() }
})

linux('imported source/target sets survive asynchronous mode jobs and reject unprovisioned targets with rollback', async () => {
  const target = { ...base, width: 64, height: 48 }, sourceLayout = await recipe(), targetLayout = await recipe(target)
  const source = files(sourceLayout), destination = files(targetLayout)
  const allocator = new CaptureAllocator({ simulate: true, imported: true, maxEntries: 2 })
  let camera: Camera | undefined
  try {
    allocator.importBuffers(sourceLayout, source.plans); allocator.importBuffers(targetLayout, destination.plans)
    source.close(); destination.close()
    camera = new Camera({ ...base, allocator }); camera.start()
    const image = await camera.switchModeAndCaptureRGB(target)
    expect(image.length).toBe(64 * 48 * 3)
    expect(camera.captureLayout()).toEqual(sourceLayout)
    expect(allocator.state.pins).toBe(0)
    const failure = await Promise.resolve(camera.switchModeAndCaptureRGB({ ...target, width: 128 })).then(() => undefined, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(camera.captureLayout()).toEqual(sourceLayout)
    using frame = camera.acquire(); expect(frame.copyRGB().length).toBe(32 * 24 * 3)
    frame.release(); await camera.close(); camera = undefined
    expect(allocator.state.allocations).toBe(4n)
  } finally { await camera?.close(); source.close(); destination.close(); allocator.close() }
})

linux('independent imported same-layout sets support retained old maps across overlapping camera owners', async () => {
  const layout = await recipe(), first = files(layout), second = files(layout)
  const allocator = new CaptureAllocator({ simulate: true, imported: true, maxEntries: 2 })
  let old: Camera | undefined, replacement: Camera | undefined
  try {
    allocator.importBuffers(layout, first.plans); allocator.importBuffers(layout, second.plans)
    first.close(); second.close()
    old = new Camera({ ...base, allocator, writable: true }); old.start()
    const frame = old.acquire(), map = frame.mapStream('main'); frame.release()
    try {
      replacement = new Camera({ ...base, allocator })
      expect(allocator.state.borrowed).toBe(2)
      expect(() => new Camera({ ...base, allocator })).toThrow(CameraError)
      await replacement.close(); replacement = undefined
      expect(map.planes[0].bytes.length).toBeGreaterThan(0)
    } finally { map.close() }
    await old.close(); old = undefined
  } finally { await replacement?.close(); await old?.close(); first.close(); second.close(); allocator.close() }
})
