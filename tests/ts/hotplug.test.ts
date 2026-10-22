import { test, expect } from 'bun:test'
import {
  Camera,
  CameraWatch,
  CameraError,
  JobCancelledError,
  TuningSession,
  getTuningState,
} from '../../ts'
import { native as n } from '../../ts/ffi'

test('watch owns complete IDs, preserves ordering and reports bounded eviction', async () => {
  await using watch = Camera.watchCameras({ simulate: true, capacity: 2 })
  expect(watch.discover()[0].backend).toBe('synthetic')
  const exact = 'Cam/é/x'.repeat(512) // 4096 UTF-8 bytes, no truncation.
  expect(new TextEncoder().encode(exact).length).toBe(4096)
  watch.simulateEvent('added', exact)
  const first = await watch.next()
  expect(first.id).toBe(exact)
  expect(first.sequence).toBe(1n)
  expect(first.missed).toBe(0n)
  expect(Object.isFrozen(first)).toBe(true)
  watch.simulateEvent('removed', 'old')
  watch.simulateEvent('added', 'middle')
  watch.simulateEvent('removed', 'new')
  expect(watch.state().queued).toBe(2)
  expect(watch.state().missed).toBe(1n)
  const [middle, last] = await Promise.all([watch.next(), watch.next()])
  expect([middle.id, last.id]).toEqual(['middle', 'new'])
  expect([middle.sequence, last.sequence]).toEqual([3n, 4n])
  expect(middle.missed).toBe(1n)
  expect(first.id).toBe(exact) // Subsequent native reads cannot mutate snapshots.
})

test('watch cancellation and deadline never consume the next event', async () => {
  await using watch = new CameraWatch({ simulate: true })
  const a = watch.next(),
    b = watch.next()
  expect(a.cancel()).toBe(true)
  await expect(a.wait()).rejects.toBeInstanceOf(JobCancelledError)
  watch.simulateEvent('added', 'survives')
  expect((await b).id).toBe('survives')
  const controller = new AbortController()
  controller.abort(Error('before admission'))
  const preaborted = watch.next({ signal: controller.signal })
  await expect(preaborted.wait()).rejects.toThrow('before admission')
  await expect(watch.next({ timeoutMs: 0 }).wait()).rejects.toMatchObject({
    code: -3,
  })
  await expect(watch.next({ timeoutMs: 4 }).wait()).rejects.toMatchObject({
    code: -3,
  })
  watch.simulateEvent('removed', 'after deadline')
  const delivered = watch.next()
  expect((await delivered).id).toBe('after deadline')
  expect(delivered.cancel()).toBe(false)
})

test('bounded competing waits share one idle poll; independent watches do not consume peers', async () => {
  await using first = new CameraWatch({ simulate: true }),
    second = new CameraWatch({ simulate: true })
  const original = n.zc_camera_watch_wait
  const mutable = n as unknown as {
    zc_camera_watch_wait: (...args: Parameters<typeof original>) => number
  }
  let polls = 0
  mutable.zc_camera_watch_wait = (...args) => {
    polls++
    return original(...args)
  }
  try {
    const jobs = Array.from({ length: 32 }, () => first.next())
    expect(() => first.next()).toThrow(CameraError)
    await Bun.sleep(12)
    expect(polls).toBeGreaterThan(0)
    expect(polls).toBeLessThan(32)
    jobs[0].cancel()
    first.simulateEvent('added', 'first')
    expect((await jobs[1]).id).toBe('first')
    expect(second.state().queued).toBe(0)
    await first.close()
    await Promise.all(jobs.map((job) => job.operationDone))
    expect(jobs.every((job) => job.done)).toBe(true)
    second.simulateEvent('removed', 'second')
    expect((await second.next()).id).toBe('second')
  } finally {
    mutable.zc_camera_watch_wait = original
  }
})

test('stop/close cancels and joins jobs; abort listener close reentry shares one retirement', async () => {
  const watch = new CameraWatch({ simulate: true })
  const job = watch.next()
  let nested: Promise<void> | undefined
  job.signal.addEventListener(
    'abort',
    () => {
      nested = watch.close()
    },
    { once: true },
  )
  const closing = watch.close()
  expect(() => watch.next()).toThrow(CameraError)
  await closing
  expect(nested).toBe(closing)
  await expect(job.wait()).rejects.toBeInstanceOf(JobCancelledError)
  expect(job.done).toBe(true)
  await watch.close()
  expect(() => watch.state()).toThrow(CameraError)
  const stopped = new CameraWatch({ simulate: true })
  stopped.stop()
  stopped.stop()
  expect(stopped.state().stopped).toBe(true)
  expect(() => stopped.next()).toThrow(CameraError)
  await stopped.close()
})

test('watch pins the tuning profile through camera lifetime gaps and rejects conflicts', async () => {
  using tuning = TuningSession.open('{"version":2,"algorithms":[]}', {
    simulate: true,
  })
  await using watch = new CameraWatch({ simulate: true })
  const generation = getTuningState({ simulate: true }).generation
  const camera = new Camera({ simulate: true, width: 16, height: 16 })
  await camera.close()
  tuning.close()
  expect(getTuningState({ simulate: true }).custom).toBe(true)
  expect(getTuningState({ simulate: true }).managerUsers).toBe(1)
  expect(getTuningState({ simulate: true }).generation).toBe(generation)
  expect(() =>
    TuningSession.open('{"different":1}', { simulate: true }),
  ).toThrow(CameraError)
  expect(watch.discover()[0].id.length).toBeGreaterThan(0)
  await watch.close()
  expect(getTuningState({ simulate: true }).custom).toBe(false)
})

test('event/configuration validation and option reentry do not leak queue or manager owners', async () => {
  for (const capacity of [0, -1, 65, 1.5, NaN, Infinity])
    expect(() => new CameraWatch({ simulate: true, capacity })).toThrow(
      RangeError,
    )
  await using watch = new CameraWatch({ simulate: true })
  for (const id of ['', 'a\0b', '\ud800', 'x'.repeat(4097)])
    expect(() => watch.simulateEvent('added', id)).toThrow(RangeError)
  expect(watch.state().sequence).toBe(0n)
  expect(() =>
    watch.next({
      get timeoutMs() {
        watch.stop()
        return 1
      },
    }),
  ).toThrow(CameraError)
  await watch.close()
})

test('job callbacks can join close without retaining a native owner or consuming another event', async () => {
  const watch = new CameraWatch({ simulate: true })
  watch.simulateEvent('added', 'cam')
  let callback = false
  const job = watch.next({
    signalFunction: async () => {
      await watch.close()
      callback = true
    },
  })
  expect((await job).id).toBe('cam')
  await job.cleanupDone
  expect(callback).toBe(true)
  await watch.close()
})

test('AbortSignal registration reentry cannot admit a wait after stop or close', async () => {
  for (const action of ['stop', 'close'] as const) {
    const watch = new CameraWatch({ simulate: true })
    const controller = new AbortController(),
      signal = controller.signal
    const add = signal.addEventListener.bind(signal)
    let closing: Promise<void> | undefined
    Object.defineProperty(signal, 'addEventListener', {
      value: (...args: Parameters<typeof add>) => {
        if (action === 'close') closing = watch.close()
        else watch.stop()
        return add(...args)
      },
    })
    const job = watch.next({ signal })
    await expect(job.wait()).rejects.toMatchObject({ code: -2 })
    await job.operationDone
    expect(job.done).toBe(true)
    if (closing) await closing
    await watch.close()
  }
})

test('AbortSignal registration cannot overbook the bounded watch job queue', async () => {
  await using watch = new CameraWatch({ simulate: true })
  const controller = new AbortController(),
    signal = controller.signal
  const add = signal.addEventListener.bind(signal)
  const jobs: ReturnType<CameraWatch['next']>[] = []
  Object.defineProperty(signal, 'addEventListener', {
    value: (...args: Parameters<typeof add>) => {
      jobs.push(...Array.from({ length: 32 }, () => watch.next()))
      return add(...args)
    },
  })
  const overflow = watch.next({ signal })
  await expect(overflow.wait()).rejects.toMatchObject({ code: -4 })
  expect(jobs.length).toBe(32)
  await watch.close()
  await Promise.all(jobs.map((job) => job.operationDone))
})
