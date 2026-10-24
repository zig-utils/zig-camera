import { expect, test } from 'bun:test'
import { Camera, FrameChannel, sharedCleanupState, drainSharedMappings } from '../../ts'

test('shared cleanup excludes live exports and remote views and preserves their pixels', async () => {
  const camera = new Camera({ simulate: true, width: 16, height: 8, writable: true })
  const [sender, receiver] = FrameChannel.pair()
  try {
    camera.start()
    using frame = camera.acquire()
    using source = frame.exportFrame()
    expect(source.trySend(sender.fd, 17n)).toBe(true)
    using remote = receiver.tryReceive()!
    const before = remote.copyPlanes('main')
    expect(sharedCleanupState()).toEqual({ exports: 0, remoteFrames: 0, busy: 0, retainedBytes: 0n })
    drainSharedMappings()
    expect(remote.copyPlanes('main')).toEqual(before)
    remote.close()
    source.close()
    drainSharedMappings()
    expect(sharedCleanupState().retainedBytes).toBe(0n)
  } finally {
    receiver.close(); sender.close(); await camera.close()
  }
})
