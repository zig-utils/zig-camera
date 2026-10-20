import { view } from './ffi'
const u64 = (d: Uint8Array, offset = 0) => view(d).getBigUint64(offset, true)
export function decodeMetadata(data: Uint8Array) {
  const d = view(data)
  return {
    eventId: u64(data, 8),
    sequence: u64(data, 16),
    timestampNs: u64(data, 24),
    controlRevision: u64(data, 32),
    exposureUs: d.getUint32(40, true),
    afState: d.getInt32(44, true),
    analogueGain: d.getFloat32(56, true),
    lensPosition: d.getFloat32(60, true),
    frameDurationUs: u64(data, 72),
    validMask: d.getUint32(4, true),
    afPauseState: d.getInt32(48, true),
    redGain: d.getFloat32(64, true),
    blueGain: d.getFloat32(68, true),
    crop: {
      x: d.getInt32(80, true),
      y: d.getInt32(84, true),
      width: d.getInt32(88, true),
      height: d.getInt32(92, true),
    },
  }
}
