import { expect, test } from 'bun:test'
import {
  RtpOutput,
  CameraError,
  type RtpSocketFactory,
  type RtpSocketHandlers,
  type OutputPacket,
} from '../../ts'
import { length4, reassemble, report, fakeStreams } from './rtp-reference'
const packet = (
  data = length4([Buffer.from([0x65, 0x55, 0x80])]),
  timestampNs = 0n,
): OutputPacket => ({
  data,
  timestampNs,
  sourceTimestampNs: timestampNs,
  codec: 1,
  keyframe: true,
  audio: false,
  annexB: false,
})
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e) => e,
  )
function factory() {
  const sockets: {
    port: number
    handlers: RtpSocketHandlers
    packets: Uint8Array[]
    closed: number
    blocked: boolean
    closeFailure: boolean
  }[] = []
  const open: RtpSocketFactory = async ({ port }, handlers) => {
    const s = {
      port,
      handlers,
      packets: [] as Uint8Array[],
      closed: 0,
      blocked: false,
      closeFailure: false,
    }
    sockets.push(s)
    return {
      send(data) {
        if (s.blocked) return false
        s.packets.push(data.slice())
        return true
      },
      close() {
        if (s.closeFailure) throw Error('close failure')
        s.closed++
      },
    }
  }
  return { open, sockets }
}
const create = (f: ReturnType<typeof factory>, extra = {}) =>
  new RtpOutput({
    address: '127.0.0.1',
    port: 5004,
    ssrc: 10,
    sequence: 65535,
    timestampOrigin: 0,
    cname: 'trail',
    socketFactory: f.open,
    ...extra,
  })
async function ready(output: RtpOutput) {
  await output.start()
  output.streams(fakeStreams)
  output.commit()
}
test('RTP output joins a blocked write on normal stop and sends compound BYE after exact packet reconstruction', async () => {
  const f = factory(),
    o = create(f, { mtu: 64 })
  await ready(o)
  f.sockets[0].blocked = true
  const input = packet(
    length4([Buffer.concat([Buffer.from([0x65]), Buffer.alloc(300, 0x55)])]),
  )
  const write = o.outputframe(input),
    end = o.stop()
  await Bun.sleep(2)
  expect(o.stats().inFlight).toBe(true)
  expect(f.sockets[0].packets.length).toBe(0)
  f.sockets[0].blocked = false
  f.sockets[0].handlers.writable()
  await write
  await end
  expect(
    reassemble(f.sockets[0].packets, 'h264', 96, 10)[0].nals[0].length,
  ).toBe(301)
  const rtcp = f.sockets[1].packets.map(report)
  expect(rtcp.at(-1)?.bye).toBe(true)
  expect(rtcp.at(-1)?.packets).toBe(f.sockets[0].packets.length)
  expect(f.sockets.map((s) => s.closed)).toEqual([1, 1])
  expect(o.stats().phase).toBe('stopped')
  await o.stop()
})
test('RTP discard cancels active backpressure, joins ownership, and allows a fresh session', async () => {
  const f = factory(),
    o = create(f)
  await ready(o)
  f.sockets[0].blocked = true
  const write = failure(o.outputframe(packet()))
  await o.stop({ discard: true })
  expect(await write).toBeInstanceOf(CameraError)
  expect(f.sockets[1].packets.length).toBe(0)
  expect(f.sockets.every((s) => s.closed === 1)).toBe(true)
  await ready(o)
  await o.outputframe(packet())
  await o.stop()
  expect(o.stats().session).toBe(2n)
})
test('RTP socket timeout and error isolate the failed output and retire every cursor', async () => {
  for (const error of [false, true]) {
    const f = factory(),
      o = create(f, { sendTimeoutMs: 5 })
    await ready(o)
    f.sockets[0].blocked = true
    const write = failure(o.outputframe(packet()))
    if (error) f.sockets[0].handlers.error(Error('network down'))
    expect(await write).toBeInstanceOf(Error)
    await o.close()
    expect(f.sockets.every((s) => s.closed === 1)).toBe(true)
  }
})
test('RTP cleanup retains failed socket owners for retry and stale callbacks cannot poison restarts', async () => {
  const f = factory(),
    o = create(f)
  await ready(o)
  f.sockets[0].closeFailure = true
  await expect(o.stop()).rejects.toThrow('close failure')
  expect(o.stats().phase).toBe('stopping')
  await expect(o.start()).rejects.toBeInstanceOf(CameraError)
  f.sockets[0].closeFailure = false
  await o.close()
  const stale = f.sockets[0].handlers
  await ready(o)
  stale.error(Error('old session'))
  await o.outputframe(packet())
  await o.stop()
  expect(o.stats().error).toBeUndefined()
})
test('RTP source admission is immutable, rejects overlapping writes, and rejects PCM posing as AAC', async () => {
  const f = factory(),
    o = create(f, {
      audio: { port: 5006, ssrc: 11, sequence: 0, timestampOrigin: 0 },
    })
  await o.start()
  expect(() =>
    o.streams({ ...fakeStreams, audio: { sampleRate: 48000, channels: 2 } }),
  ).toThrow('encoded AAC')
  o.streams({
    ...fakeStreams,
    audio: { sampleRate: 48000, channels: 2, encoding: 'aac' },
  })
  o.commit()
  f.sockets[0].blocked = true
  const p = packet()
  const saved = Buffer.from(p.data)
  const first = o.outputframe(p)
  p.data.fill(0)
  await expect(o.outputframe(packet())).rejects.toBeInstanceOf(CameraError)
  f.sockets[0].blocked = false
  f.sockets[0].handlers.writable()
  await first
  expect(reassemble(f.sockets[0].packets, 'h264', 96, 10)[0].nals[0]).toEqual(
    Buffer.from(saved).subarray(4),
  )
  await expect(
    o.outputframe({ ...packet(Buffer.from([1, 2])), audio: true, codec: 4 }),
  ).rejects.toThrow('mismatch')
  await o.close()
})
test('RTP port and option validation precedes sockets and preparation failure closes earlier sockets', async () => {
  for (const source of [
    { address: 'name', port: 5004 },
    { address: '127.0.0.1', port: 65535 },
    { address: '127.0.0.1', port: 5004, rtcpPort: 5004 },
    { address: '127.0.0.1', port: 5004, mtu: 63 },
    {
      address: '127.0.0.1',
      port: 5004,
      audio: { port: 5006, payloadType: 96 },
    },
  ])
    expect(() => new RtpOutput(source)).toThrow()
  const f = factory()
  let calls = 0
  const o = new RtpOutput({
    address: '127.0.0.1',
    port: 5004,
    socketFactory: async (...args) => {
      if (++calls === 2) throw Error('open failed')
      return f.open(...args)
    },
  })
  await expect(o.start()).rejects.toThrow('open failed')
  expect(f.sockets[0].closed).toBe(1)
  await o.close()
})
for (const address of ['127.0.0.1', '::1'])
  test(`actual ${address} UDP carries video and AAC with correlated compound RTCP`, async () => {
    const received: Uint8Array[][] = [[], [], [], []]
    const receivers = [] as Bun.udp.Socket<'buffer'>[]
    try {
      for (const target of received)
        receivers.push(
          await Bun.udpSocket({
            hostname: address,
            port: 0,
            socket: {
              data: (_, bytes) => {
                target.push(bytes.slice())
              },
            },
          }),
        )
      const o = new RtpOutput({
        address,
        port: receivers[0].port,
        rtcpPort: receivers[1].port,
        audio: {
          port: receivers[2].port,
          rtcpPort: receivers[3].port,
          ssrc: 11,
          sequence: 1,
          timestampOrigin: 0,
        },
        ssrc: 10,
        sequence: 65535,
        timestampOrigin: 0,
        mtu: 64,
        cname: 'loopback',
      })
      try {
        await o.start()
        o.streams({
          ...fakeStreams,
          audio: { sampleRate: 48000, channels: 2, encoding: 'aac' },
        })
        expect(o.sdp()).toContain('MPEG4-GENERIC/48000/2')
        expect(o.sdp()).toContain('config=1190')
        o.commit()
        await o.outputframe(
          packet(
            length4([
              Buffer.concat([Buffer.from([0x65]), Buffer.alloc(500, 0x55)]),
            ]),
          ),
        )
        await o.outputframe({
          ...packet(Buffer.alloc(200, 0x55), -42_666_666n),
          codec: 5,
          audio: true,
        })
        await o.stop()
        const deadline = Date.now() + 2000
        while (received[1].length < 2 || received[3].length < 2) {
          if (Date.now() > deadline) throw Error('UDP receiver timeout')
          await Bun.sleep(1)
        }
        expect(reassemble(received[0], 'h264', 96, 10)[0].nals[0].length).toBe(
          501,
        )
        expect(reassemble(received[2], 'aac', 97, 11)[0].data.length).toBe(200)
        expect(report(received[1].at(-1)!).bye).toBe(true)
        expect(report(received[3].at(-1)!).bye).toBe(true)
        const v = report(received[1][0]),
          a = report(received[3][0])
        expect(v.cname).toBe(a.cname)
        const elapsed = Number(a.ntp - v.ntp) / 2 ** 32
        const expected = (v.timestamp / 90000 + elapsed) * 48000
        expect(Math.abs(a.timestamp - expected)).toBeLessThan(2)
      } finally {
        await o.close()
      }
    } finally {
      for (const s of receivers) s.close()
    }
  })
test('RTP close escalates a pending drain and joins cancelled write ownership', async () => {
  const f = factory(),
    o = create(f)
  await ready(o)
  f.sockets[0].blocked = true
  const write = failure(o.outputframe(packet())),
    drain = failure(o.stop())
  await o.close()
  expect(await write).toBeInstanceOf(CameraError)
  expect(await drain).toBeInstanceOf(CameraError)
  expect(o.stats().phase).toBe('stopped')
  expect(f.sockets.every((s) => s.closed === 1)).toBe(true)
})
test('RTP live session admission is bounded and released after joined retirement', async () => {
  const f = factory(),
    outputs: RtpOutput[] = []
  try {
    for (let i = 0; i < 16; i++) {
      const output = create(f)
      outputs.push(output)
      await output.start()
    }
    const rejected = create(f)
    await expect(rejected.start()).rejects.toBeInstanceOf(CameraError)
    await outputs[0].close()
    await rejected.start()
    await rejected.close()
  } finally {
    for (const output of outputs) await output.close()
  }
})
test('RTP reentrant packet getters cannot admit a write past close', async () => {
  const f = factory(),
    o = create(f)
  await ready(o)
  let closing: Promise<void> | undefined
  const source = {
    ...packet(),
    get data() {
      closing = o.close()
      return length4([Buffer.from([0x65, 0x80])])
    },
  }
  await expect(o.outputframe(source)).rejects.toBeInstanceOf(CameraError)
  await closing
  expect(f.sockets[0].packets.length).toBe(0)
  expect(o.stats().inFlight).toBe(false)
})
test('multicast SDP carries its TTL and keeps the origin a unicast identity', async () => {
  const f = factory(),
    o = new RtpOutput({
      address: '239.1.2.3',
      port: 5004,
      socketFactory: f.open,
    })
  try {
    await ready(o)
    expect(o.sdp()).toContain('c=IN IP4 239.1.2.3/1\r\n')
    expect(o.sdp()).toMatch(/o=- \d+ 1 IN IP4 127\.0\.0\.1\r\n/)
  } finally {
    await o.close()
  }
})
test('a transport error between writes remains visible at normal stop', async () => {
  const f = factory(),
    o = create(f),
    marker = Error('late transport failure')
  await ready(o)
  await o.outputframe(packet())
  f.sockets[0].handlers.error(marker)
  await expect(o.stop()).rejects.toBe(marker)
  expect(f.sockets.every((s) => s.closed === 1)).toBe(true)
  await o.close()
})
test('inconsistent codec parameter profiles reject before publishing a session', async () => {
  const f = factory(),
    o = create(f)
  try {
    await o.start()
    const headers = length4([
      Buffer.from([0x67, 0x42, 0, 31]),
      Buffer.from([0x67, 0x64, 0, 31]),
      Buffer.from([0x68, 0x80]),
    ])
    expect(() => o.streams({ ...fakeStreams, headers })).toThrow(
      'inconsistent AVC',
    )
    expect(() => o.commit()).toThrow(CameraError)
    expect(f.sockets.every((s) => s.packets.length === 0)).toBe(true)
  } finally {
    await o.close()
  }
})
