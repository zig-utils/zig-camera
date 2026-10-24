import { isIP } from 'node:net'
import type { CustomOutput, OutputPacket, OutputStreams } from './outputs'
import {
  RtpPacketizer,
  rtpTimestamp,
  rtpHevcProfile,
  rtcpSenderReport,
  uint,
  ns,
  type RtpCodec,
} from './rtp'
import { CameraError } from './ffi'
export interface RtpDatagramSocket {
  send(data: Uint8Array): boolean
  close(): void | Promise<void>
}
export interface RtpSocketHandlers {
  writable(): void
  error(error: unknown): void
}
export type RtpSocketFactory = (
  endpoint: Readonly<{ address: string; port: number }>,
  handlers: RtpSocketHandlers,
) => Promise<RtpDatagramSocket>
export interface RtpStreamSeed {
  payloadType?: number
  ssrc?: number
  sequence?: number
  timestampOrigin?: number
}
export interface RtpOutputOptions extends RtpStreamSeed {
  /** Numeric IPv4/IPv6 destination; supply an SDP to the receiver. */
  address: string
  port: number
  rtcpPort?: number
  audio?: RtpStreamSeed & { port: number; rtcpPort?: number }
  mtu?: number
  sendTimeoutMs?: number
  rtcpIntervalMs?: number
  cname?: string
  /** Custom transports must own their buffers on successful send, signal
   * writability after false, and close without leaving pending callbacks. */
  socketFactory?: RtpSocketFactory
}
interface Seed {
  payloadType: number
  ssrc?: number
  sequence?: number
  timestampOrigin?: number
  port: number
  rtcpPort: number
}
interface Endpoint {
  socket?: RtpDatagramSocket
  wake?: () => void
  fail?: (error: unknown) => void
  epoch: number
}
interface Track {
  seed: Seed
  codec: RtpCodec
  rate: number
  ssrc: number
  sequence: number
  origin: number
  data: Endpoint
  control: Endpoint
  packets: bigint
  octets: bigint
  accessUnits: bigint
  lastNs?: bigint
  reportedAt?: bigint
}
const socketOwners = new WeakMap<object, Endpoint>()
const activeOutputs = new Set<RtpOutput>()
const random32 = () => crypto.getRandomValues(new Uint32Array(1))[0]
const port = (value: unknown) => {
  const result = uint(value, 65535, 'RTP port')
  if (!result) throw new RangeError('invalid RTP port')
  return result
}
const now = () => process.hrtime.bigint()
const ipv4Multicast = (address: string) =>
  isIP(address) === 4 &&
  Number(address.split('.')[0]) >= 224 &&
  Number(address.split('.')[0]) <= 239
const defaultFactory: RtpSocketFactory = async (endpoint, handlers) => {
  const socket = await Bun.udpSocket({
    hostname: isIP(endpoint.address) === 6 ? '::' : '0.0.0.0',
    connect: { hostname: endpoint.address, port: endpoint.port },
    socket: {
      drain: () => handlers.writable(),
      error: (_, error) => handlers.error(error),
    },
  })
  try {
    if (ipv4Multicast(endpoint.address)) socket.setMulticastTTL(1)
  } catch (error) {
    socket.close()
    throw error
  }
  return {
    send(data) {
      if (socket.closed) throw new CameraError(-2, 'closed RTP socket')
      return socket.send(data)
    },
    close() {
      socket.close()
    },
  }
}
function seed(
  source: RtpStreamSeed & { port: number; rtcpPort?: number },
  fallback: number,
): Seed {
  const p = port(source.port),
    control = source.rtcpPort,
    payload = source.payloadType ?? fallback,
    ssrc = source.ssrc,
    sequence = source.sequence,
    origin = source.timestampOrigin
  uint(payload, 127, 'RTP payload type')
  if (payload < 96)
    throw new RangeError('RTP output requires dynamic payload types')
  if (ssrc !== undefined) uint(ssrc, 0xffffffff, 'RTP SSRC')
  if (sequence !== undefined) uint(sequence, 65535, 'RTP sequence')
  if (origin !== undefined) uint(origin, 0xffffffff, 'RTP timestamp origin')
  return {
    port: p,
    rtcpPort: port(control ?? p + 1),
    payloadType: payload,
    ssrc,
    sequence,
    timestampOrigin: origin,
  }
}
function parameters(headers: Uint8Array, codec: RtpCodec) {
  if (
    !(headers instanceof Uint8Array) ||
    !headers.length ||
    headers.length > 1024 * 1024
  )
    throw new RangeError('invalid RTP codec headers')
  const groups = new Map<number, Uint8Array[]>()
  const d = new DataView(headers.buffer, headers.byteOffset, headers.byteLength)
  for (let offset = 0; offset < headers.length;) {
    if (headers.length - offset < 4)
      throw new RangeError('truncated RTP codec headers')
    const length = d.getUint32(offset)
    offset += 4
    if (!length || length > headers.length - offset)
      throw new RangeError('invalid RTP NAL size')
    const nal = headers.subarray(offset, offset + length)
    offset += length
    if (
      nal[0] & 0x80 ||
      (codec === 'hevc' && (nal.length < 2 || !(nal[1] & 7)))
    )
      throw new RangeError('invalid RTP parameter set')
    const kind = codec === 'h264' ? nal[0] & 31 : (nal[0] >> 1) & 63
    const list = groups.get(kind) ?? []
    list.push(nal.slice())
    groups.set(kind, list)
  }
  const list = (kind: number) => {
    const values = groups.get(kind)
    if (!values?.length) throw new RangeError('missing RTP parameter set')
    return values
  }
  const base64 = (values: Uint8Array[]) =>
    values.map((x) => Buffer.from(x).toString('base64')).join(',')
  if (codec === 'h264') {
    const sps = list(7),
      pps = list(8)
    if (sps[0].length < 4) throw new RangeError('short AVC SPS')
    for (const value of sps)
      if (
        value.length < 4 ||
        !Buffer.from(value.subarray(1, 4)).equals(
          Buffer.from(sps[0].subarray(1, 4)),
        )
      )
        throw new RangeError('inconsistent AVC SDP profiles')
    return `packetization-mode=1;profile-level-id=${Buffer.from(sps[0].subarray(1, 4)).toString('hex')};sprop-parameter-sets=${base64([...sps, ...pps])}`
  }
  const profile = rtpHevcProfile(list(33)[0])
  for (const value of list(33).slice(1)) {
    const current = rtpHevcProfile(value)
    if (
      current.space !== profile.space ||
      current.id !== profile.id ||
      current.tier !== profile.tier ||
      current.level !== profile.level ||
      current.compatibility !== profile.compatibility ||
      current.constraints !== profile.constraints
    )
      throw new RangeError('inconsistent HEVC SDP profiles')
  }
  return `profile-space=${profile.space};profile-id=${profile.id};tier-flag=${profile.tier};level-id=${profile.level};profile-compatibility-indicator=${profile.compatibility.toString(16).padStart(8, '0')};interop-constraints=${profile.constraints.toString(16).padStart(12, '0')};sprop-max-don-diff=0;sprop-vps=${base64(list(32))};sprop-sps=${base64(list(33))};sprop-pps=${base64(list(34))}`
}
/** Reusable packet output. UDP send completion means accepted by the local
 * socket, never receiver acknowledgement. Host OutputBridge queues bound AUs;
 * this object retains at most one AU cursor and one reusable datagram buffer. */
export class RtpOutput implements CustomOutput, AsyncDisposable {
  readonly format = 'packets-aac' as const
  private readonly address: string
  private readonly videoSeed: Seed
  private readonly audioSeed?: Seed
  private readonly mtu: number
  private readonly burst = 32
  private readonly timeout: number
  private readonly interval: bigint
  private readonly cname: string
  private readonly factory: RtpSocketFactory
  private phase:
    'idle' | 'starting' | 'prepared' | 'active' | 'stopping' | 'stopped' =
    'idle'
  private tracks: Track[] = []
  private opening?: Promise<void>
  private flight?: Promise<void>
  private stopping?: Promise<void>
  private failure: unknown
  private failureObserved = false
  private configured = false
  private discarding = false
  private readonly sdpId = crypto.getRandomValues(new BigUint64Array(1))[0]
  private session = 0n
  private description = ''
  private epoch?: { mono: bigint; unix: bigint; pts: bigint }
  constructor(source: RtpOutputOptions) {
    if (!source || typeof source !== 'object')
      throw new TypeError('invalid RTP output options')
    const address = source.address,
      video = seed(source, 96),
      audioSource = source.audio,
      audio = audioSource === undefined ? undefined : seed(audioSource, 97),
      mtu = source.mtu ?? 1200,
      timeout = source.sendTimeoutMs ?? 2000,
      interval = source.rtcpIntervalMs ?? 1000,
      cname = source.cname ?? `${crypto.randomUUID()}@zig-camera`,
      factory = source.socketFactory ?? defaultFactory
    if (typeof address !== 'string' || !isIP(address) || address.includes('%'))
      throw new RangeError('RTP destination must be a numeric IP address')
    if (
      new Set([
        video.port,
        video.rtcpPort,
        ...(audio ? [audio.port, audio.rtcpPort] : []),
      ]).size !== (audio ? 4 : 2)
    )
      throw new RangeError('RTP/RTCP ports must be distinct')
    if (
      audio &&
      (audio.payloadType === video.payloadType ||
        (audio.ssrc !== undefined && audio.ssrc === video.ssrc))
    )
      throw new RangeError(
        'RTP tracks require distinct payload types and SSRCs',
      )
    uint(mtu, 65507, 'RTP MTU')
    if (
      mtu < 64 ||
      !Number.isFinite(timeout) ||
      timeout <= 0 ||
      timeout > 60000 ||
      !Number.isFinite(interval) ||
      interval < 100 ||
      interval > 60000
    )
      throw new RangeError('invalid RTP MTU or deadlines')
    if (
      typeof cname !== 'string' ||
      !cname.length ||
      !cname.isWellFormed() ||
      cname.includes('\0') ||
      Buffer.byteLength(cname) > 255 ||
      typeof factory !== 'function'
    )
      throw new TypeError('invalid RTP CNAME/factory')
    this.address = address
    this.videoSeed = Object.freeze(video)
    this.audioSeed = audio ? Object.freeze(audio) : undefined
    this.mtu = mtu
    this.timeout = timeout
    this.interval = BigInt(Math.ceil(interval * 1e6))
    this.cname = cname
    this.factory = factory
  }
  private make(seed: Seed, codec: RtpCodec, rate: number): Track {
    return {
      seed,
      codec,
      rate,
      ssrc: seed.ssrc ?? random32(),
      sequence: seed.sequence ?? random32() & 65535,
      origin: seed.timestampOrigin ?? random32(),
      data: { epoch: 0 },
      control: { epoch: 0 },
      packets: 0n,
      octets: 0n,
      accessUnits: 0n,
    }
  }
  private fail(error: unknown) {
    this.failure ??= error ?? new Error('RTP transport failed')
    for (const track of this.tracks)
      for (const endpoint of [track.data, track.control])
        endpoint.fail?.(this.failure)
  }
  private async open(endpoint: Endpoint, port: number) {
    const session = this.session
    const socket = await this.factory(
      Object.freeze({ address: this.address, port }),
      {
        writable: () => {
          endpoint.epoch++
          endpoint.wake?.()
        },
        error: (error) => {
          if (session === this.session) this.fail(error)
        },
      },
    )
    if (
      !socket ||
      typeof socket.send !== 'function' ||
      typeof socket.close !== 'function'
    )
      throw new TypeError('invalid RTP socket')
    if (socketOwners.has(socket))
      throw new CameraError(-4, 'RTP socket is already owned')
    socketOwners.set(socket, endpoint)
    endpoint.socket = socket
  }
  start(): Promise<void> {
    if (!['idle', 'stopped'].includes(this.phase))
      return Promise.reject(new CameraError(-4, 'RTP output already started'))
    if (activeOutputs.size === 16)
      return Promise.reject(new CameraError(-4, 'RTP output capacity'))
    activeOutputs.add(this)
    this.phase = 'starting'
    this.discarding = false
    this.failure = undefined
    this.failureObserved = false
    this.configured = false
    this.description = ''
    this.epoch = undefined
    this.stopping = undefined
    this.session++
    const video = this.make(this.videoSeed, 'h264', 90000),
      audio = this.audioSeed
        ? this.make(this.audioSeed, 'aac', 48000)
        : undefined
    if (audio && audio.ssrc === video.ssrc) {
      if (audio.seed.ssrc !== undefined) {
        if (video.seed.ssrc !== undefined)
          throw new RangeError('duplicate RTP SSRC')
        video.ssrc = (audio.ssrc + 1) >>> 0
      } else audio.ssrc = (video.ssrc + 1) >>> 0
    }
    this.tracks = [video, ...(audio ? [audio] : [])]
    this.opening = Promise.resolve().then(async () => {
      try {
        for (const track of this.tracks) {
          await this.open(track.data, track.seed.port)
          await this.open(track.control, track.seed.rtcpPort)
        }
        if (this.failure !== undefined) throw this.failure
        if (this.phase === 'starting') this.phase = 'prepared'
      } catch (error) {
        this.fail(error)
        let cleanup: unknown
        try {
          await this.retireSockets()
        } catch (e) {
          cleanup = e
        }
        if (this.phase === 'starting')
          this.phase = this.hasSockets() ? 'stopping' : 'stopped'
        if (cleanup !== undefined)
          throw new AggregateError(
            [error, cleanup],
            'RTP preparation cleanup failed',
          )
        throw error
      }
    })
    return this.opening
  }
  streams(source: OutputStreams) {
    if (this.phase !== 'prepared' || this.configured)
      throw new CameraError(-2, 'RTP streams unavailable')
    if (!source || typeof source !== 'object')
      throw new TypeError('invalid RTP streams')
    const codec = source.codec,
      headers = source.headers,
      width = source.width,
      height = source.height,
      fps = source.fps,
      audio = source.audio
    if (codec !== 1 && codec !== 2)
      throw new RangeError('RTP video requires AVC or HEVC')
    if (
      !Number.isInteger(width) ||
      width <= 0 ||
      width > 0xffffffff ||
      !Number.isInteger(height) ||
      height <= 0 ||
      height > 0xffffffff ||
      !Number.isFinite(fps) ||
      fps < 0.001 ||
      fps > 1000
    )
      throw new RangeError('invalid RTP geometry/rate')
    const video = this.tracks[0]
    video.codec = codec === 1 ? 'h264' : 'hevc'
    const fmtp = parameters(headers, video.codec)
    const ip = isIP(this.address) === 4 ? 'IP4' : 'IP6'
    const lines = [
      'v=0',
      `o=- ${this.sdpId} ${this.session} IN ${ip} ${ip === 'IP4' ? '127.0.0.1' : '::1'}`,
      's=zig-camera',
      `c=IN ${ip} ${this.address}${ipv4Multicast(this.address) ? '/1' : ''}`,
      't=0 0',
      `m=video ${video.seed.port} RTP/AVP ${video.seed.payloadType}`,
      `a=rtcp:${video.seed.rtcpPort}`,
      `a=rtpmap:${video.seed.payloadType} ${codec === 1 ? 'H264' : 'H265'}/90000`,
      `a=fmtp:${video.seed.payloadType} ${fmtp}`,
      `a=framesize:${video.seed.payloadType} ${width}-${height}`,
      `a=framerate:${fps}`,
      'a=sendonly',
    ]
    if (audio) {
      if (audio.encoding !== 'aac')
        throw new RangeError('RTP audio requires encoded AAC-LC')
      if (!this.audioSeed)
        throw new RangeError('RTP audio requires an audio destination')
      const rate = audio.sampleRate,
        channels = audio.channels,
        index = [
          96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000,
          11025, 8000, 7350,
        ].indexOf(rate)
      if (index < 0 || (channels !== 1 && channels !== 2))
        throw new RangeError('unsupported RTP AAC configuration')
      const track = this.tracks[1]
      track.rate = rate
      const config = ((2 << 11) | (index << 7) | (channels << 3))
        .toString(16)
        .padStart(4, '0')
      lines.push(
        `m=audio ${track.seed.port} RTP/AVP ${track.seed.payloadType}`,
        `a=rtcp:${track.seed.rtcpPort}`,
        `a=rtpmap:${track.seed.payloadType} MPEG4-GENERIC/${rate}/${channels}`,
        `a=fmtp:${track.seed.payloadType} streamtype=5;profile-level-id=${rate <= 48000 ? 41 : 43};mode=AAC-hbr;config=${config};sizelength=13;indexlength=3;indexdeltalength=3;constantduration=1024`,
        'a=sendonly',
      )
    } else if (this.audioSeed)
      throw new RangeError('RTP audio destination requires an AAC stream')
    if (this.phase !== 'prepared')
      throw new CameraError(-2, 'RTP stream admission interrupted')
    this.description = lines.join('\r\n') + '\r\n'
    this.configured = true
  }
  sdp() {
    if (!this.configured) throw new CameraError(-2, 'RTP SDP unavailable')
    return this.description
  }
  commit() {
    if (
      this.phase !== 'prepared' ||
      !this.configured ||
      this.failure !== undefined
    )
      throw this.failure ?? new CameraError(-2, 'RTP output not prepared')
    this.phase = 'active'
  }
  private async send(endpoint: Endpoint, bytes: Uint8Array, closing = false) {
    const deadline = performance.now() + this.timeout
    for (;;) {
      if (this.failure !== undefined) throw this.failure
      if (
        !closing &&
        this.phase !== 'active' &&
        !(this.phase === 'stopping' && !this.discarding)
      )
        throw new CameraError(-2, 'RTP output closing')
      const epoch = endpoint.epoch
      if (endpoint.socket!.send(bytes)) return
      const remaining = deadline - performance.now()
      if (remaining <= 0)
        throw new CameraError(-3, 'RTP socket backpressure timeout')
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>
        let settled = false
        const finish = (error?: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          endpoint.wake = undefined
          endpoint.fail = undefined
          error === undefined ? resolve() : reject(error)
        }
        endpoint.wake = () => finish()
        endpoint.fail = (error) => finish(error)
        timer = setTimeout(
          () => finish(new CameraError(-3, 'RTP socket backpressure timeout')),
          remaining,
        )
        if (endpoint.epoch !== epoch) finish()
        else if (this.failure !== undefined) finish(this.failure)
      })
    }
  }
  private correlation() {
    const epoch = this.epoch!
    const elapsed = now() - epoch.mono
    return {
      unix: epoch.unix + elapsed,
      pts: epoch.pts + elapsed,
      mono: epoch.mono + elapsed,
    }
  }
  private async report(track: Track, bye = false, closing = false) {
    const sample = this.correlation()
    const bytes = rtcpSenderReport({
      ssrc: track.ssrc,
      unixNs: sample.unix,
      rtpTimestamp: rtpTimestamp(sample.pts, track.rate, track.origin),
      packets: Number(track.packets & 0xffffffffn),
      octets: Number(track.octets & 0xffffffffn),
      cname: this.cname,
      bye,
    })
    await this.send(track.control, bytes, closing)
    track.reportedAt = sample.mono
  }
  outputframe(source: OutputPacket): Promise<void> {
    if (this.phase !== 'active' || this.failure !== undefined) {
      if (this.failure !== undefined) this.failureObserved = true
      return Promise.reject(
        this.failure ?? new CameraError(-2, 'RTP output inactive'),
      )
    }
    if (this.flight)
      return Promise.reject(new CameraError(-4, 'RTP write already active'))
    const audio = source.audio,
      data = source.data,
      timestamp = source.timestampNs,
      codec = source.codec,
      annex = source.annexB
    if (typeof audio !== 'boolean' || typeof annex !== 'boolean')
      return Promise.reject(new TypeError('invalid RTP packet flags'))
    if (this.phase !== 'active' || this.failure !== undefined || this.flight)
      return Promise.reject(
        this.failure ?? new CameraError(-4, 'RTP packet admission interrupted'),
      )
    const track = this.tracks[audio ? 1 : 0]
    if (
      !track ||
      (audio ? codec !== 5 : codec !== (track.codec === 'h264' ? 1 : 2))
    )
      return Promise.reject(new RangeError('RTP packet stream mismatch'))
    try {
      if (audio) {
        if (
          typeof timestamp !== 'bigint' ||
          timestamp < -0x8000000000000000n ||
          timestamp > 0x7fffffffffffffffn
        )
          throw new RangeError('invalid AAC time')
      } else ns(timestamp, 'RTP packet time')
      if (track.lastNs !== undefined && timestamp < track.lastNs)
        throw new RangeError('RTP packet time moved backwards')
    } catch (error) {
      return Promise.reject(error)
    }
    let cursor: RtpPacketizer
    try {
      cursor = new RtpPacketizer(data, {
        codec: track.codec,
        format: audio ? 'raw' : annex ? 'annex-b' : 'length4',
        mtu: this.mtu,
        payloadType: track.seed.payloadType,
        sequence: track.sequence,
        timestamp: rtpTimestamp(timestamp, track.rate, track.origin),
        ssrc: track.ssrc,
      })
    } catch (error) {
      return Promise.reject(error)
    }
    if (this.phase !== 'active' || this.failure !== undefined || this.flight) {
      cursor.close()
      return Promise.reject(
        this.failure ?? new CameraError(-4, 'RTP cursor admission interrupted'),
      )
    }
    if (!this.epoch)
      this.epoch = {
        mono: now(),
        unix: BigInt(Date.now()) * 1_000_000n,
        pts: timestamp,
      }
    const buffer = new Uint8Array(this.mtu)
    this.flight = Promise.resolve()
      .then(async () => {
        try {
          for (;;) {
            const count = cursor.nextInto(buffer)
            if (!count) break
            await this.send(track.data, buffer.subarray(0, count))
            track.packets++
            track.octets += BigInt(count - 12)
            track.sequence = (track.sequence + 1) & 65535
            if (track.packets % BigInt(this.burst) === 0n) await Bun.sleep(0)
          }
          track.lastNs = timestamp
          track.accessUnits++
          if (
            track.reportedAt === undefined ||
            now() - track.reportedAt >= this.interval
          )
            await this.report(track)
        } catch (error) {
          this.fail(error)
          this.failureObserved = true
          throw error
        } finally {
          cursor.close()
        }
      })
      .finally(() => {
        this.flight = undefined
      })
    return this.flight
  }
  private hasSockets() {
    return this.tracks.some(
      (track) => !!track.data.socket || !!track.control.socket,
    )
  }
  private async retireSockets() {
    let failure: unknown
    for (const track of this.tracks)
      for (const endpoint of [track.data, track.control]) {
        endpoint.fail?.(new CameraError(-2, 'RTP socket closed'))
        if (endpoint.socket)
          try {
            await endpoint.socket.close()
            socketOwners.delete(endpoint.socket)
            endpoint.socket = undefined
          } catch (error) {
            failure ??= error
          }
      }
    if (!this.hasSockets()) activeOutputs.delete(this)
    if (failure !== undefined) throw failure
  }
  stop(reason?: { discard: boolean }): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'stopped')
      return Promise.resolve()
    if (this.stopping) {
      if (reason?.discard) {
        this.discarding = true
        this.fail(new CameraError(-2, 'RTP drain discarded'))
      }
      return this.stopping
    }
    const discard = reason?.discard ?? false
    if (typeof discard !== 'boolean')
      return Promise.reject(new TypeError('invalid RTP discard flag'))
    this.phase = 'stopping'
    this.discarding = discard
    if (discard) this.fail(new CameraError(-2, 'RTP output discarded'))
    const opening = this.opening,
      flight = this.flight
    this.stopping = Promise.resolve()
      .then(async () => {
        let failure: unknown
        try {
          await opening
          await flight
          if (!discard && this.epoch && this.failure === undefined)
            for (const track of this.tracks)
              if (track.packets) await this.report(track, true, true)
        } catch (error) {
          if (!discard) failure = error
        } finally {
          try {
            await this.retireSockets()
          } catch (error) {
            failure ??= error
          }
          this.phase = this.hasSockets() ? 'stopping' : 'stopped'
        }
        if (!discard && !this.failureObserved) failure ??= this.failure
        if (failure !== undefined) {
          this.failureObserved = true
          throw failure
        }
      })
      .finally(() => {
        this.stopping = undefined
      })
    return this.stopping
  }
  stats() {
    return Object.freeze({
      session: this.session,
      phase: this.phase,
      inFlight: !!this.flight,
      configured: this.configured,
      error: this.failure,
      tracks: Object.freeze(
        this.tracks.map((track) =>
          Object.freeze({
            codec: this.configured ? track.codec : undefined,
            ssrc: track.ssrc,
            nextSequence: track.sequence,
            timestampOrigin: track.origin,
            clockRate: this.configured ? track.rate : undefined,
            packets: track.packets,
            octets: track.octets,
            accessUnits: track.accessUnits,
            lastTimestampNs: track.lastNs,
          }),
        ),
      ),
    })
  }
  async close() {
    try {
      await this.stop({ discard: true })
    } catch (error) {
      if (!(
        error instanceof CameraError &&
        error.code === -2 &&
        !this.hasSockets()
      ))
        throw error
    }
  }
  async [Symbol.asyncDispose]() {
    await this.close()
  }
}
