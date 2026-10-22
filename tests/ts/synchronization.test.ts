import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  type CaptureOptions,
  type Frame,
  type TypedCatalog,
} from '../../ts'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const cam = () =>
  new Camera({ simulate: true, width: 16, height: 12, buffers: 4, fifo: true })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
async function until(predicate: () => boolean) {
  const end = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() >= end) throw Error('observation timed out')
    await Bun.sleep(1)
  }
}
const setting = (c: Camera, name: string) =>
  c
    .nativeControlSnapshot()
    .controls.records.find((record) => record.name === name)?.values[0].value
test('missing synchronization metadata stays absent and never qualifies a synchronized capture', async () => {
  const c = cam()
  try {
    using frame = await c.captureRequest()
    expect(frame.synchronization()).toEqual({})
    expect(
      frame
        .metadataCatalog()
        .records.find((record) => record.name === 'SyncReady'),
    ).toBeUndefined()
    frame.release()
    const job = c.captureSyncRequestAsync({ timeoutMs: 20 })
    expect(await failure(job)).toMatchObject({ code: -3 })
    await job.cleanupDone
    expect(c.stats().leased).toBe(0)
    using ordinary = await c.captureRequest()
    expect(ordinary.synchronization()).toEqual({})
  } finally {
    await c.close()
  }
})
test('virtual server selects the first ready FIFO request and retains exact signed timing after stop', async () => {
  const c = cam()
  try {
    const revision = c.setSynchronization('server', { frames: 4 })
    expect(revision).toBe(1n)
    using frame = await c.captureSyncRequest()
    expect(frame.sequence).toBe(3n)
    expect(frame.synchronization()).toEqual({ ready: true, timerUs: 0n })
    expect(Object.isFrozen(frame.synchronization())).toBe(true)
    const catalog = frame.metadataCatalog()
    expect(
      catalog.records.find((record) => record.name === 'SyncReady'),
    ).toMatchObject({ vendor: 'rpi', kind: 'boolean' })
    expect(
      catalog.records.find((record) => record.name === 'SyncReady')!.values[0]
        .value,
    ).toBe(true)
    expect(
      catalog.records.find((record) => record.name === 'SyncTimer')!.values[0]
        .value,
    ).toBe(0n)
    using retained = frame.retain()
    frame.release()
    using later = await c.captureSyncRequest()
    expect(later.sequence).toBe(4n)
    expect(later.synchronization().timerUs).toBeLessThan(0n)
    later.release()
    await c.stop()
    expect(retained.synchronization()).toEqual({ ready: true, timerUs: 0n })
    retained.release()
    expect(() => retained.synchronization()).toThrow()
    c.start()
    using restarted = await c.captureRequest()
    expect(restarted.synchronization().ready).toBe(false)
    expect(restarted.synchronization().timerUs).toBeGreaterThan(0n)
  } finally {
    await c.close()
  }
})
test('ready selection composes with exact drops and flush while hooks observe every request', async () => {
  const c = cam(),
    seen: Array<{ sequence: bigint; ready?: boolean }> = []
  try {
    c.setSynchronization('server', { frames: 3 })
    c.preCallback = (request) =>
      seen.push({
        sequence: request.sequence,
        ready: request.synchronization().ready,
      })
    const bytes = await c.captureRGBAsync({
      syncReady: true,
      dropFrames: 5,
      flush: 0n,
    })
    expect(bytes.length).toBe(16 * 12 * 3)
    expect(seen.slice(0, 6)).toEqual(
      Array.from({ length: 6 }, (_, i) => ({
        sequence: BigInt(i),
        ready: i >= 2,
      })),
    )
    using next = await c.captureSyncRequest({ syncReady: false })
    expect(next.synchronization().ready).toBe(true)
    expect(next.sequence).toBeGreaterThan(5n)
  } finally {
    await c.close()
  }
})
test('retained pending metadata does not become ready when later requests or controls change', async () => {
  const c = cam()
  try {
    c.setSynchronization('server', { frames: 4 })
    using first = await c.captureRequest()
    const observation = first.synchronization()
    expect(observation.ready).toBe(false)
    using ready = await c.captureSyncRequest()
    ready.release()
    c.setSynchronization('off')
    await c.stop()
    expect(first.synchronization()).toEqual(observation)
  } finally {
    await c.close()
  }
})
test('focus-locked selection requires both paused focus and readiness, then restores CAF', async () => {
  const c = cam()
  try {
    c.setSynchronization('server', { frames: 20 })
    c.startContinuousAutofocus()
    using request = await c.captureFocusLockedRequest({
      syncReady: true,
      dropFrames: 2,
      flush: 0n,
    })
    expect(request.synchronization().ready).toBe(true)
    expect(request.sequence).toBeGreaterThanOrEqual(19n)
    expect(request.metadata()).toMatchObject({ afState: 2, afPauseState: 2 })
    request.release()
    expect(await c.autofocusResumeAsync()).toBe(3)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('a sync timeout in a focus-locked capture restores CAF and retires the request owner', async () => {
  const c = cam()
  try {
    c.setSynchronization('client')
    c.startContinuousAutofocus()
    const job = c.captureFocusLockedRequestAsync({
      syncReady: true,
      timeoutMs: 30,
    })
    expect(await failure(job)).toMatchObject({ code: -3 })
    await job.cleanupDone
    expect(c.stats().leased).toBe(0)
    expect(await c.autofocusResumeAsync()).toBe(3)
  } finally {
    await c.close()
  }
})
test('pre-aborted sync capture never starts or acquires a request', async () => {
  const c = cam(),
    controller = new AbortController(),
    reason = Error('pre-aborted')
  controller.abort(reason)
  try {
    const job = c.captureSyncRequestAsync({ signal: controller.signal })
    expect(await failure(job)).toBe(reason)
    await job.cleanupDone
    expect(c.stats().delivered).toBe(0n)
    expect(c.stats().completed).toBe(0n)
  } finally {
    await c.close()
  }
})
test('a client without server messages stays pending, supports abort, and preserves queued captures', async () => {
  const c = cam(),
    controller = new AbortController(),
    reason = Object.freeze(Error('leave synchronization wait'))
  let observed = 0
  try {
    c.setSynchronization('client')
    c.preCallback = () => {
      observed++
    }
    const waiting = c.captureSyncRequestAsync({ signal: controller.signal }),
      queued = c.captureRequestAsync()
    await until(() => observed >= 5)
    controller.abort(reason)
    expect(await failure(waiting)).toBe(reason)
    await waiting.cleanupDone
    using ordinary = await queued
    expect(ordinary.synchronization()).toEqual({ ready: false })
    ordinary.release()
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
for (const action of ['stop', 'close'] as const)
  test(`${action} cancels and joins a pending synchronization request`, async () => {
    const c = cam()
    let observed = 0
    try {
      c.setSynchronization('client')
      c.preCallback = () => {
        observed++
      }
      const job = c.captureSyncRequestAsync()
      await until(() => observed > 0)
      await c[action]()
      expect(await failure(job)).toBeInstanceOf(Error)
      await job.cleanupDone
      if (action === 'stop') {
        expect(c.stats().leased).toBe(0)
        c.start()
        using next = await c.captureRequest()
        expect(next.synchronization().ready).toBe(false)
      }
    } finally {
      await c.close()
    }
  })
test('readiness and scheduling accessors are snapshotted once before capture ownership', async () => {
  const c = cam(),
    reads = { syncReady: 0, dropFrames: 0, flush: 0 }
  try {
    c.setSynchronization('server', { frames: 4 })
    const options: CaptureOptions<Frame> = {
      get syncReady() {
        reads.syncReady++
        return true
      },
      get dropFrames() {
        reads.dropFrames++
        return 1
      },
      get flush() {
        reads.flush++
        return 0n
      },
    }
    const job = c.captureRequestAsync(options)
    Object.defineProperty(options, 'syncReady', { value: false })
    using frame = await job
    expect(reads).toEqual({ syncReady: 1, dropFrames: 1, flush: 1 })
    expect(frame.sequence).toBe(3n)
    expect(frame.synchronization().ready).toBe(true)
  } finally {
    await c.close()
  }
})
test('invalid synchronization options reject before controls or camera state change', async () => {
  const c = cam()
  try {
    for (const mode of ['unknown', '__proto__', 0, null, {}, true])
      expect(() => c.setSynchronization(mode as never)).toThrow()
    for (const frames of [0, -1, NaN, Infinity, 1.5, 0x80000000])
      expect(() => c.setSynchronization('server', { frames })).toThrow()
    expect(() => c.setSynchronization('client', { frames: 1 })).toThrow()
    expect(() => c.setSynchronization('server', null as never)).toThrow()
    expect(() => c.captureRequestAsync({ syncReady: 1 as never })).toThrow()
    expect(c.nativeControlSnapshot().revision).toBe(0n)
    expect(c.stats().delivered).toBe(0n)
    let reads = 0
    c.setSynchronization('server', {
      get frames() {
        reads++
        return 3
      },
    })
    expect(reads).toBe(1)
  } finally {
    await c.close()
  }
})
test('missing foreign ambiguous or malformed sync controls fail without a partial update', async () => {
  const c = cam(),
    original = c.controls.bind(c),
    catalog = original(),
    mode = catalog.records.find((record) => record.name === 'SyncMode')!
  try {
    const alternatives: TypedCatalog[] = [
      {
        ...catalog,
        records: catalog.records.filter((record) => record.name !== 'SyncMode'),
      },
      {
        ...catalog,
        records: catalog.records.map((record) =>
          record === mode ? { ...record, vendor: 'third-party' } : record,
        ),
      },
      {
        ...catalog,
        records: [
          ...catalog.records,
          { ...mode, id: mode.id + 100, vendor: 'libcamera' },
        ],
      },
      {
        ...catalog,
        records: catalog.records.map((record) =>
          record === mode ? { ...record, kind: 'boolean' } : record,
        ),
      },
      {
        ...catalog,
        records: catalog.records.map((record) =>
          record === mode ? { ...record, input: false } : record,
        ),
      },
    ]
    for (const candidate of alternatives) {
      c.controls = () => candidate
      expect(() => c.setSynchronization('server', { frames: 4 })).toThrow(
        '(-8)',
      )
      expect(c.nativeControlSnapshot().revision).toBe(0n)
    }
    c.controls = original
    const saved = c.setSynchronization('server', { frames: 7 })
    expect(() =>
      c.setNativeControls([{ id: mode.id, kind: 'int32', value: 3 }]),
    ).toThrow()
    expect(c.nativeControlSnapshot().revision).toBe(saved)
    expect(setting(c, 'SyncFrames')).toBe(7)
  } finally {
    c.controls = original
    await c.close()
  }
})
test('synchronization controls survive camera mode restoration and readiness restarts per session', async () => {
  const c = cam()
  try {
    c.setSynchronization('server', { frames: 6 })
    using first = await c.captureSyncRequest()
    first.release()
    await c.switchMode({ width: 20, height: 14, fifo: true })
    expect(setting(c, 'SyncMode')).toBe(1)
    expect(setting(c, 'SyncFrames')).toBe(6)
    using pending = await c.captureRequest()
    expect(pending.synchronization().ready).toBe(false)
    pending.release()
    using synced = await c.captureSyncRequest()
    expect(synced.width).toBe(20)
    expect(synced.synchronization().ready).toBe(true)
  } finally {
    await c.close()
  }
})
test('pending sync selection preserves recording preview and request callback delivery', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-sync-recording-')),
    path = join(dir, 'video.mkv'),
    recorder = new Recorder(path, { width: 16, height: 12 })
  let observed = 0
  try {
    c.setSynchronization('client')
    c.preCallback = (request) => {
      expect(request.synchronization().ready).toBe(false)
      observed++
    }
    c.startPreview({ backend: 'headless' })
    const recording = c.startRecording(recorder),
      job = c.captureSyncRequestAsync()
    await until(() => observed >= 6)
    expect(job.done).toBe(false)
    expect(recorder.stats().outputFrames).toBeGreaterThan(0n)
    expect(c.previewInfo()).toMatchObject({
      backend: 'headless',
      suspended: false,
    })
    job.cancel()
    expect(await failure(job)).toBeInstanceOf(Error)
    await job.cleanupDone
    await recording.close()
    expect(statSync(path).size).toBeGreaterThan(0)
    expect(readFileSync(path).subarray(0, 4)).toEqual(
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    )
    expect(c.stats().leased).toBe(0)
  } finally {
    await recorder.close()
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('reentrant synchronization options cannot apply controls after a mode owns the camera', async () => {
  const c = cam()
  let switching: ReturnType<Camera['switchMode']> | undefined
  try {
    expect(() =>
      c.setSynchronization('server', {
        get frames() {
          switching = c.switchMode({ width: 20, height: 14, fifo: true })
          return 3
        },
      }),
    ).toThrow('mode jobs pending')
    await switching
    expect(c.nativeControlSnapshot().revision).toBe(0n)
  } finally {
    await c.close()
  }
})
