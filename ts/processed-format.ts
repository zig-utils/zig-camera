/** libcamera names; BGR888 means RGB bytes, XBGR8888 means RGBX bytes. */
export const processedFormats = [
  'YUV420',
  'BGR888',
  'RGB888',
  'XBGR8888',
  'XRGB8888',
  'YVU420',
  'NV12',
  'NV21',
  'YUYV',
  'YVYU',
  'UYVY',
  'VYUY',
  'BGR161616',
  'RGB161616',
] as const
export type ProcessedFormat = (typeof processedFormats)[number]
export function processedFormatCode(value: unknown): number {
  const code = processedFormats.indexOf(value as ProcessedFormat)
  if (code < 0) throw new RangeError('invalid processed stream format')
  return code
}
export function processedFormatName(code: number): ProcessedFormat {
  const value = processedFormats[code]
  if (value === undefined) throw new RangeError('invalid processed format code')
  return value
}

export function isYuv420(value: unknown): boolean {
  return ['YUV420', 'YVU420', 'NV12', 'NV21'].includes(value as string)
}

export function isYuv(value: unknown): boolean {
  return (
    isYuv420(value) ||
    ['YUYV', 'YVYU', 'UYVY', 'VYUY'].includes(value as string)
  )
}
