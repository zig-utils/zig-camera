import assert from 'node:assert/strict'
import { Camera, CameraError } from '../../ts'
try {
  const camera = new Camera()
  assert.equal(camera.info().backend, 1, 'real backend must load')
  await camera.close()
  console.log('libcamera loaded and discovered a camera')
} catch (error) {
  if (!(error instanceof CameraError) || error.code !== -9) throw error
  console.log('libcamera loaded; no camera present on CI host (expected)')
}
