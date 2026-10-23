import { FrameChannel, type RemoteFrame } from '../../ts'
import { closeSync } from 'node:fs'
const channel = FrameChannel.fromFd(0)
closeSync(0)
const end = performance.now() + 10000
let remote: RemoteFrame | undefined
while (!(remote = channel.tryReceive())) {
  if (performance.now() > end) throw new Error('child receive timeout')
  await Bun.sleep(2)
}
const info = remote.info()
let hash = 2166136261
for (const stream of info.streams)
  for (const bytes of remote.copyPlanes(stream.stream))
    for (const value of bytes) hash = Math.imul(hash ^ value, 16777619) >>> 0
using image = remote.makeImage()
const result = {
  hash,
  sequence: info.metadata.sequence.toString(),
  kind: remote.metadataCatalog().kind,
  png: Buffer.from(image.encode({ format: 'png' })).toString('base64'),
}
if (info.writable)
  for (const stream of info.streams)
    remote.withWritablePlanes(stream.stream, planes => {
      for (const plane of planes) plane[0] ^= 0x5a
    })
await Bun.write(Bun.stdout, JSON.stringify(result))
if (process.argv[2] === 'abrupt') process.exit(0)
const cookie = remote.cookie
remote.close()
while (!channel.tryAcknowledge(cookie)) {
  if (performance.now() > end) throw new Error('child ACK timeout')
  await Bun.sleep(2)
}
channel.close()
