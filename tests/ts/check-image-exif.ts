import { join } from 'node:path'
const directory = Bun.argv[2],
  reader = process.env.ZC_EXIF_READER
if (!directory || !reader) throw Error('directory and ZC_EXIF_READER required')
for (const [name, format, enabled] of [
  ['cli-exif.jpeg', 'jpeg', true],
  ['cli-no-exif.jpeg', 'jpeg', false],
  ['cli-exif.png', 'png', true],
] as const) {
  const result = Bun.spawnSync([reader, format, join(directory, name)])
  if (result.exitCode) throw Error(result.stderr.toString())
  const exif = JSON.parse(result.stdout.toString())
  if (
    exif.hasExif !== enabled ||
    (enabled &&
      (exif.software !== 'zig-camera' ||
        exif.width !== 18 ||
        exif.height !== 10))
  )
    throw Error(`invalid CLI Exif: ${name}`)
}
console.log('CLI Exif defaults, explicit disable and PNG opt-in passed')
