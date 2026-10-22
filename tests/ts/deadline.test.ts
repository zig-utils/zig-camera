import { expect, test } from 'bun:test'
import { armDeadline } from '../../ts/deadline'
test('long deadlines use bounded timers and early wakes do not expire the job', () => {
  let now = 100,
    expired = 0,
    callback = () => {},
    scheduled = 0,
    cancelled = 0
  const host = {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      callback = fn
      scheduled = ms
      return 1
    },
    cancel: () => {
      cancelled++
    },
  }
  const cancel = armDeadline(0x80000000 + 100, () => expired++, host)
  expect(scheduled).toBe(0x7fffffff)
  now += 50
  callback()
  expect(expired).toBe(0)
  expect(scheduled).toBe(0x7fffffff)
  now = 100 + 0x7fffffff
  callback()
  expect(scheduled).toBe(101)
  now += 101
  callback()
  callback()
  expect(expired).toBe(1)
  cancel()
  expect(cancelled).toBe(0)
})
test('cancelled timer callbacks cannot expire or rearm a job', () => {
  let now = 0,
    expired = 0,
    scheduled = 0,
    cancelled = 0,
    callback = () => {}
  const cancel = armDeadline(10, () => expired++, {
    now: () => now,
    schedule: (fn) => {
      scheduled++
      callback = fn
      return 42
    },
    cancel: (handle) => {
      expect(handle).toBe(42)
      cancelled++
    },
  })
  cancel()
  cancel()
  now = 100
  callback()
  expect(expired).toBe(0)
  expect(scheduled).toBe(1)
  expect(cancelled).toBe(1)
})
test('zero and invalid durations have explicit behavior', () => {
  let expired = 0,
    callback = () => {}
  armDeadline(0, () => expired++, {
    now: () => 7,
    schedule: (fn, ms) => {
      expect(ms).toBe(0)
      callback = fn
    },
    cancel: () => {},
  })
  expect(expired).toBe(0)
  callback()
  expect(expired).toBe(1)
  for (const value of [-1, NaN, Infinity])
    expect(() => armDeadline(value, () => {})).toThrow()
})
