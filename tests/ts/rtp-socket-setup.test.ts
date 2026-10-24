import { expect, test, spyOn } from 'bun:test'
import { RtpOutput } from '../../ts'
test('default RTP transport closes its opened socket if multicast setup fails', async () => {
  const marker = Error('multicast option failed')
  let closed = 0
  const socket = {
    closed: false,
    send() {
      return true
    },
    close() {
      closed++
    },
    setMulticastTTL() {
      throw marker
    },
  }
  const mocked = spyOn(Bun, 'udpSocket').mockImplementation(
    async () => socket as never,
  )
  const output = new RtpOutput({ address: '239.1.2.3', port: 5004 })
  try {
    await expect(output.start()).rejects.toBe(marker)
    expect(closed).toBe(1)
    expect(output.stats().phase).toBe('stopped')
  } finally {
    await output.close()
    mocked.mockRestore()
  }
})
