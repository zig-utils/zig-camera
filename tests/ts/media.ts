import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
export type Box = { kind: string; start: number; end: number }
export function boxes(data: Buffer, start = 0, end = data.length): Box[] {
  const result: Box[] = []
  while (start < end) {
    assert(end - start >= 8)
    const size = data.readUInt32BE(start)
    assert(size >= 8 && start + size <= end, 'invalid MP4 box')
    result.push({
      kind: data.toString('ascii', start + 4, start + 8),
      start: start + 8,
      end: start + size,
    })
    start += size
  }
  assert.equal(start, end)
  return result
}
export function child(data: Buffer, box: Box, kind: string) {
  const value = boxes(data, box.start, box.end).find((x) => x.kind === kind)
  assert(value, `missing ${kind}`)
  return value
}
export type Track = {
  id: number
  kind: string
  codec: string
  rate: number
  duration: bigint
  config: Buffer
  color?: {
    primaries: number
    transfer: number
    matrix: number
    fullRange: boolean
  }
  width?: number
  height?: number
  channels?: number
  startUs?: bigint
  presentedUs?: bigint
  delay?: number
  mediaDuration: bigint
  times: bigint[]
  durations: number[]
  keys: boolean[]
  samples: Buffer[]
}
export function mp4(path: string): Map<number, Track> {
  const data = readFileSync(path),
    top = boxes(data)
  assert.equal(top[0].kind, 'ftyp')
  assert.equal(top[1].kind, 'moov')
  const moov = top[1],
    tracks = new Map<number, Track>()
  for (const trak of boxes(data, moov.start, moov.end).filter(
    (x) => x.kind === 'trak',
  )) {
    const tk = child(data, trak, 'tkhd'),
      mdia = child(data, trak, 'mdia'),
      hd = child(data, mdia, 'hdlr'),
      mdhd = child(data, mdia, 'mdhd'),
      stbl = child(data, child(data, mdia, 'minf'), 'stbl'),
      sd = child(data, stbl, 'stsd')
    assert.equal(data.readUInt32BE(sd.start + 4), 1)
    const entry = boxes(data, sd.start + 8, sd.end)[0]
    const audio = entry.kind === 'mp4a'
    const conf = child(
      data,
      { ...entry, start: entry.start + (audio ? 28 : 78) },
      audio ? 'esds' : entry.kind === 'avc1' ? 'avcC' : 'hvcC',
    )
    const track: Track = {
      id: data.readUInt32BE(tk.start + 20),
      kind: data.toString('ascii', hd.start + 8, hd.start + 12),
      codec: entry.kind,
      rate: data.readUInt32BE(mdhd.start + 20),
      duration: data.readBigUInt64BE(tk.start + 28),
      mediaDuration: data.readBigUInt64BE(mdhd.start + 24),
      config: data.subarray(conf.start, conf.end),
      times: [],
      durations: [],
      keys: [],
      samples: [],
    }
    if (audio) {
      track.channels = data.readUInt16BE(entry.start + 16)
      assert.equal(data.readUInt16BE(entry.start + 18), 16)
      const config = data.subarray(conf.start + 4, conf.end)
      const descriptors = (bytes: Buffer) => {
        const map = new Map<number, Buffer>()
        let pos = 0
        while (pos < bytes.length) {
          const tag = bytes[pos++]
          let length = 0,
            stopped = false
          for (let i = 0; i < 4; i++) {
            const b = bytes[pos++]
            length = length * 128 + (b & 127)
            if (!(b & 128)) {
              stopped = true
              break
            }
          }
          assert(stopped && pos + length <= bytes.length)
          map.set(tag, bytes.subarray(pos, pos + length))
          pos += length
        }
        return map
      }
      const es = descriptors(config).get(3)!
      const decoder = descriptors(es.subarray(3)).get(4)!
      assert.equal(decoder[0], 0x40)
      track.config = descriptors(decoder.subarray(13)).get(5)!
      assert.equal(track.config.length, 2)
      assert.equal(track.config[0] >> 3, 2)
      const edit = child(data, child(data, trak, 'edts'), 'elst')
      assert.equal(data.readUInt32BE(edit.start), 0x1000000)
      assert.equal(data.readUInt32BE(edit.start + 4), 2)
      track.startUs = data.readBigUInt64BE(edit.start + 8)
      assert.equal(data.readBigInt64BE(edit.start + 16), -1n)
      track.presentedUs = data.readBigUInt64BE(edit.start + 28)
      track.delay = Number(data.readBigInt64BE(edit.start + 36))
      const roll = child(data, stbl, 'sgpd')
      assert.equal(
        data.toString('ascii', roll.start + 4, roll.start + 8),
        'roll',
      )
      assert.equal(data.readInt16BE(roll.start + 16), -1)
    } else {
      assert(['avc1', 'hvc1'].includes(entry.kind))
      const colr = child(data, { ...entry, start: entry.start + 78 }, 'colr')
      assert.equal(data.toString('ascii', colr.start, colr.start + 4), 'nclx')
      assert.equal(colr.end - colr.start, 11)
      assert.equal(data[colr.start + 10] & 127, 0)
      track.color = {
        primaries: data.readUInt16BE(colr.start + 4),
        transfer: data.readUInt16BE(colr.start + 6),
        matrix: data.readUInt16BE(colr.start + 8),
        fullRange: !!(data[colr.start + 10] & 128),
      }
      track.width = data.readUInt16BE(entry.start + 24)
      track.height = data.readUInt16BE(entry.start + 26)
    }
    tracks.set(track.id, track)
  }
  for (let i = 0; i < top.length; i++) {
    const box = top[i]
    if (box.kind !== 'moof') continue
    const traf = child(data, box, 'traf'),
      header = child(data, traf, 'tfhd'),
      tfdt = child(data, traf, 'tfdt'),
      run = child(data, traf, 'trun')
    assert.equal(data.readUInt32BE(header.start), 0x20000)
    assert.equal(data.readUInt32BE(tfdt.start), 0x1000000)
    assert.equal(data.readUInt32BE(run.start), 0x701)
    assert.equal(data.readUInt32BE(run.start + 4), 1)
    const track = tracks.get(data.readUInt32BE(header.start + 4))!
    assert(track)
    const mdat = top[i + 1]
    assert.equal(mdat.kind, 'mdat')
    assert.equal(data.readUInt32BE(run.start + 16), mdat.end - mdat.start)
    assert.equal(box.start - 8 + data.readUInt32BE(run.start + 8), mdat.start)
    track.times.push(data.readBigUInt64BE(tfdt.start + 4))
    track.durations.push(data.readUInt32BE(run.start + 12))
    track.keys.push(!(data.readUInt32BE(run.start + 20) & 0x10000))
    track.samples.push(data.subarray(mdat.start, mdat.end))
  }
  for (const track of tracks.values()) {
    for (let i = 1; i < track.times.length; i++)
      assert(track.times[i] > track.times[i - 1])
    assert(track.samples.length)
    assert(track.durations.every((x) => x > 0))
    if (track.kind === 'vide') {
      assert.equal(track.times[0], 0n)
      assert(track.keys[0])
    } else {
      assert(track.delay! > 0)
      assert.deepEqual(
        track.times,
        track.times.map((_, i) => BigInt(i) * 1024n),
      )
      assert(track.durations.slice(0, -1).every((x) => x === 1024))
      assert.equal(
        track.mediaDuration,
        BigInt(track.durations.reduce((a, b) => a + b, 0)),
      )
      assert.equal(track.duration, track.startUs! + track.presentedUs!)
    }
  }
  return tracks
}
export function units(path: string, video: Track) {
  const config = video.config,
    nals: Buffer[] = []
  let pos = video.codec === 'avc1' ? 6 : 23
  if (video.codec === 'avc1') {
    for (const list of [0, 1]) {
      const count = list === 0 ? config[5] & 31 : config[pos++]
      for (let i = 0; i < count; i++) {
        const size = config.readUInt16BE(pos)
        pos += 2
        nals.push(config.subarray(pos, pos + size))
        pos += size
      }
    }
  } else {
    for (let a = 0; a < config[22]; a++) {
      pos++
      const count = config.readUInt16BE(pos)
      pos += 2
      for (let i = 0; i < count; i++) {
        const size = config.readUInt16BE(pos)
        pos += 2
        nals.push(config.subarray(pos, pos + size))
        pos += size
      }
    }
  }
  const annex = (ns: Buffer[]) =>
    Buffer.concat(ns.flatMap((n) => [Buffer.from([0, 0, 0, 1]), n]))
  const aus = [annex(nals)]
  for (const sample of video.samples) {
    const ns: Buffer[] = []
    for (let p = 0; p < sample.length;) {
      const length = sample.readUInt32BE(p)
      p += 4
      assert(length > 0 && p + length <= sample.length)
      ns.push(sample.subarray(p, p + length))
      p += length
    }
    aus.push(annex(ns))
  }
  const file = `${path}.aus`
  writeFileSync(
    file,
    Buffer.concat(
      aus.flatMap((unit) => {
        const size = Buffer.alloc(4)
        size.writeUInt32BE(unit.length)
        return [size, unit]
      }),
    ),
  )
  return file
}
export function decodeVideo(path: string, video: Track, sequences: bigint[]) {
  assert.equal(video.samples.length, sequences.length)
  assert.equal(video.width, 128)
  assert.equal(video.height, 96)
  const decoder = process.env.ZC_INDEPENDENT_DECODER
  if (!decoder) return
  const manifest = `${path}.sequences`
  writeFileSync(manifest, sequences.map((x) => `${x}\n`).join(''))
  const command = [
    decoder,
    video.codec === 'avc1' ? 'h264' : 'hevc',
    units(path, video),
    String(sequences.length),
    '0',
    manifest,
  ]
  const result = Bun.spawnSync(command)
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
}
export function decodeAudio(
  path: string,
  audio: Track,
  startSample: number,
  expectedFrames: number,
) {
  assert.equal((Number(audio.presentedUs!) * audio.rate) / 1e6, expectedFrames)
  assert.equal(audio.mediaDuration, BigInt(audio.delay! + expectedFrames))
  const decoder = process.env.ZC_AAC_DECODER
  if (!decoder) return
  const input = `${path}.aacraw`,
    output = `${path}.pcm`
  writeFileSync(
    input,
    Buffer.concat(
      [audio.config, ...audio.samples].flatMap((data) => {
        const size = Buffer.alloc(4)
        size.writeUInt32BE(data.length)
        return [size, data]
      }),
    ),
  )
  const result = Bun.spawnSync([decoder, input, output])
  assert.equal(result.exitCode, 0, result.stderr.toString())
  const pcm = readFileSync(output),
    channels = audio.channels!
  assert.equal(pcm.length, audio.samples.length * 1024 * channels * 2)
  let squared = 0
  for (let i = 0; i < expectedFrames; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = pcm.readInt16LE(
        ((audio.delay! + i) * channels + channel) * 2,
      )
      const expected =
        (((startSample + i) % 200) - 100) * 100 * (channel ? -1 : 1)
      squared += (value - expected) ** 2
    }
  }
  assert(
    Math.sqrt(squared / (expectedFrames * channels)) < 1500,
    'AAC priming/waveform/channel order',
  )
}
export function mkvFrames(path: string) {
  const data = readFileSync(path)
  assert.equal(data.readUInt32BE(0), 0x1a45dfa3)
  function vint(pos: number, identifier = false): [number, number] {
    let width = 1
    while (width <= 8 && !(data[pos] & (1 << (8 - width)))) width++
    assert(width <= 8 && pos + width <= data.length)
    let value = identifier ? data[pos] : data[pos] & ((1 << (8 - width)) - 1)
    for (let i = 1; i < width; i++) value = value * 256 + data[pos + i]
    return [value, pos + width]
  }
  function elements(start: number, end: number) {
    const values: { id: number; start: number; end: number }[] = []
    while (start < end) {
      const [id, p] = vint(start, true),
        [size, q] = vint(p)
      const finish = Math.min(end, q + size)
      assert(finish > start && finish <= end)
      values.push({ id, start: q, end: finish })
      start = finish
    }
    return values
  }
  const segment = elements(0, data.length).find((x) => x.id === 0x18538067)!
  assert(segment)
  const frames: Buffer[] = []
  for (const cluster of elements(segment.start, segment.end).filter(
    (x) => x.id === 0x1f43b675,
  )) {
    for (const block of elements(cluster.start, cluster.end).filter(
      (x) => x.id === 0xa3,
    )) {
      const [track, p] = vint(block.start)
      if (track === 1) frames.push(data.subarray(p + 3, block.end))
    }
  }
  assert(frames.length)
  for (const frame of frames) {
    assert.equal(frame.readUInt16BE(), 0xffd8)
    assert.equal(frame.readUInt16BE(frame.length - 2), 0xffd9)
  }
  return frames
}

/** Independently compare all decoded Y/U/V pixels at caller-selected geometry. */
export function decodeVideoI420(
  path: string,
  video: Track,
  frames: readonly Uint8Array[],
) {
  assert.equal(video.samples.length, frames.length)
  const decoder = process.env.ZC_INDEPENDENT_DECODER
  if (!decoder) return
  const manifest = `${path}.i420`
  writeFileSync(
    manifest,
    Buffer.concat(frames.map((frame) => Buffer.from(frame))),
  )
  const result = Bun.spawnSync([
    decoder,
    video.codec === 'avc1' ? 'h264' : 'hevc',
    units(path, video),
    String(frames.length),
    '--i420',
    String(video.width),
    String(video.height),
    manifest,
  ])
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
}
