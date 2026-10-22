// Scalar reference adapted from pinned Picamera2 equations (BSD-2-Clause); see NOTICE.
export function referenceWord(word: number): number[] {
  const m = word % 4,
    base = (word >>> 2) % 512,
    delta = ((word >>> 11) % 128) - 64
  let q: number[], curve: (x: number) => number
  if (m === 3) {
    const pair = (half: number) => [
      (half % 16) + 16 * Math.floor(Math.floor(half / 256) / 11),
      Math.floor(half / 16) % 176,
    ]
    q = [...pair((word >>> 2) % 32768), ...pair(word >>> 17)]
    curve = (x) => Math.max(x * 256, (x - 47) * 512)
  } else {
    const low = m * base < 768,
      a = low ? Math.max(base, base - delta) : base,
      b = low ? Math.max(base, base + delta) : delta + 448,
      neighbor = (v: number, residual: number) =>
        Math.min(1536 / 2 ** m, Math.max(0, v - 64)) + residual
    q = [neighbor(a, (word >>> 18) % 128), a, b, neighbor(b, word >>> 25)]
    curve = (x) => Math.max(x * 16, (x - 160) * 32, m * x * 64)
  }
  return q.map((v) => Math.min(65535, Math.max(0, curve(v) + 2048)))
}
