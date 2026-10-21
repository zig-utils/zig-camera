import { expect, test } from 'bun:test'
import { BunJob, type JobOptions } from '../../ts'

test('job admission reads each option once and retains its callback and abort owner', async () => {
  const original = new AbortController(),
    replacement = new AbortController(),
    reads = { timeoutMs: 0, signal: 0, signalFunction: 0 }
  let admittedCallback = 0,
    replacementCallback = 0,
    released = 0,
    removed = 0
  const callback = () => {
      admittedCallback++
    },
    source: JobOptions<number> = {
      get timeoutMs() {
        reads.timeoutMs++
        return 1000
      },
      get signal() {
        reads.signal++
        return original.signal
      },
      get signalFunction() {
        reads.signalFunction++
        return callback
      },
    }
  const remove = original.signal.removeEventListener.bind(original.signal)
  original.signal.removeEventListener = (
    ...args: Parameters<AbortSignal['removeEventListener']>
  ) => {
    removed++
    remove(...args)
  }
  const job = new BunJob(
    async () => 42,
    () => {
      released++
    },
    source,
  )
  Object.defineProperties(source, {
    timeoutMs: { value: 0 },
    signal: { value: replacement.signal },
    signalFunction: {
      value: () => {
        replacementCallback++
      },
    },
  })
  replacement.abort(Error('unrelated'))
  await job.start()
  expect(await job).toBe(42)
  await job.cleanupDone
  expect(reads).toEqual({ timeoutMs: 1, signal: 1, signalFunction: 1 })
  expect(admittedCallback).toBe(1)
  expect(replacementCallback).toBe(0)
  expect(removed).toBe(1)
  expect(released).toBe(1)
})

test('replacing source.signal cannot redirect cancellation or listener cleanup', async () => {
  const original = new AbortController(),
    replacement = new AbortController(),
    options: JobOptions<number> = { signal: original.signal }
  let retire!: () => void
  const pending = new Promise<void>((resolve) => {
      retire = resolve
    }),
    job = new BunJob(
      async (current) => {
        await pending
        current.check()
        return 1
      },
      () => {},
      options,
    )
  const running = job.start(),
    reason = Error('original cancellation')
  options.signal = replacement.signal
  original.abort(reason)
  retire()
  await running
  expect(await job.wait().catch((error) => error)).toBe(reason)
  await job.cleanupDone
})

test('starting an already aborted job never enters the operation before the abort microtask', async () => {
  const controller = new AbortController(),
    reason = Error('already aborted')
  controller.abort(reason)
  let entered = false,
    released = false
  const job = new BunJob(
    async () => {
      entered = true
      return 1
    },
    () => {
      released = true
    },
    { signal: controller.signal },
  )
  await job.start()
  expect(await job.wait().catch((error) => error)).toBe(reason)
  await job.cleanupDone
  expect(entered).toBe(false)
  expect(released).toBe(true)
})
