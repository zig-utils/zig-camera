import { expect, test } from 'bun:test'
import { Camera, CaptureAllocator, CameraError, Recorder, ProcessPool, decodeJpeg, type CaptureLayout, type CaptureImportFrame, type CaptureImportPlane, type OutputPacket } from '../../ts'
import { encodeCaptureFrames } from '../../ts/capture-allocator'
import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, fstatSync, writeSync } from 'node:fs'
const linux = test.skipIf(process.platform !== 'linux')
const base = { simulate: true, width: 32, height: 24, buffers: 2, fifo: true }
const os = process.platform === 'linux' ? dlopen('libc.so.6', {
  memfd_create: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
  ftruncate: { args: [FFIType.i32, FFIType.i64], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  dup: { args: [FFIType.i32], returns: FFIType.i32 },
}).symbols : undefined
function guarded<T>(array: T[]) { Object.defineProperty(array, Symbol.iterator, { value() { throw Error('caller iterator invoked') } }); return array }
const scalarLayout = (): CaptureLayout => ({ backend: 'synthetic', cameraId: 'synthetic', streams: [{ width: 8, height: 4, stride: 8, bufferCount: 2, frameBytes: 48n, modifier: 0n, format: 'YUV420' }] })

test('plane descriptors own bounded scalar snapshots and ignore caller array iterators', () => {
  const layout = scalarLayout(), streams = guarded([...layout.streams])
  const planes = guarded([{ fd: 1, offset: 4093n, length: 32n }, { fd: 2, offset: 80n, length: 8n }, { fd: 2, offset: 96n, length: 8n }])
  const frames = guarded<CaptureImportFrame>([{ planes }, { fd: 3, offset: 7n }])
  const encoded = encodeCaptureFrames({ ...layout, streams }, guarded([frames])), data = new DataView(encoded.descriptors.buffer)
  expect(encoded.count).toBe(2); expect(encoded.descriptors.length).toBe(208)
  expect(data.getUint32(0, true)).toBe(104); expect(data.getUint32(4, true)).toBe(3)
  expect(data.getBigUint64(16, true)).toBe(4093n); expect(data.getBigUint64(24, true)).toBe(32n)
  expect(data.getUint32(108, true)).toBe(1); expect(data.getInt32(112, true)).toBe(3)
  expect(data.getBigUint64(120, true)).toBe(7n); expect(data.getBigUint64(128, true)).toBe(48n)
  planes[0].fd = 99; expect(data.getInt32(8, true)).toBe(1)
})

test('plane descriptor admission rejects excessive lists, short capacity and SDK range overflow before native I/O', () => {
  const layout = scalarLayout(), good = { fd: 1 }
  for (const invalid of [
    { planes: [] }, { planes: new Array(5).fill({ fd: 1, length: 48 }) },
    { planes: [{ fd: 1, length: 47 }] }, { planes: [{ fd: 1, offset: 0xffffffffn, length: 48 }] },
    { planes: [{ fd: -1, length: 48 }] }, { planes: [{ fd: 1, length: 0 }] },
  ]) expect(() => encodeCaptureFrames(layout, [[invalid, good]])).toThrow(RangeError)
  expect(() => encodeCaptureFrames({ ...layout, cameraId: 'x'.repeat(4097) }, [[good, good]])).toThrow(RangeError)
  expect(() => encodeCaptureFrames(layout, [new Array(65).fill(good)])).toThrow(RangeError)
})

type Mode = 'separate' | 'shared' | 'mixed'
function inputs(layout: CaptureLayout, mode: Mode) {
  const opened: number[] = [], frames: CaptureImportFrame[][] = []
  let cost = 0n, objects = 0
  try {
    for (const stream of layout.streams) {
      const y = BigInt(stream.stride) * BigInt(stream.height)
      const lengths = ['YUV420', 'YVU420'].includes(stream.format) ? [y, y / 4n, y / 4n] : ['NV12', 'NV21'].includes(stream.format) ? [y, y / 2n] : [stream.frameBytes]
      const list: CaptureImportFrame[] = []
      for (let frame = 0; frame < stream.bufferCount; frame++) {
        const groups = new Map<number, { fd: number; end: bigint }>(), planes: CaptureImportPlane[] = []
        for (const [index, length] of lengths.entries()) {
          const key = mode === 'separate' ? index : mode === 'shared' ? 0 : index === 0 ? 0 : 1
          let group = groups.get(key)
          if (!group) {
            const fd = os!.memfd_create(Buffer.from('capture-planes\0'), 3)
            if (fd < 0) throw Error('memfd_create')
            opened.push(fd); group = { fd, end: 4093n + BigInt(key) }; groups.set(key, group)
          }
          const offset = group.end; group.end = offset + length + 37n
          let fd = group.fd
          if (mode === 'mixed' && index === 2) { fd = os!.dup(fd); if (fd < 0) throw Error('dup'); opened.push(fd) }
          planes.push({ fd, offset, length })
        }
        for (const group of groups.values()) {
          const length = group.end + 71n
          if (os!.ftruncate(group.fd, length) !== 0) throw Error('ftruncate')
          writeSync(group.fd, Buffer.alloc(Number(length), 0xa5), 0, Number(length), 0)
          if (os!.fcntl(group.fd, 1033, 6) !== 0) throw Error('memfd seals')
          cost += length; objects++
        }
        list.push({ planes })
      }
      frames.push(list)
    }
    return { frames, cost, objects, opened, close() { for (const fd of opened.splice(0)) closeSync(fd) } }
  } catch (error) { for (const fd of opened) closeSync(fd); throw error }
}
async function recipe(options: ConstructorParameters<typeof Camera>[0]) {
  const camera = new Camera(options)
  try { return camera.captureLayout() } finally { await camera.close() }
}
async function reference(options: ConstructorParameters<typeof Camera>[0]) {
  const camera = new Camera(options)
  try { camera.start(); using frame = camera.acquire(); return { rgb: frame.copyRGB(), compact: frame.copyStream().data } } finally { await camera.close() }
}

for (const format of ['YUV420', 'YVU420', 'NV12', 'NV21'] as const) for (const mode of ['separate', 'shared', 'mixed'] as const)
  linux(`${format} ${mode} imports expose exact planes, preserve pixels and export original backing without staging`, async () => {
    const options = { ...base, format }, layout = await recipe(options), wanted = await reference(options), source = inputs(layout, mode)
    const allocator = new CaptureAllocator({ simulate: true, imported: true, maxEntries: 2, maxBytes: Number(source.cost) })
    let camera: Camera | undefined
    try {
      allocator.importFrames(layout, source.frames)
      expect(allocator.state.usedBytes).toBe(source.cost); expect(allocator.state.allocations).toBe(BigInt(source.objects))
      source.close() // all mappings/SDK descriptors now have independent ownership
      camera = new Camera({ ...options, allocator, writable: true }); camera.start()
      expect(camera.captureLayout()).toEqual(layout)
      using frame = camera.acquire()
      expect(frame.copyRGB()).toEqual(wanted.rgb); expect(frame.copyStream().data).toEqual(wanted.compact)
      frame.withMappedStream(map => {
        expect(map.planes.length).toBe(format.startsWith('NV') ? 2 : 3)
        expect(map.planes[0].offset).toBe(4093n)
        if (mode === 'shared') expect(new Set(map.planes.map(plane => plane.fd)).size).toBe(1)
        if (mode === 'separate') expect(new Set(map.planes.map(plane => plane.fd)).size).toBe(map.planes.length)
        if (mode === 'mixed' && map.planes.length === 3) { expect(map.planes[0].fd).not.toBe(map.planes[1].fd); expect(map.planes[1].fd).toBe(map.planes[2].fd) }
      })
      using exported = frame.exportFrame()
      expect(exported.info().staged).toBe(false); expect(exported.info().planes.length).toBe(format.startsWith('NV') ? 2 : 3)
      expect(allocator.state.writableMaps).toBe(BigInt(source.objects))
      exported.close(); frame.release(); await camera.close(); camera = undefined
      allocator.trim(); expect(allocator.state.usedBytes).toBe(0n)
    } finally { await camera?.close(); source.close(); allocator.close() }
  })

linux('plane imports reject cross-frame aliases, overlapping ranges, short chroma and budgets without preparing backing', async () => {
  const layout = await recipe({ ...base, format: 'YUV420' }), source = inputs(layout, 'mixed')
  const allocator = new CaptureAllocator({ simulate: true, imported: true })
  const frames = () => source.frames.map(list => list.map(frame => ({ planes: (frame as { planes: CaptureImportPlane[] }).planes.map(plane => ({ ...plane })) })))
  try {
    const alias = frames(); alias[0][1].planes[0] = { ...alias[0][0].planes[0] }
    expect(() => allocator.importFrames(layout, alias)).toThrow(CameraError)
    const overlap = frames(); overlap[0][0].planes[2].offset = overlap[0][0].planes[1].offset
    expect(() => allocator.importFrames(layout, overlap)).toThrow(CameraError)
    const short = frames(); short[0][0].planes[1].length = 1n; short[0][0].planes[0].length = BigInt(short[0][0].planes[0].length) + 999n
    expect(() => allocator.importFrames(layout, short)).toThrow(CameraError)
    expect(allocator.state.entries).toBe(0); expect(allocator.state.allocations).toBe(0n)
    const small = new CaptureAllocator({ simulate: true, imported: true, maxBytes: Number(source.cost - 1n) })
    try { expect(() => small.importFrames(layout, source.frames)).toThrow(CameraError); expect(small.state.entries).toBe(0) } finally { small.close() }
    for (const fd of source.opened) expect(fstatSync(fd).size).toBeGreaterThan(4093)
  } finally { source.close(); allocator.close() }
})

linux('caller getters cannot close a manual imported owner and leave a stale native handle during encoding', async () => {
  const layout = await recipe({ ...base, format: 'NV12' }), source = inputs(layout, 'separate')
  const allocator = new CaptureAllocator({ simulate: true, imported: true })
  const plane = (source.frames[0][0] as { planes: CaptureImportPlane[] }).planes[0], fd = plane.fd
  Object.defineProperty(plane, 'fd', { get() { allocator.close(); return fd } })
  try { expect(() => allocator.importFrames(layout, source.frames)).toThrow('closed'); expect(allocator.closed).toBe(true) }
  finally { source.close(); allocator.close() }
})

linux('factory supplies retain the exact new plane objects when an older matching profile becomes idle', async () => {
  let release!: () => void, entered!: () => void, calls = 0
  const ready = new Promise<void>(done => entered = done), gate = new Promise<void>(done => release = done)
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 2, factory: async context => {
    const source = inputs(context.layout, ++calls === 1 ? 'shared' : 'separate')
    if (calls === 2) { entered(); await gate }
    return { buffers: source.frames, release() { source.close() } }
  } })
  let first: Camera | undefined, second: Camera | undefined
  try {
    first = await Camera.open({ ...base, allocator, format: 'YUV420', writable: true })
    const opening = Camera.open({ ...base, allocator, format: 'YUV420', writable: true })
    await ready; await first.close(); first = undefined; release()
    second = await opening; second.start(); using frame = second.acquire()
    frame.withMappedStream(map => expect(new Set(map.planes.map(plane => plane.fd)).size).toBe(3))
    expect(calls).toBe(2); expect(allocator.state.borrowed).toBe(1)
  } finally { release(); await second?.close(); await first?.close(); allocator.close() }
})

linux('mixed main, lores and raw factories survive temporary mode restoration with exact logical frame sizes', async () => {
  const widths: number[] = []
  const allocator = new CaptureAllocator({ simulate: true, maxEntries: 3, factory: context => {
    widths.push(context.layout.streams[0].width)
    const source = inputs(context.layout, 'mixed')
    return { buffers: source.frames, release() { source.close() } }
  } })
  let camera: Camera | undefined
  try {
    camera = await Camera.open({ ...base, allocator, format: 'YUV420', lores: { width: 16, height: 8, format: 'NV21' }, raw: true, writable: true }); camera.start()
    const layout = camera.captureLayout()
    const captured = await camera.switchModeAndCaptureRGB({ width: 64, height: 48 })
    expect(captured.length).toBe(64 * 48 * 3); expect(camera.captureLayout()).toEqual(layout); expect(widths).toEqual([32, 64])
    using frame = camera.acquire()
    expect(frame.copyStream('lores').data.length).toBe(16 * 8 * 3 / 2); expect(frame.copyStream('raw').data.length).toBeGreaterThan(0)
    expect(allocator.state.pins).toBe(0)
  } finally { await camera?.close(); allocator.close() }
})

linux('separate-plane producer recording copies admission pixels before caller mutation and frame release', async () => {
  const options = { ...base, format: 'YUV420' as const }, layout = await recipe(options), source = inputs(layout, 'separate')
  const allocator = new CaptureAllocator({ simulate: true, imported: true }), packets: OutputPacket[] = [], expected: Uint8Array[] = []
  let camera: Camera | undefined, recorder: Recorder | undefined
  try {
    allocator.importFrames(layout, source.frames); source.close()
    camera = new Camera({ ...options, allocator, writable: true }); camera.start()
    recorder = await Recorder.open({ outputframe(packet) { packets.push(packet) } }, { width: 32, height: 24, quality: 98, asyncWrites: true, producerQueue: { maxBytes: 1152, maxOperations: 1 } })
    for (let index = 0; index < 3; index++) {
      using frame = camera.acquire(); expected.push(frame.copyRGB())
      const job = recorder.writeAsync(frame, BigInt(index) * 40_000_000n)
      frame.withMappedStream(map => { for (const plane of map.planes) plane.bytes.fill(0) })
      frame.release(); await job
    }
    await recorder.close(); recorder = undefined
    expect(packets.length).toBe(3)
    for (const [index, packet] of packets.entries()) {
      using decoded = decodeJpeg(packet.data)
      expect([decoded.image.width, decoded.image.height]).toEqual([32, 24])
      const actual = decoded.image.copyPixels(); let total = 0
      expect(actual.length).toBe(expected[index].length)
      for (let i = 0; i < actual.length; i++) total += Math.abs(actual[i] - expected[index][i])
      expect(total / actual.length).toBeLessThan(4)
    }
    expect(camera.stats().leased).toBe(0)
  } finally { await recorder?.close(); await camera?.close(); source.close(); allocator.close() }
})

linux('process IPC preserves multi-object and shared-object plane windows through real SCM_RIGHTS and ACK retirement', async () => {
  const options = { ...base, format: 'YUV420' as const, raw: true, lores: { width: 16, height: 8, format: 'NV12' as const } }, layout = await recipe(options), source = inputs(layout, 'mixed')
  const allocator = new CaptureAllocator({ simulate: true, imported: true })
  let camera: Camera | undefined, pool: ProcessPool | undefined
  try {
    allocator.importFrames(layout, source.frames); source.close()
    camera = new Camera({ ...options, allocator, writable: true }); camera.start()
    pool = await ProcessPool.open({ module: new URL('../fixtures/process-handler.ts', import.meta.url), workers: 1, camera })
    using frame = camera.acquire()
    let expected = 2166136261
    for (const name of ['main', 'raw', 'lores'] as const) frame.withMappedStream(map => {
      for (const plane of map.planes) for (const value of plane.bytes) expected = Math.imul(expected ^ value, 16777619) >>> 0
    }, name)
    const result = await pool.submit<{ pid: number; sequence: bigint; hash: number }>(frame, {}, { streams: ['main', 'raw', 'lores'] })
    expect(result.pid).not.toBe(process.pid); expect(result.sequence).toBe(frame.sequence); expect(result.hash).toBe(expected)
    await pool.drain(); expect(frame.referenceCount).toBe(1)
  } finally { await pool?.close(); await camera?.close(); source.close(); allocator.close() }
})
