import { expect, test } from 'bun:test'
import { Camera, Recorder, Control, JobCancelledError } from '../../ts'
const cam = () =>
  new Camera({ simulate: true, width: 64, height: 48, fifo: true })
const failure = (job: PromiseLike<unknown>) =>
  Promise.resolve(job).then(
    () => undefined,
    (error) => error,
  )
const pause = () => new Promise<void>((r) => setTimeout(r, 1))
async function until(fn: () => boolean) {
  const end = performance.now() + 5000
  while (!fn()) {
    if (performance.now() > end) throw Error('timeout')
    await pause()
  }
}
test('default mode policy cancels and joins the old AF owner before reopening; fresh AF works', async () => {
  const c = cam()
  try {
    const focus = c.autofocusAsync(),
      result = failure(focus)
    await c.switchMode({ width: 128, height: 96 }, { autofocus: true })
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(focus.done).toBe(true)
    expect(c.info().width).toBe(128)
    expect(await c.autofocus()).toBe(3)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
test('wait policy drives AF to completion before mode handoff and preserves logical revisions', async () => {
  const c = cam()
  try {
    const focus = c.autofocusAsync()
    const revision = c.controlSnapshot().revision
    await c.switchMode({ width: 128, height: 96 }, { autofocusPolicy: 'wait' })
    expect(await focus).toBe(3)
    expect(c.controlSnapshot().revision).toBeGreaterThan(revision)
    expect(await c.autofocus()).toBe(3)
  } finally {
    await c.close()
  }
})
test('reject and invalid policies leave the old autofocus job and camera intact', async () => {
  const c = cam()
  try {
    const focus = c.autofocusAsync(),
      owned = c.handle
    expect(() =>
      c.switchMode({ width: 128, height: 96 }, { autofocusPolicy: 'reject' }),
    ).toThrow('autofocus active')
    // @ts-expect-error Runtime validation is required for JavaScript callers.
    expect(() => c.switchMode({}, { autofocusPolicy: 'resume' })).toThrow(
      RangeError,
    )
    // @ts-expect-error Runtime validation is required for JavaScript callers.
    expect(() => c.switchMode({}, { autofocus: 'yes' })).toThrow(RangeError)
    expect(c.handle).toBe(owned)
    expect(await focus).toBe(3)
  } finally {
    await c.close()
  }
})
test('pre-cancelled focus jobs and invalid deadlines never trigger a native scan', async () => {
  const c = cam(),
    controller = new AbortController()
  try {
    const original = c.controlSnapshot().revision,
      reason = Error('already aborted')
    controller.abort(reason)
    expect(await failure(c.autofocusAsync({ signal: controller.signal }))).toBe(
      reason,
    )
    expect(await failure(c.autofocusAsync({ timeoutMs: 0 }))).toMatchObject({
      code: -3,
    })
    expect(() => c.autofocusAsync({ timeoutMs: NaN })).toThrow(RangeError)
    expect(c.controlSnapshot().revision).toBe(original)
    expect(await c.autofocus()).toBe(3)
  } finally {
    await c.close()
  }
})
test('target AF precedes temporary metadata, RGB, lores and file capture, then restores stopped state', async () => {
  const c = cam()
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'zc-af-'))
  try {
    const target = { width: 128, height: 96, fifo: true }
    const meta = await c.switchModeAndCaptureMetadata(target, {
      autofocus: true,
    })
    expect(meta.afState).toBe(2)
    expect(meta.controlRevision).toBeGreaterThan(0n)
    expect(c.info().width).toBe(64)
    expect(() => c.acquire()).toThrow()
    expect(c.controlSnapshot().revision).toBeGreaterThanOrEqual(
      meta.controlRevision,
    )
    // The explicit target trigger is never replayed into the restored mode.
    expect(
      c.controlSnapshot().controls.some((x) => x.id === Control.afTrigger),
    ).toBe(false)
    expect(
      (await c.switchModeAndCaptureRGB(target, { autofocus: true })).length,
    ).toBe(128 * 96 * 3)
    expect(
      (
        await c.switchModeAndCaptureBuffer(
          { ...target, lores: { width: 16, height: 8 } },
          'lores',
          { autofocus: true },
        )
      ).data.length,
    ).toBe(192)
    for (const ext of ['jpg', 'dng']) {
      expect(
        (
          await c.switchModeAndCaptureFile(
            target,
            join(dir, `focused.${ext}`),
            { autofocus: true },
          )
        ).afState,
      ).toBe(2)
    }
    c.start()
    using frame = c.acquire()
    expect(frame.metadata().afState).toBe(0)
  } finally {
    await c.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('FIFO focus-mode requests each trigger a fresh revision-safe scan', async () => {
  const c = cam()
  try {
    const a = c.switchModeAndCaptureMetadata(
      { width: 128, height: 96 },
      { autofocus: true },
    )
    const b = c.switchModeAndCaptureMetadata(
      { width: 96, height: 64 },
      { autofocus: true },
    )
    expect(() => c.autofocusAsync()).toThrow('camera jobs active')
    const first = await a,
      next = await b
    expect(first.afState).toBe(2)
    expect(next.afState).toBe(2)
    expect(next.controlRevision).toBeGreaterThan(first.controlRevision)
    expect(c.stats().leased).toBe(0)
  } finally {
    await c.close()
  }
})
for (const policy of ['cancel', 'wait'] as const) {
  test(`coordinated recording ${policy} AF policy progresses while camera is reserved and focuses before output commit`, async () => {
    const c = cam(),
      r = new Recorder(null, { width: 64, height: 48 })
    try {
      const recording = c.startRecording(r),
        focus = c.autofocusAsync(),
        focused = failure(focus)
      let commits = 0
      const next = await recording.switchModeAsync(
        { width: 128, height: 96, fifo: true },
        {},
        {
          commit() {
            commits++
            expect(focus.done).toBe(true)
          },
          outputframe() {},
        },
        { autofocusPolicy: policy, autofocus: true },
      )
      expect(commits).toBe(1)
      if (policy === 'cancel')
        expect(await focused).toBeInstanceOf(JobCancelledError)
      else {
        expect(await focused).toBeUndefined()
        expect(await focus).toBe(3)
      }
      expect((await c.captureMetadata()).afState).toBe(2)
      await next.flushAsync()
      expect(c.info().width).toBe(128)
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
      await r.close()
    }
  })
}
test('failed target negotiation after AF cancellation restores usable camera and AF', async () => {
  const c = cam()
  try {
    const focus = c.autofocusAsync(),
      result = failure(focus)
    const failed = await failure(
      c.switchMode(
        {
          width: 128,
          height: 96,
          sensor: { width: 1, height: 1, bitDepth: 1 },
        },
        { autofocus: true },
      ),
    )
    expect(failed).toBeDefined()
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(c.info().width).toBe(64)
    expect(await c.autofocus()).toBe(3)
  } finally {
    await c.close()
  }
})
test('prepared recording output failure rolls back after target autofocus and permits a fresh scan and retry', async () => {
  const c = cam(),
    r = new Recorder(null, { width: 64, height: 48 })
  try {
    c.startRecording(r)
    const error = await failure(
      c.switchRecordingModeAsync(
        r,
        { width: 128, height: 96 },
        {},
        {
          commit() {
            throw Error('reject focused candidate')
          },
          outputframe() {},
        },
        { autofocus: true },
      ),
    )
    expect(error).toMatchObject({ message: 'reject focused candidate' })
    expect(c.info().width).toBe(64)
    const revision = c.controlSnapshot().revision
    expect(revision).toBeGreaterThanOrEqual(1n)
    expect(await c.autofocus()).toBe(3)
    const next = await c.switchRecordingModeAsync(
      r,
      { width: 128, height: 96 },
      {},
      null,
      { autofocus: true },
    )
    expect(c.controlSnapshot().revision).toBeGreaterThan(revision)
    await next.flushAsync()
  } finally {
    await c.close()
    await r.close()
  }
})
test('stop and close join active focus owners before handle reuse or release', async () => {
  for (const close of [false, true]) {
    const c = cam(),
      focus = c.autofocusAsync(),
      result = failure(focus)
    try {
      if (close) await c.close()
      else await c.stop()
      expect(focus.done).toBe(true)
      expect(await result).toMatchObject({ code: -2 })
      if (!close) expect(await c.autofocus()).toBe(3)
    } finally {
      await c.close()
    }
  }
})
test('active target AF cancellation restores a usable mode without leaking frames', async () => {
  const c = cam()
  try {
    c.start()
    const job = c.switchMode(
      { width: 128, height: 96 },
      { autofocus: true, dropFrames: 1_000_000 },
    )
    const result = failure(job)
    await until(() => job.progress >= 3)
    expect(job.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(c.info().width).toBe(64)
    expect(c.stats().leased).toBe(0)
    expect(await c.autofocus()).toBe(3)
  } finally {
    await c.close()
  }
})

test('cancelling a waiting mode preserves the old AF job and handle', async () => {
  const c = cam()
  try {
    const focus = c.autofocusAsync(),
      owned = c.handle
    const mode = c.switchMode(
      { width: 128, height: 96 },
      { autofocusPolicy: 'wait' },
    )
    const result = failure(mode)
    await until(() => mode.state === 'running')
    expect(mode.cancel()).toBe(true)
    expect(await result).toBeInstanceOf(JobCancelledError)
    expect(c.handle).toBe(owned)
    expect(await focus).toBe(3)
    expect(c.info().width).toBe(64)
  } finally {
    await c.close()
  }
})
test('aborting AF while a recording mode waits fails before flush and releases both reservations', async () => {
  const c = cam(),
    r = new Recorder(null, { width: 64, height: 48 })
  try {
    const focus = c.autofocusAsync(),
      focused = failure(focus),
      owned = c.handle
    const mode = c.switchRecordingModeAsync(
      r,
      { width: 128, height: 96 },
      {},
      null,
      { autofocusPolicy: 'wait' },
    )
    const result = failure(mode),
      reason = Error('scan aborted')
    expect(focus.cancel(reason)).toBe(true)
    expect(await focused).toBe(reason)
    expect(await result).toBe(reason)
    expect(c.handle).toBe(owned)
    expect(r.sessionState().phase).toBe('open')
    expect(await c.autofocus()).toBe(3)
  } finally {
    await c.close()
    await r.close()
  }
})
test('lease conflicts fail before cancelling live AF', async () => {
  const c = cam()
  try {
    c.start()
    using frame = c.acquire()
    const focus = c.autofocusAsync()
    expect(
      await failure(c.switchMode({ width: 128, height: 96 })),
    ).toMatchObject({ code: -4 })
    expect(focus.cancelRequested).toBe(false)
    frame.release()
    expect(await focus).toBe(3)
  } finally {
    await c.close()
  }
})
test('fresh AF reserves trigger/cancel revision headroom even for an empty persistent snapshot', async () => {
  const c = cam(),
    r = new Recorder(null, { width: 64, height: 48 }),
    owned = c.handle
  try {
    const { native, ptr } = await import('../../ts/ffi'),
      revision = new BigUint64Array(1)
    expect(
      native.zc_restore_controls(
        c.handle,
        null,
        0,
        0xfffffffffffffffan,
        ptr(revision),
      ),
    ).toBe(0)
    expect(
      await failure(
        c.switchMode({ width: 128, height: 96 }, { autofocus: true }),
      ),
    ).toMatchObject({ code: -2 })
    expect(
      await failure(
        c.switchRecordingModeAsync(r, { width: 128, height: 96 }, {}, null, {
          autofocus: true,
        }),
      ),
    ).toMatchObject({ code: -2 })
    expect(c.handle).toBe(owned)
    expect(r.sessionState().phase).toBe('open')
  } finally {
    await c.close()
    await r.close()
  }
})
test('fresh target AF options are copied at admission', async () => {
  const c = cam()
  try {
    const options = { autofocus: true }
    const job = c.switchModeAndCaptureMetadata(
      { width: 128, height: 96 },
      options,
    )
    options.autofocus = false
    expect((await job).afState).toBe(2)
  } finally {
    await c.close()
  }
})
const preview = process.env.ZC_TEST_PREVIEW === '1' ? test : test.skip
preview(
  'preview is recreated only after target autofocus succeeds',
  async () => {
    const c = cam()
    try {
      c.startPreview('AF modes')
      const focus = c.autofocusAsync()
      await c.switchMode(
        { width: 128, height: 96 },
        { autofocusPolicy: 'wait', autofocus: true },
      )
      expect(await focus).toBe(3)
      expect((await c.captureMetadata()).afState).toBe(2)
      expect(c.stats().leased).toBe(0)
    } finally {
      await c.close()
    }
  },
)

test('pre-cancelled mode jobs leave active autofocus untouched', async () => {
  const c = cam()
  try {
    const focus = c.autofocusAsync(),
      mode = c.switchMode({ width: 128, height: 96 })
    expect(mode.cancel()).toBe(true)
    expect(await failure(mode)).toBeInstanceOf(JobCancelledError)
    expect(focus.cancelRequested).toBe(false)
    expect(await focus).toBe(3)
    expect(c.info().width).toBe(64)
  } finally {
    await c.close()
  }
})
test('AF deadlines finish native cleanup before permitting another scan', async () => {
  const c = cam()
  try {
    const focus = c.autofocusAsync({ timeoutMs: 1 })
    expect(await failure(focus)).toMatchObject({ code: -3 })
    await focus.operationDone
    expect(await c.autofocus()).toBe(3)
  } finally {
    await c.close()
  }
})
for (const recording of [false, true]) {
  test(`close cancels a mode waiting for AF and joins both owners (${recording ? 'recording' : 'ordinary'})`, async () => {
    const c = cam(),
      r = new Recorder(null, { width: 64, height: 48 })
    try {
      if (recording) c.startRecording(r)
      const focus = c.autofocusAsync(),
        focused = failure(focus)
      const mode = recording
        ? c.switchRecordingModeAsync(r, { width: 128, height: 96 }, {}, null, {
            autofocusPolicy: 'wait',
          })
        : c.switchMode({ width: 128, height: 96 }, { autofocusPolicy: 'wait' })
      const result = failure(mode)
      await until(() => mode.state === 'running')
      await c.close()
      expect(await result).toMatchObject({ code: -2 })
      expect(await focused).toMatchObject({ code: -2 })
      expect(focus.done).toBe(true)
      expect(mode.done).toBe(true)
      expect(Number(c.handle)).toBe(0)
    } finally {
      await c.close()
      await r.close()
    }
  })
}
