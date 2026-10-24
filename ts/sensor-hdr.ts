import {
  native as n,
  ptr,
  storage,
  view,
  check,
  outPointer,
  handle,
  CameraError,
  type Pointer,
} from './ffi'
export type SensorHdrBackend = 'libcamera' | 'synthetic'
/** Runtime ISP modes. Query Control.hdrMode support/ranges on the selected camera. */
export const HdrMode = Object.freeze({
  off: 0,
  singleExposure: 1,
  multiExposure: 2,
  night: 3,
  multiExposureUnmerged: 4,
} as const)
export type HdrModeValue = (typeof HdrMode)[keyof typeof HdrMode]
export interface Imx708Options {
  backend?: SensorHdrBackend
  /** Global discovery index; mutually exclusive with cameraId. */
  index?: number
  /** Exact full discovered ID. Default selects the first matching IMX708. */
  cameraId?: string
}
export interface SensorHdrState {
  readonly backend: SensorHdrBackend
  readonly enabled?: boolean
  readonly previousEnabled?: boolean
  readonly changed?: boolean
  readonly writeAttempted: boolean
  readonly writeSucceeded: boolean
  readonly catalogInvalidated: boolean
  readonly managerGeneration: bigint
  readonly systemErrno: number
}
function readState(bytes: Uint8Array): Readonly<SensorHdrState> {
  const d = view(bytes),
    backend = d.getUint32(4, true),
    flags = d.getUint32(8, true),
    enabled = d.getUint32(24, true),
    previous = d.getUint32(28, true)
  if (
    d.getUint32(0, true) !== 32 ||
    backend > 1 ||
    flags & ~127 ||
    enabled > 1 ||
    previous > 1 ||
    (flags & 4 && (flags & 3) !== 3)
  )
    throw new Error('invalid sensor HDR state')
  return Object.freeze({
    backend: backend ? 'libcamera' : 'synthetic',
    enabled: flags & 1 ? !!enabled : undefined,
    previousEnabled: flags & 2 ? !!previous : undefined,
    changed: (flags & 3) === 3 ? !!(flags & 4) : undefined,
    writeAttempted: !!(flags & 8),
    writeSucceeded: !!(flags & 16),
    catalogInvalidated: !!(flags & 32),
    managerGeneration: d.getBigUint64(16, true),
    systemErrno: d.getInt32(12, true),
  })
}
/** State remains available when a write failed after changing the sensor or its
 * final value could not be read. Never interpret an absent enabled as false. */
export class SensorHdrError extends CameraError {
  constructor(
    code: number,
    operation: string,
    readonly state: Readonly<SensorHdrState>,
  ) {
    super(code, operation)
    this.name = 'SensorHdrError'
  }
}
/** A bounded pinned sensor descriptor. Mutations require all cameras and manager
 * watches to close first. Closing this helper preserves the selected sensor mode.
 * Synthetic backend models controls/ownership only, never HDR image quality. */
export class IMX708 implements Disposable {
  private owned?: Pointer
  readonly backend: SensorHdrBackend
  readonly cameraId: string
  constructor(source: Imx708Options = {}) {
    if (!source || typeof source !== 'object')
      throw new TypeError('invalid IMX708 options')
    const requestedBackend = source.backend,
      index = source.index,
      id = source.cameraId,
      backend = requestedBackend === undefined ? 'libcamera' : requestedBackend
    if (backend !== 'libcamera' && backend !== 'synthetic')
      throw new RangeError('invalid IMX708 backend')
    if (
      index !== undefined &&
      (typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > 0xfffffffe)
    )
      throw new RangeError('invalid camera index')
    if (
      id !== undefined &&
      (typeof id !== 'string' ||
        !id.length ||
        !id.isWellFormed() ||
        id.includes('\0') ||
        Buffer.byteLength(id) > 4096)
    )
      throw new RangeError('invalid camera ID')
    if (index !== undefined && id !== undefined)
      throw new RangeError('camera ID and index are mutually exclusive')
    this.backend = backend
    const bytes = id === undefined ? undefined : new TextEncoder().encode(id),
      output = outPointer()
    check(
      n.zc_imx708_open(
        backend === 'synthetic' ? 0 : 1,
        index ?? 0xffffffff,
        bytes ? ptr(bytes) : null,
        bytes?.byteLength ?? 0,
        ptr(output),
      ),
      'open IMX708',
    )
    this.owned = handle(output)
    try {
      const size = new BigUint64Array(1)
      check(
        n.zc_imx708_camera_id(this.owned, null, 0n, ptr(size)),
        'IMX708 identity size',
      )
      if (size[0] < 1n || size[0] > 4096n)
        throw new RangeError('invalid IMX708 identity size')
      const snapshot = storage(Number(size[0]))
      check(
        n.zc_imx708_camera_id(
          this.owned,
          ptr(snapshot),
          BigInt(snapshot.length),
          ptr(size),
        ),
        'IMX708 identity',
      )
      this.cameraId = new TextDecoder('utf-8', { fatal: true }).decode(snapshot)
    } catch (error) {
      n.zc_imx708_close(this.owned)
      this.owned = undefined
      throw error
    }
  }
  private open() {
    if (!this.owned) throw new CameraError(-5, 'closed IMX708')
    return this.owned
  }
  getSensorHdrMode() {
    const bytes = storage(32),
      code = n.zc_imx708_get_hdr_mode(this.open(), ptr(bytes)),
      state = readState(bytes)
    if (code) throw new SensorHdrError(code, 'read sensor HDR', state)
    return state
  }
  setSensorHdrMode(enabled: boolean) {
    if (typeof enabled !== 'boolean')
      throw new TypeError('sensor HDR enable must be boolean')
    const bytes = storage(32),
      code = n.zc_imx708_set_hdr_mode(this.open(), enabled ? 1 : 0, ptr(bytes)),
      state = readState(bytes)
    if (code) throw new SensorHdrError(code, 'set sensor HDR', state)
    return state
  }
  close() {
    if (this.owned) {
      check(n.zc_imx708_close(this.owned), 'close IMX708')
      this.owned = undefined
    }
  }
  [Symbol.dispose]() {
    this.close()
  }
}

/** @internal Preserve logical Camera ownership while mode workers reopen handles. */
export function retainSensorLayout(backend: number) {
  const out = outPointer()
  check(
    n.zc_sensor_layout_scope_open(backend, ptr(out)),
    'retain camera sensor layout',
  )
  let owned: Pointer | undefined = handle(out)
  return {
    close() {
      if (owned) {
        check(
          n.zc_sensor_layout_scope_close(owned),
          'release camera sensor layout',
        )
        owned = undefined
      }
    },
  }
}
