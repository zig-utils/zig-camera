import {
  native as n,
  ptr,
  storage,
  view,
  check,
  CameraError,
  type Pointer,
} from './ffi'
import type { TypedCatalog } from './catalog'
import type { NativeControl } from './control-values'
export type SynchronizationMode = 'off' | 'server' | 'client'
export interface SynchronizationOptions {
  /** Positive server ready-frame count. Omitted leaves the backend setting alone. */
  frames?: number
}
export interface FrameSynchronization {
  readonly ready?: boolean
  /** Signed microseconds until the backend's ready time, when reported. */
  readonly timerUs?: bigint
}
export function readFrameSynchronization(
  camera: Pointer,
  token: bigint,
): FrameSynchronization {
  const bytes = storage(24),
    data = view(bytes)
  check(
    n.zc_get_frame_sync_state(camera, token, ptr(bytes)),
    'frame synchronization',
  )
  const valid = data.getUint32(4, true)
  return Object.freeze({
    ...(valid & 1 ? { ready: !!data.getUint32(8, true) } : {}),
    ...(valid & 2 ? { timerUs: data.getBigInt64(16, true) } : {}),
  })
}
export function synchronizationOptions(
  mode: SynchronizationMode,
  options: SynchronizationOptions,
) {
  if (
    typeof mode !== 'string' ||
    !Object.hasOwn({ off: 0, server: 1, client: 2 }, mode)
  )
    throw new RangeError('invalid synchronization mode')
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('invalid synchronization options')
  const frames = options.frames
  if (
    frames !== undefined &&
    (mode !== 'server' ||
      !Number.isInteger(frames) ||
      frames < 1 ||
      frames > 0x7fffffff)
  )
    throw new RangeError('invalid synchronization frame count')
  return { mode: { off: 0, server: 1, client: 2 }[mode], frames }
}
export function synchronizationControls(
  catalog: TypedCatalog,
  options: ReturnType<typeof synchronizationOptions>,
): NativeControl[] {
  const select = (name: string, value: number): NativeControl => {
    const candidates = catalog.records.filter(
      (record) =>
        record.name === name &&
        (record.vendor === undefined ||
          record.vendor === 'rpi' ||
          record.vendor === 'libcamera'),
    )
    if (candidates.length !== 1)
      throw new CameraError(-8, `${name} unavailable or ambiguous`)
    const record = candidates[0]
    if (
      record.kind !== 'int32' ||
      record.input === false ||
      record.isArray === true ||
      (record.extent !== undefined && record.extent !== 0)
    )
      throw new CameraError(-8, `${name} is not a scalar input`)
    return {
      id: record.id,
      name: record.name,
      vendor: record.vendor,
      kind: 'int32',
      value,
    }
  }
  return [
    ...(options.frames === undefined
      ? []
      : [select('SyncFrames', options.frames)]),
    select('SyncMode', options.mode),
  ]
}
