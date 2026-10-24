import assert from 'node:assert/strict'
import { Camera, CameraError, getTuningState, TuningSession, IMX708 } from '../../ts'
import { native as n, ptr, storage, type Pointer } from '../../ts/ffi'

// A real manager watch must outlive failed opens and discovery leases without
// needing physical cameras. Its close must release the actual SDK signal slots.
{
  await using watch = Camera.watchCameras({ capacity: 2 })
  const generation = getTuningState().generation
  assert.equal(watch.state().backend, 'libcamera')
  assert.equal(getTuningState().managerUsers, 1)
  // A fresh failed open must return no candidate and perform no rollback open.
  const config = storage(72),
    pipeline = storage(44)
  n.zc_default_config(ptr(config))
  n.zc_default_pipeline_options(ptr(pipeline))
  const worker = new Worker(
    new URL('../../ts/mode-worker.ts', import.meta.url).href,
  )
  try {
    const result = new Promise<{
      handle: Pointer
      code: number
      restoreCode: number
    }>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data)
      worker.onerror = reject
    })
    worker.postMessage({
      fresh: true,
      targetStarted: false,
      handle: 0,
      config,
      pipeline,
      previousConfig: config,
      previousPipeline: pipeline,
      previousStarted: false,
      cameraId: new TextEncoder().encode(
        'zig-utils-absent-reconnect-smoke-test',
      ),
      controls: new Uint8Array(),
      controlCount: 0,
      controlRevision: 0n,
      cancel: new SharedArrayBuffer(8),
      deadline: Infinity,
      dropFrames: 0,
    })
    const response = await result
    if (response.handle) n.zc_close(response.handle)
    assert.deepEqual(response.handle, 0)
    assert.equal(response.code, -9)
    assert.equal(response.restoreCode, 0)
    assert.equal(getTuningState().generation, generation)
    assert.equal(getTuningState().managerUsers, 1)
    console.log('real fresh reconnection worker failed-open cleanup completed')
  } finally {
    worker.terminate()
  }
  assert.ok(Array.isArray(watch.discover()))
  assert.equal(getTuningState().generation, generation)
  assert.equal(getTuningState().managerUsers, 1)
  assert.throws(
    () => watch.simulateEvent('added', 'fake'),
    (error) => error instanceof CameraError && error.code === -8,
  )
  await assert.rejects(
    watch.next({ timeoutMs: 5 }).wait(),
    (error) => error instanceof CameraError && error.code === -3,
  )
  const pending = watch.next()
  await watch.close()
  await assert.rejects(pending.wait())
  assert.equal(getTuningState().managerUsers, 0)
  console.log('real manager hotplug watch ownership and joined close completed')
}
const discovered = Camera.discover()
assert.ok(Array.isArray(discovered))
assert.deepEqual(
  Camera.discover().map((c) => c.id),
  discovered.map((c) => c.id),
)
console.log(`libcamera discovery returned ${discovered.length} cameras`)
if (!discovered.length) assert.throws(() => new IMX708(), (error) => error instanceof CameraError && error.code === -8)
try {
  const camera = new Camera()
  assert.equal(camera.info().backend, 1, 'real backend must load')
  assert.equal(camera.properties().kind, 'properties')
  assert.equal(camera.controls().kind, 'controls')
  assert.ok(Camera.discover().some((entry) => entry.id === discovered[0]?.id))
  const id = camera.cameraId
  await camera.close()
  const exact = new Camera({ cameraId: id })
  assert.equal(exact.cameraId, id)
  await exact.switchMode({ width: 640, height: 480 })
  assert.equal(exact.cameraId, id)
  await exact.close()
  console.log('libcamera loaded and discovered a camera')
} catch (error) {
  if (!(error instanceof CameraError) || error.code !== -9) throw error
  console.log('libcamera loaded; no camera present on CI host (expected)')
}

assert.throws(
  () => new Camera({ cameraId: 'zig-utils-absent-smoke-test-camera' }),
  (error) => error instanceof CameraError && error.code === -9,
)

// Independent Bun isolates share the same driver/manager instance. Exercise
// concurrent manager leases even on CI machines with no physical camera.
const workers = Array.from(
  { length: 4 },
  () => new Worker(new URL('./discovery-worker.ts', import.meta.url).href),
)
let timeout: ReturnType<typeof setTimeout> | undefined
try {
  const work = async () => {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.onmessage = (event) => {
              assert.equal(event.data, 'ready')
              resolve()
            }
            worker.onerror = reject
          }),
      ),
    )
    const results = workers.map(
      (worker) =>
        new Promise<string[][]>((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data)
          worker.onerror = reject
        }),
    )
    for (const worker of workers) worker.postMessage('discover')
    for (const result of await Promise.all(results)) {
      assert.equal(result.length, 3)
      for (const ids of result)
        assert.ok(ids.every((id) => typeof id === 'string'))
    }
  }
  await Promise.race([
    work(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(Error('discovery worker deadline')),
        15000,
      )
    }),
  ])
  console.log('concurrent libcamera discovery isolates completed')
} finally {
  if (timeout) clearTimeout(timeout)
  for (const worker of workers) worker.terminate()
}

// Exercise the actual C++ manager policy on no-camera hosts. This verifies
// startup/failed-open cleanup, not sensor IPA parsing or optical behavior.
if (discovered.length === 0) {
  const previous = process.env.LIBCAMERA_RPI_TUNING_FILE
  const profile = '{"version":2,"algorithms":[]}'
  using tuning = TuningSession.open(profile)
  const before = tuning.state.generation
  Camera.discover()
  assert(tuning.state.generation > before)
  assert.equal(tuning.state.managerUsers, 0)
  assert.equal(tuning.state.environmentActive, false)
  {
    await using watch = Camera.watchCameras()
    const liveGeneration = tuning.state.generation
    tuning.close()
    assert.equal(getTuningState().custom, true)
    assert.equal(getTuningState().environmentActive, true)
    watch.discover()
    assert.equal(getTuningState().generation, liveGeneration)
    await watch.close()
    assert.equal(getTuningState().custom, false)
    assert.equal(process.env.LIBCAMERA_RPI_TUNING_FILE, previous)
  }
  // Recreate the explicit session for the failed-open cleanup check below.
  using failedOpenTuning = TuningSession.open(profile)
  assert.throws(
    () =>
      new Camera({ tuning: profile, cameraId: 'zig-utils-absent-tuning-test' }),
    (error) => error instanceof CameraError && error.code === -9,
  )
  assert.equal(failedOpenTuning.state.sessionUsers, 1)
  assert.equal(process.env.LIBCAMERA_RPI_TUNING_FILE, previous)
  failedOpenTuning.close()
  assert.equal(getTuningState().custom, false)
  console.log('real manager tuning discovery and failed-open cleanup completed')
}
