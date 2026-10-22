/** libcamera names; BGR888 means RGB bytes, XBGR8888 means RGBX bytes. */
export const processedFormats = [
  'YUV420',
  'BGR888',
  'RGB888',
  'XBGR8888',
  'XRGB8888',
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
