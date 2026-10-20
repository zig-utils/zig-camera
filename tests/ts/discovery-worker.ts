import { Camera } from '../../ts'
declare const self: {
  onmessage: () => void
  postMessage(value: unknown): void
  close(): void
}
self.onmessage = () => {
  const result = Array.from({ length: 3 }, () =>
    Camera.discover().map((camera) => camera.id),
  )
  self.postMessage(result)
  self.close()
}
self.postMessage('ready')
