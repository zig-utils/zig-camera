import { expect, test } from 'bun:test'
import { Camera, RequestCallbackError } from '../../ts'
import { native } from '../../ts/ffi'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const cam = () =>
  new Camera({
    simulate: true,
    fifo: true,
    raw: true,
    width: 18,
    height: 10,
  })
const fail = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
for (const format of ['jpeg', 'png', 'bmp', 'tiff', 'ppm', 'dng'] as const)
  test(`ordinary ${format} callbacks complete before publication and source owners retire before completion`, async () => {
    const c = cam(),
      dir = mkdtempSync(join(tmpdir(), 'zc-ordinary-stage-')),
      path = join(dir, `image.${format}`),
      marker = Error('post callback')
    try {
      writeFileSync(path, 'original')
      c.postCallback = () => {
        expect(readFileSync(path, 'utf8')).toBe('original')
        expect(readdirSync(dir).length).toBe(2)
        throw marker
      }
      const error = await fail(c.captureFileAsync(path))
      expect(error).toBeInstanceOf(RequestCallbackError)
      expect(error.cause).toBe(marker)
      expect(readFileSync(path, 'utf8')).toBe('original')
      expect(readdirSync(dir)).toEqual([`image.${format}`])
      expect(c.stats().leased).toBe(0)
      c.setRequestCallbacks({})
      let called = 0
      const job = c.captureFileAsync(path, {
        signalFunction: (completed) => {
          called++
          expect(completed.error).toBeUndefined()
          expect(c.stats().leased).toBe(0)
          expect(readFileSync(path).length).toBeGreaterThan(20)
        },
      })
      await job
      await job.cleanupDone
      expect(called).toBe(1)
      expect(readdirSync(dir)).toEqual([`image.${format}`])
    } finally {
      c.setRequestCallbacks({})
      await c.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
test('ordinary file cancellation after staging discards before rejection and camera reuse', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-ordinary-cancel-')),
    path = join(dir, 'image.png'),
    marker = Error('cancel')
  let job: ReturnType<Camera['captureFileAsync']>
  try {
    writeFileSync(path, 'original')
    c.postCallback = () => {
      expect(job.cancel(marker)).toBe(true)
    }
    job = c.captureFileAsync(path)
    expect(await fail(job)).toBe(marker)
    expect(readFileSync(path, 'utf8')).toBe('original')
    expect(readdirSync(dir)).toEqual(['image.png'])
    expect(c.stats().leased).toBe(0)
    c.setRequestCallbacks({})
    await c.captureFile(path)
    expect(readFileSync(path).length).toBeGreaterThan(20)
  } finally {
    c.setRequestCallbacks({})
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('ordinary file deadlines are rechecked after synchronous post callbacks', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-ordinary-deadline-')),
    path = join(dir, 'image.png')
  try {
    writeFileSync(path, 'original')
    c.postCallback = () => {
      const until = performance.now() + 1050
      while (performance.now() < until) {}
    }
    const error = await fail(c.captureFileAsync(path, { timeoutMs: 1000 }))
    expect(error).toMatchObject({ code: -3 })
    expect(readFileSync(path, 'utf8')).toBe('original')
    expect(readdirSync(dir)).toEqual(['image.png'])
    expect(c.stats().leased).toBe(0)
  } finally {
    c.setRequestCallbacks({})
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('ordinary native publication rejects late cancellation while camera close joins its result', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-ordinary-claim-')),
    path = join(dir, 'image.png'),
    finish = native.zc_image_file_finish
  let job: ReturnType<Camera['captureFileAsync']>,
    closed: Promise<void> | undefined,
    observed = false
  try {
    Object.assign(native, {
      zc_image_file_finish: (...args: Parameters<typeof finish>) => {
        const result = finish(...args)
        if (args[1] === 1 && result === 0) {
          observed = true
          expect(job.cancel(Error('late'))).toBe(false)
          closed = c.close()
        }
        return result
      },
    })
    job = c.captureFileAsync(path)
    expect((await job).sequence).toBeGreaterThanOrEqual(0n)
    expect(observed).toBe(true)
    await closed
    expect(readFileSync(path).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    expect(readdirSync(dir)).toEqual(['image.png'])
  } finally {
    Object.assign(native, { zc_image_file_finish: finish })
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('ordinary file capture snapshots scheduling fields once and preserves frame selection', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-ordinary-admit-')),
    path = join(dir, 'image.png')
  let reads = 0
  try {
    const job = c.captureFileAsync(path, {
      get dropFrames() {
        reads++
        return 2
      },
      flush: true,
    })
    const metadata = await job
    expect(reads).toBe(1)
    expect(metadata.sequence).toBeGreaterThanOrEqual(3n)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('focus-locked file capture discards its staged output when CAF restoration fails', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-focus-stage-')),
    path = join(dir, 'image.png'),
    restore = native.zc_autofocus_pause_restore
  try {
    writeFileSync(path, 'original')
    c.startContinuousAutofocus()
    Object.assign(native, {
      zc_autofocus_pause_restore: () => {
        expect(readFileSync(path, 'utf8')).toBe('original')
        expect(c.stats().leased).toBe(0)
        return -6
      },
    })
    expect(await fail(c.captureFocusLockedFile(path))).toMatchObject({
      code: -6,
    })
    expect(readFileSync(path, 'utf8')).toBe('original')
    expect(readdirSync(dir)).toEqual(['image.png'])
    Object.assign(native, { zc_autofocus_pause_restore: restore })
    await c.autofocusResumeAsync()
    await c.captureFocusLockedFile(path)
    expect(readFileSync(path).length).toBeGreaterThan(20)
  } finally {
    Object.assign(native, { zc_autofocus_pause_restore: restore })
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('focus-locked file cancellation joins CAF restoration before discarding output', async () => {
  const c = cam(),
    dir = mkdtempSync(join(tmpdir(), 'zc-focus-cancel-stage-')),
    path = join(dir, 'image.png'),
    restore = native.zc_autofocus_pause_restore,
    marker = Error('cancel during restoration')
  let job: ReturnType<Camera['captureFocusLockedFile']>,
    observed = false
  try {
    writeFileSync(path, 'original')
    c.startContinuousAutofocus()
    Object.assign(native, {
      zc_autofocus_pause_restore: (...args: Parameters<typeof restore>) => {
        const result = restore(...args)
        observed = true
        expect(readFileSync(path, 'utf8')).toBe('original')
        expect(job.cancel(marker)).toBe(true)
        return result
      },
    })
    job = c.captureFocusLockedFile(path)
    expect(await fail(job)).toBe(marker)
    expect(observed).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('original')
    expect(readdirSync(dir)).toEqual(['image.png'])
    expect(c.stats().leased).toBe(0)
  } finally {
    Object.assign(native, { zc_autofocus_pause_restore: restore })
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
