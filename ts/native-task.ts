import { native, storage, ptr, type Pointer } from './ffi'
declare const self: {
  onmessage: (event: { data: { operation: string; handle: Pointer } }) => void
  postMessage: (value: unknown) => void
  close: () => void
}
self.onmessage = ({
  data,
}: {
  data: { operation: string; handle: Pointer }
}) => {
  let code = 0
  let results: Uint8Array | undefined
  let count = 0
  try {
    if (data.operation === 'close') {
      results = storage(8 * 32)
      const amount = new Uint32Array(1)
      code = native.zc_video_close_outputs(
        data.handle,
        ptr(results),
        8,
        ptr(amount),
      )
      count = amount[0]
    } else if (data.operation === 'snapshot') {
      try {
        code = native.zc_snapshot_write(data.handle)
      } finally {
        native.zc_snapshot_close(data.handle)
      }
    } else if (data.operation === 'drain') {
      try {
        code = native.zc_output_job_wait(data.handle, 0xffffffff)
      } finally {
        native.zc_output_job_close(data.handle)
      }
    } else throw new Error('unknown native task')
    self.postMessage({ code, results, count })
  } catch (error) {
    self.postMessage({ error: String(error) })
  }
  self.close()
}
