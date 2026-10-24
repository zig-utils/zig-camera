import { native as n, check } from '../../../ts/ffi'
declare const self: { onmessage: (event: { data: { id: bigint; explicit: boolean } }) => void; postMessage(value: unknown): void }
self.onmessage = ({ data }) => {
  check(n.zc_capture_open_scope_attach(data.id), 'test attach')
  if (data.explicit) check(n.zc_capture_open_scope_detach(data.id), 'test detach')
  self.postMessage('attached')
  setInterval(() => {}, 1000)
}
