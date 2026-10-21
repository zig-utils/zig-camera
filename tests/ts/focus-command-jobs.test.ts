import { expect, test } from 'bun:test'
import { Camera, JobCancelledError, type BunJob } from '../../ts'
import { native as ffi, ptr } from '../../ts/ffi'

const native: {
  zc_autofocus_wait: (
    ...args: Parameters<typeof ffi.zc_autofocus_wait>
  ) => number
  zc_autofocus_pause_restore: (
    ...args: Parameters<typeof ffi.zc_autofocus_pause_restore>
  ) => number
  zc_autofocus_cancel: (
    ...args: Parameters<typeof ffi.zc_autofocus_cancel>
  ) => number
} = ffi
const camera = () =>
  new Camera({ simulate: true, width: 64, height: 48, fifo: true })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )

test('pause/resume Promise facades publish acknowledged commands and retire cancellation', async () => {
  const c = camera()
  try {
    c.startContinuousAutofocus()
    expect(await c.autofocusPause()).toBe(3)
    const job = c.autofocusResumeAsync()
    expect(await job).toBe(3)
    expect(job.cancel()).toBe(false)
    expect(await c.autofocusResume()).toBe(3)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})

for (const resume of [false, true]) {
  test(`cancelling ${resume ? 'resume' : 'pause'} after acknowledgement restores and acknowledges prior intent before operationDone`, async () => {
    const c = camera(),
      original = native.zc_autofocus_wait
    let job: BunJob<number> | undefined,
      cancelled = false,
      restored = false
    const target = new Uint32Array(1)
    try {
      c.startContinuousAutofocus()
      if (resume) await c.autofocusPause()
      const before = c.controlSnapshot().revision
      native.zc_autofocus_wait = (...args) => {
        const rc = original(...args)
        if (!rc && job) {
          if (!cancelled) {
            cancelled = true
            expect(job.cancel()).toBe(true)
          } else restored = true
        }
        return rc
      }
      job = resume ? c.autofocusResumeAsync() : c.autofocusPauseAsync()
      expect(await failure(job)).toBeInstanceOf(JobCancelledError)
      await job.operationDone
      expect(cancelled).toBe(true)
      expect(restored).toBe(true)
      expect(c.controlSnapshot().revision).toBe(before + 2n)
      native.zc_autofocus_wait = original
      // Restore replaces the command owner with a fresh native acknowledgement.
      expect(original(c.handle, resume ? 3n : 2n, 0, ptr(target))).toBe(0)
      expect(target[0]).toBe(3)
      for (let i = 0; i < 8; i++) {
        const m = await c.captureMetadata()
        if (
          m.controlRevision === c.controlSnapshot().revision &&
          m.afPauseState === (resume ? 2 : 0)
        ) {
          break
        }
        expect(i).toBeLessThan(7)
      }
      expect(c.stats().leased).toBe(0)
    } finally {
      native.zc_autofocus_wait = original
      await c.close()
    }
  })
}

test('pending cancellation joins a fresh acknowledgement and preserves frozen reasons on restoration failure', async () => {
  const c = camera(),
    restore = native.zc_autofocus_pause_restore
  const reason = Object.freeze(Error('cancel command'))
  try {
    c.startContinuousAutofocus()
    native.zc_autofocus_pause_restore = () => -6
    const job = c.autofocusPauseAsync()
    expect(job.cancel(reason)).toBe(true)
    const error = await failure(job)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors[0]).toBe(reason)
    expect(error.errors[1]).toMatchObject({ code: -6 })
    await job.operationDone
    native.zc_autofocus_pause_restore = restore
    expect(await c.autofocusResume()).toBe(3)
    expect((await c.captureFocusLockedMetadata()).afState).toBe(2)
  } finally {
    native.zc_autofocus_pause_restore = restore
    await c.close()
  }
})

test('restoration timeout preserves cancellation and retires the cleanup job for explicit recovery', async () => {
  const c = camera()
  try {
    c.startContinuousAutofocus()
    const job = c.autofocusPauseAsync({ restoreTimeoutMs: 0 })
    job.cancel()
    expect(await failure(job)).toMatchObject({ restorationError: { code: -3 } })
    await job.operationDone
    expect(await c.autofocusResume()).toBe(3)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})

test('restore submission and cancellation failures are both preserved without claiming successful cleanup', async () => {
  const c = camera(),
    restore = native.zc_autofocus_pause_restore,
    cancel = native.zc_autofocus_cancel
  try {
    c.startContinuousAutofocus()
    native.zc_autofocus_pause_restore = () => -6
    native.zc_autofocus_cancel = () => -9
    const job = c.autofocusPauseAsync()
    job.cancel()
    expect(await failure(job)).toMatchObject({
      restorationError: { code: -6, restorationCancellationCode: -9 },
    })
    native.zc_autofocus_pause_restore = restore
    native.zc_autofocus_cancel = cancel
    // The owner is still pending until the caller explicitly retires it.
    expect(cancel(c.handle, 1n)).toBe(0)
    expect(await c.autofocusResume()).toBe(3)
  } finally {
    native.zc_autofocus_pause_restore = restore
    native.zc_autofocus_cancel = cancel
    await c.close()
  }
})

test('invalid cleanup deadlines and exhausted revision budgets fail before submitting commands', async () => {
  const c = camera()
  try {
    c.startContinuousAutofocus()
    for (const value of [NaN, Infinity, -1]) {
      expect(() => c.autofocusPauseAsync({ restoreTimeoutMs: value })).toThrow(
        RangeError,
      )
      expect(() => c.autofocusResumeAsync({ restoreTimeoutMs: value })).toThrow(
        RangeError,
      )
    }
    const revision = c.controlSnapshot().revision
    expect(revision).toBe(1n)
    expect(await c.autofocusPause()).toBe(3)
  } finally {
    await c.close()
  }
  const fresh = camera(),
    revision = new BigUint64Array(1)
  try {
    const { Control } = await import('../../ts')
    const controls = new Uint8Array(144),
      v = new DataView(controls.buffer)
    v.setUint32(0, Control.afMode, true)
    v.setUint32(4, 2, true)
    v.setUint32(8, 1, true)
    v.setFloat64(16, 2, true)
    expect(
      ffi.zc_restore_controls(
        fresh.handle,
        ptr(controls),
        1,
        0xfffffffffffffffdn,
        ptr(revision),
      ),
    ).toBe(0)
    expect(await failure(fresh.autofocusPauseAsync())).toMatchObject({
      code: -2,
    })
    expect(fresh.controlSnapshot().revision).toBe(revision[0])
  } finally {
    await fresh.close()
  }
})

test('command options are read once and lifecycle changes during admission cannot capture a closed handle', async () => {
  const c = camera()
  let immediateReads = 0
  try {
    c.startContinuousAutofocus()
    await c.autofocusPause({
      get immediate() {
        immediateReads++
        return true
      },
    })
    expect(immediateReads).toBe(1)
    for (let i = 0; i < 8; i++) {
      if ((await c.captureMetadata()).afPauseState === 2) break
      expect(i).toBeLessThan(7)
    }
  } finally {
    await c.close()
  }
  const closing = camera()
  let teardown: Promise<void> | undefined
  try {
    expect(() =>
      closing.autofocusResumeAsync({
        get signalFunction() {
          teardown = closing.close()
          return undefined
        },
      }),
    ).toThrow()
    await teardown
  } finally {
    await closing.close()
  }
})
