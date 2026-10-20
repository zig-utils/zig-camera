import assert from 'node:assert/strict'
import { Camera, CameraError } from '../../ts'
const discovered = Camera.discover()
assert.ok(Array.isArray(discovered))
assert.deepEqual(
  Camera.discover().map((c) => c.id),
  discovered.map((c) => c.id),
)
console.log(`libcamera discovery returned ${discovered.length} cameras`)
try {
  const camera = new Camera()
  assert.equal(camera.info().backend, 1, 'real backend must load')
  assert.equal(camera.properties().kind, 'properties')
  assert.equal(camera.controls().kind, 'controls')
  assert.ok(Camera.discover().some((entry) => entry.id === discovered[0]?.id))
  await camera.close()
  console.log('libcamera loaded and discovered a camera')
} catch (error) {
  if (!(error instanceof CameraError) || error.code !== -9) throw error
  console.log('libcamera loaded; no camera present on CI host (expected)')
}

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
