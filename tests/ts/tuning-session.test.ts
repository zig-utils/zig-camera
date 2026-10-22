import { expect, test } from 'bun:test'
import {
  Camera,
  CameraError,
  TuningDocument,
  TuningSession,
  getTuningState,
  cleanupTuning,
  Recorder,
} from '../../ts'
const profile = '{"version":2,"algorithms":[{"rpi.af":{"map":[1,2]}}]}'
const state = () => getTuningState({ simulate: true })
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('tuning job deadline')
    await Bun.sleep(1)
  }
}
function code(run: () => unknown, expected: number) {
  try {
    run()
    throw Error('missing failure')
  } catch (error) {
    expect(error).toBeInstanceOf(CameraError)
    expect((error as CameraError).code).toBe(expected)
  }
}
test('sessions own a source snapshot and pin it independently of camera handles', async () => {
  const previous = process.env.LIBCAMERA_RPI_TUNING_FILE
  using document = TuningDocument.parse(profile)
  using session = TuningSession.open(document, { simulate: true })
  document.replaceAlgorithm('rpi.af', { map: [3, 4] })
  document.close()
  expect(session.json).toBe(profile)
  expect(session.state).toMatchObject({
    backend: 'synthetic',
    custom: true,
    sessionUsers: 1,
    managerUsers: 0,
    environmentActive: false,
  })
  const camera = new Camera({ simulate: true, width: 16, height: 16 })
  try {
    expect(state().managerUsers).toBe(1)
    session.close()
    expect(state()).toMatchObject({
      custom: true,
      sessionUsers: 0,
      managerUsers: 1,
    })
    camera.start()
    using frame = camera.acquire()
    expect(frame.metadata().sequence).toBeGreaterThanOrEqual(0n)
    expect(process.env.LIBCAMERA_RPI_TUNING_FILE).toBe(previous)
  } finally {
    await camera.close()
  }
  expect(state()).toMatchObject({
    custom: false,
    sessionUsers: 0,
    managerUsers: 0,
  })
  expect(() => session.state).toThrow('closed tuning session')
})
test('equal camera profiles share a policy while conflicts fail without disturbing active cameras', async () => {
  const first = new Camera({
    simulate: true,
    width: 16,
    height: 16,
    tuning: profile,
  })
  let second: Camera | undefined
  try {
    second = new Camera({
      simulate: true,
      width: 16,
      height: 16,
      tuning: profile,
    })
    expect(state()).toMatchObject({
      custom: true,
      sessionUsers: 2,
      managerUsers: 2,
    })
    code(() => new Camera({ simulate: true, tuning: '{"other":1}' }), -4)
    expect(state()).toMatchObject({ sessionUsers: 2, managerUsers: 2 })
    first.start()
    second.start()
    using a = first.acquire(),
      b = second.acquire()
    expect(a.metadata().sequence).toBeGreaterThanOrEqual(0n)
    expect(b.metadata().sequence).toBeGreaterThanOrEqual(0n)
    code(() => cleanupTuning({ simulate: true }), -4)
  } finally {
    await second?.close()
    await first.close()
  }
  expect(state().custom).toBe(false)
})
test('a live default manager rejects a new explicit profile and accepts it after shutdown', async () => {
  const camera = new Camera({ simulate: true, width: 16, height: 16 })
  try {
    code(() => TuningSession.open(profile, { simulate: true }), -4)
    expect(state()).toMatchObject({
      custom: false,
      sessionUsers: 0,
      managerUsers: 1,
    })
  } finally {
    await camera.close()
  }
  using session = TuningSession.open(profile, { simulate: true })
  expect(session.state.custom).toBe(true)
})
test('failed construction and invalid documents do not strand policy owners', () => {
  code(
    () => new Camera({ simulate: true, tuning: profile, cameraId: 'absent' }),
    -9,
  )
  expect(state()).toMatchObject({
    custom: false,
    sessionUsers: 0,
    managerUsers: 0,
  })
  code(() => TuningSession.open('[', { simulate: true }), -1)
  expect(state().custom).toBe(false)
  expect(() =>
    TuningSession.open(undefined as any, { simulate: true }),
  ).toThrow()
  expect(() => TuningSession.open(profile, { simulate: 1 as any })).toThrow()
})
test('camera options snapshot tuning once and preserve it across modes and target rollback', async () => {
  using document = TuningDocument.parse(profile)
  let reads = 0
  const camera = new Camera({
    simulate: true,
    width: 16,
    height: 16,
    get tuning() {
      reads++
      return document
    },
  })
  document.replaceAlgorithm('rpi.af', { map: [9, 10] })
  document.close()
  try {
    expect(reads).toBe(1)
    expect(camera.options.tuning).toBe(profile)
    camera.start()
    const before = state().generation
    const rgb = await camera.switchModeAndCaptureRGB({ width: 32, height: 24 })
    expect(rgb.length).toBe(32 * 24 * 3)
    expect(camera.info().width).toBe(16)
    expect(camera.options.tuning).toBe(profile)
    expect(state().generation).toBeGreaterThan(before)
    expect(state()).toMatchObject({
      custom: true,
      sessionUsers: 1,
      managerUsers: 1,
    })
    await expect(
      Promise.resolve(
        camera.switchMode({
          width: 32,
          height: 24,
          sensor: { width: 999, height: 999, bitDepth: 12 },
        }),
      ),
    ).rejects.toBeInstanceOf(CameraError)
    expect(camera.info().width).toBe(16)
    expect(state()).toMatchObject({
      custom: true,
      sessionUsers: 1,
      managerUsers: 1,
    })
    await camera.switchMode({ width: 32, height: 24, tuning: profile })
    expect(camera.options.tuning).toBe(profile)
  } finally {
    await camera.close()
  }
  expect(state().custom).toBe(false)
})
test('different per-mode tuning rejects before job admission and preserves manager generation', async () => {
  const camera = new Camera({
    simulate: true,
    width: 16,
    height: 16,
    tuning: profile,
  })
  try {
    const before = state().generation
    expect(() =>
      camera.switchMode({ width: 32, height: 24, tuning: '{"other":1}' }),
    ).toThrow('retain manager tuning')
    expect(state().generation).toBe(before)
    expect(camera.info().width).toBe(16)
  } finally {
    await camera.close()
  }
})
test('mode callbacks and joined cancellation cannot displace the pinned profile', async () => {
  const camera = new Camera({
    simulate: true,
    width: 16,
    height: 16,
    tuning: profile,
  })
  let seen = 0
  try {
    camera.preCallback = () => {
      seen++
      code(() => TuningSession.open('{"other":1}', { simulate: true }), -4)
      expect(state().custom).toBe(true)
    }
    camera.start()
    const job = camera.switchModeAndCaptureRGB(
      { width: 32, height: 24 },
      { dropFrames: 1 },
    )
    await job
    expect(seen).toBeGreaterThan(0)
    const controller = new AbortController()
    controller.abort(Error('no capture'))
    await expect(
      Promise.resolve(
        camera.switchMode(
          { width: 32, height: 24 },
          { signal: controller.signal },
        ),
      ),
    ).rejects.toThrow('no capture')
    expect(state()).toMatchObject({
      custom: true,
      sessionUsers: 1,
      managerUsers: 1,
    })
  } finally {
    await camera.close()
  }
})
test('a leased-frame close failure keeps the tuning owner until camera close succeeds', async () => {
  const camera = new Camera({
    simulate: true,
    width: 16,
    height: 16,
    tuning: profile,
  })
  camera.start()
  const frame = camera.acquire()
  try {
    await expect(camera.close()).rejects.toBeInstanceOf(CameraError)
    expect(state()).toMatchObject({
      custom: true,
      sessionUsers: 1,
      managerUsers: 1,
    })
  } finally {
    frame.release()
    await camera.close()
  }
  expect(state()).toMatchObject({
    custom: false,
    sessionUsers: 0,
    managerUsers: 0,
  })
})
test('single and group recording mode jobs retain tuning and reject conflicting targets', async () => {
  const camera = new Camera({
    simulate: true,
    width: 16,
    height: 16,
    tuning: profile,
  })
  const first = await Recorder.open(
    { outputframe() {} },
    { width: 16, height: 16, asyncWrites: true },
  )
  const second = await Recorder.open(
    { outputframe() {} },
    { width: 32, height: 24, asyncWrites: true },
  )
  try {
    camera.startPreview({ backend: 'headless' })
    camera.startRecording(first)
    await camera.switchRecordingModeAsync(
      first,
      { width: 32, height: 24 },
      {},
      { outputframe() {} },
    )
    expect(camera.options.tuning).toBe(profile)
    camera.startRecording(second)
    expect(() =>
      camera.switchRecordingsModeAsync(
        { width: 48, height: 32, tuning: '{"different":1}' },
        camera.activeRecordings.map((recording) => ({
          recording,
          output: { outputframe() {} },
        })),
      ),
    ).toThrow('retain manager tuning')
    const recordings = await camera.switchRecordingsModeAsync(
      { width: 48, height: 32 },
      camera.activeRecordings.map((recording) => ({
        recording,
        output: { outputframe() {} },
      })),
    )
    await until(() => recordings.every((recording) => recording.frames > 0))
    expect(camera.options.tuning).toBe(profile)
    expect(state()).toMatchObject({
      custom: true,
      sessionUsers: 1,
      managerUsers: 1,
    })
  } finally {
    await camera.close()
    await first.close()
    await second.close()
  }
  expect(state().custom).toBe(false)
})
test('claimed mode cancellation and camera close join workers before releasing the profile', async () => {
  const camera = new Camera({
    simulate: true,
    width: 16,
    height: 16,
    tuning: profile,
  })
  try {
    camera.start()
    const first = camera.switchModeAndCaptureRGB(
      { width: 32, height: 24 },
      { dropFrames: 1_000_000 },
    )
    await until(() => first.state === 'running')
    first.cancel(Error('cancel tuned capture'))
    await expect(Promise.resolve(first)).rejects.toThrow('cancel tuned capture')
    expect(camera.info().width).toBe(16)
    expect(state()).toMatchObject({
      custom: true,
      sessionUsers: 1,
      managerUsers: 1,
    })
    const second = camera.switchModeAndCaptureRGB(
      { width: 32, height: 24 },
      { dropFrames: 1_000_000 },
    )
    await until(() => second.state === 'running')
    await camera.close()
    expect(second.done).toBe(true)
    expect(state()).toMatchObject({
      custom: false,
      sessionUsers: 0,
      managerUsers: 0,
    })
  } finally {
    await camera.close()
  }
})
