import { expect, test } from 'bun:test'
import {
  Camera,
  Recorder,
  CameraError,
  JobCancelledError,
  type CustomOutput,
  type OutputPacket,
} from '../../ts'
const pause = (ms = 1) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
async function until(check: () => boolean) {
  const end = performance.now() + 5000
  while (!check()) {
    if (performance.now() > end) throw Error('condition timeout')
    await pause()
  }
}
class Sink implements CustomOutput {
  packets: OutputPacket[] = []
  entered = false
  stops = 0
  gate = deferred()
  async outputframe(packet: OutputPacket) {
    this.entered = true
    await this.gate.promise
    this.packets.push(packet)
  }
  stop() {
    this.stops++
  }
}
async function setup(maxOperations = 2) {
  const camera = new Camera({
      simulate: true,
      width: 32,
      height: 24,
      fifo: true,
    }),
    sink = new Sink()
  const recorder = await Recorder.open(sink, {
    width: 32,
    height: 24,
    fps: 25,
    isolate: true,
    outputQueue: { maxBytes: 65536, maxOperations },
  })
  camera.start()
  return { camera, recorder, sink }
}
async function feed(camera: Camera, recorder: Recorder, index: number) {
  using frame = camera.acquire()
  recorder.write(frame, BigInt(index) * 40_000_000n)
  await pause()
}
async function checkJob(job: PromiseLike<unknown>, code: number) {
  await expect(Promise.resolve(job)).rejects.toMatchObject({ code })
}
test('host telemetry charges in-flight data until ack and caches final accounting after close', async () => {
  const { camera, recorder, sink } = await setup()
  try {
    await feed(camera, recorder, 0)
    await until(() => sink.entered)
    let stats = recorder.hostIOStats()
    expect(stats.generation).toBe(0n)
    expect(stats.inFlight).toBe(true)
    expect(stats.inFlightSequence).toBe(1n)
    expect(stats.inFlightBytes).toBe(stats.queuedBytes)
    expect(stats.queuedOperations).toBe(1n)
    expect(stats.completedOperations).toBe(0n)
    await feed(camera, recorder, 1)
    stats = recorder.hostIOStats()
    expect(stats.queuedOperations).toBe(2n)
    expect(stats.highOperations).toBe(2n)
    expect(stats.acceptedBytes).toBe(stats.queuedBytes)
    sink.gate.release()
    await recorder.drain()
    stats = recorder.hostIOStats()
    expect(stats.queuedBytes).toBe(0n)
    expect(stats.acceptedBytes).toBe(stats.completedBytes)
    expect(stats.completedOperations).toBe(2n)
    expect(stats.rejectedOperations).toBe(0n)
    expect(stats.inFlight).toBe(false)
    await recorder.close()
    const final = recorder.hostIOStats()
    expect(final.closed).toBe(true)
    expect(final.abandonedOperations).toBe(0n)
    expect(final.highOperations).toBe(2n)
    final.completedOperations = 100n
    expect(recorder.hostIOStats().completedOperations).toBe(2n)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('capacity waits let the event loop run and complete only after requested headroom is acknowledged', async () => {
  const { camera, recorder, sink } = await setup()
  try {
    await feed(camera, recorder, 0)
    await until(() => sink.entered)
    const job = recorder.waitForOutput(0, {
      minBytes: 65536,
      minOperations: 2,
      timeoutMs: 1000,
    })
    await pause(10)
    expect(job.done).toBe(false)
    expect(recorder.hostIOStats().pendingWaits).toBe(1n)
    sink.gate.release()
    const stats = await job
    expect(stats.queuedBytes).toBe(0n)
    expect(stats.satisfiedWaits).toBe(1n)
    expect(stats.pendingWaits).toBe(0n)
    expect(stats.totalWaitNs).toBeGreaterThan(0n)
    // Completion is an observation, not a reservation for either caller.
    await recorder.waitForOutput(0, { minOperations: 2, timeoutMs: 0 })
    await recorder.waitForOutput(0, { minOperations: 2, timeoutMs: 0 })
    await feed(camera, recorder, 1)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('capacity timeout never poisons the sink or retries an already encoded frame', async () => {
  const { camera, recorder, sink } = await setup(1)
  try {
    await feed(camera, recorder, 0)
    await until(() => sink.entered)
    const job = recorder.waitForOutput(0, { minOperations: 1, timeoutMs: 10 })
    await checkJob(job, -3)
    await checkJob(recorder.waitForOutput(0, { timeoutMs: 0 }), -3)
    const stats = recorder.hostIOStats()
    expect(stats.timedOutWaits).toBe(2n)
    expect(stats.rejectedOperations).toBe(0n)
    expect(stats.errorCode).toBe(0)
    sink.gate.release()
    await recorder.waitForOutput(0, { timeoutMs: 1000 })
    await feed(camera, recorder, 1)
    await recorder.close()
    expect(sink.packets.length).toBe(2)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('wait cancellation, pre-aborted signals and admission bounds release every native ticket', async () => {
  const { camera, recorder, sink } = await setup(1)
  try {
    await feed(camera, recorder, 0)
    await until(() => sink.entered)
    for (let round = 0; round < 2; round++) {
      const jobs = Array.from({ length: 16 }, () =>
        recorder.waitForOutput(0, { timeoutMs: 1000 }),
      )
      expect(() => recorder.waitForOutput()).toThrow(CameraError)
      for (const job of jobs) {
        job.cancel()
        await expect(Promise.resolve(job)).rejects.toBeInstanceOf(
          JobCancelledError,
        )
      }
      await Promise.all(jobs.map((j) => j.operationDone))
    }
    const abort = new AbortController(),
      reason = Error('abort wait')
    abort.abort(reason)
    await expect(
      Promise.resolve(recorder.waitForOutput(0, { signal: abort.signal })),
    ).rejects.toBe(reason)
    await pause()
    expect(recorder.hostIOStats().pendingWaits).toBe(0n)
    expect(recorder.hostIOStats().cancelledWaits).toBe(33n)
    sink.gate.release()
    await recorder.waitForOutput()
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('removing an output closes its waits before hook retirement and preserves its final epoch report', async () => {
  const camera = new Camera({ simulate: true, width: 32, height: 24 }),
    sink = new Sink(),
    recorder = new Recorder(null, {
      width: 32,
      height: 24,
      outputQueue: { maxBytes: 65536, maxOperations: 1 },
    })
  try {
    camera.start()
    const id = await recorder.addOutput(sink)
    await feed(camera, recorder, 0)
    await until(() => sink.entered)
    const wait = recorder.waitForOutput(id, { timeoutMs: 1000 })
    const removed = recorder.removeOutput(id)
    await checkJob(wait, -2)
    expect(sink.stops).toBe(0)
    sink.gate.release()
    await removed
    const stats = recorder.hostIOStats(id)
    expect(stats.closedWaits).toBe(1n)
    expect(stats.closed).toBe(true)
    expect(stats.completedOperations).toBe(1n)
    expect(stats.pendingWaits).toBe(0n)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('parent close cancels queued capacity jobs and their signal callbacks may close the owner', async () => {
  const { camera, recorder, sink } = await setup()
  try {
    await feed(camera, recorder, 0)
    await until(() => sink.entered)
    const job = recorder.waitForOutput(0, {
      minOperations: 2,
      signalFunction: async () => {
        await recorder.close()
      },
    })
    const closed = recorder.close()
    await checkJob(job, -2)
    sink.gate.release()
    await closed
    await job.cleanupDone
    expect(recorder.hostIOStats().pendingWaits).toBe(0n)
    expect(recorder.hostIOStats().cancelledWaits).toBe(1n)
    expect(sink.stops).toBe(1)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('headroom validation rejects impossible requests and hooks cannot re-enter wait or telemetry', async () => {
  const { camera, recorder, sink } = await setup()
  try {
    for (const options of [
      { minBytes: -1 },
      { minBytes: 65537 },
      { minOperations: 0 },
      { minOperations: 3 },
      { timeoutMs: Infinity },
      { timeoutMs: 60001 },
    ])
      expect(() => recorder.waitForOutput(0, options)).toThrow()
    expect(recorder.hostIOStats().waitRequests).toBe(0n)
    sink.outputframe = async () => {
      expect(() => recorder.waitForOutput()).toThrow(CameraError)
      expect(() => recorder.hostIOStats()).toThrow(CameraError)
    }
    await feed(camera, recorder, 0)
    await recorder.drain()
    expect(recorder.hostIOStats().errorCode).toBe(0)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('isolated pressure failure closes pending waits and accounts for abandoned operations without harming peers', async () => {
  const { camera, recorder, sink } = await setup(1),
    healthy = new Sink()
  healthy.gate.release()
  try {
    const id = await recorder.addOutput(healthy)
    await feed(camera, recorder, 0)
    await until(() => sink.entered)
    const wait = recorder.waitForOutput(0, { timeoutMs: 1000 })
    await feed(camera, recorder, 1)
    await checkJob(wait, -6)
    for (let i = 2; i < 5; i++) await feed(camera, recorder, i)
    expect(recorder.hostIOStats().rejectedOperations).toBe(1n)
    expect(recorder.hostIOStats().closedWaits).toBe(1n)
    sink.gate.release()
    await recorder.drain(id)
    await recorder.close()
    const stats = recorder.hostIOStats()
    expect(stats.queuedOperations).toBe(0n)
    expect(stats.acceptedOperations).toBe(
      stats.completedOperations + stats.abandonedOperations,
    )
    expect(stats.acceptedBytes).toBe(
      stats.completedBytes + stats.abandonedBytes,
    )
    expect(stats.abandonedOperations).toBe(1n)
    expect(healthy.packets.length).toBe(5)
    expect(recorder.hostIOStats(id).errorCode).toBe(0)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('telemetry reports the current host epoch after an asynchronous split', async () => {
  const { camera, recorder, sink } = await setup(4),
    next = new Sink()
  sink.gate.release()
  next.gate.release()
  try {
    await feed(camera, recorder, 0)
    await recorder.waitForOutput()
    const split = recorder.split(next)
    await until(() => {
      recorder.poll()
      return split.status.staged
    })
    await feed(camera, recorder, 1)
    await split
    split.close()
    await recorder.drain()
    const stats = recorder.hostIOStats()
    expect(stats.generation).toBe(1n)
    expect(stats.waitRequests).toBe(0n)
    expect(stats.acceptedOperations).toBe(1n)
    expect(stats.completedOperations).toBe(1n)
    await recorder.waitForOutput()
    expect(recorder.hostIOStats().satisfiedWaits).toBe(1n)
  } finally {
    sink.gate.release()
    next.gate.release()
    await recorder.close()
    await camera.close()
  }
})
test('an unpublished failed replacement cannot overwrite final telemetry for the healthy epoch', async () => {
  const { camera, recorder, sink } = await setup(8)
  sink.gate.release()
  try {
    await feed(camera, recorder, 0)
    const failure = Error('header failed')
    const split = recorder.split({
      format: 'mkv',
      write() {
        throw failure
      },
    })
    let observed: unknown
    try {
      await split.wait()
    } catch (error) {
      observed = error
    }
    expect(observed).toBe(failure)
    split.close()
    await recorder.close()
    const stats = recorder.hostIOStats()
    expect(stats.generation).toBe(0n)
    expect(stats.acceptedOperations).toBe(1n)
    expect(stats.errorCode).toBe(0)
  } finally {
    sink.gate.release()
    await recorder.close()
    await camera.close()
  }
})
