import {
  native as n,
  ptr,
  storage,
  check,
  CameraError,
  outPointer,
  handle,
  type Pointer,
} from './ffi'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
  fsyncSync,
  renameSync,
  lstatSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
export type TuningValue =
  | null
  | boolean
  | number
  | string
  | TuningValue[]
  | { [key: string]: TuningValue }
export const TUNING_MAX_BYTES = 16 * 1024 * 1024
const typedByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
)!.get!
function throwFailures(errors: unknown[]) {
  if (errors.length === 1) throw errors[0]
  if (errors.length)
    throw new AggregateError(errors, 'tuning file operation and cleanup failed')
}
function jsonBytes(input: string | Uint8Array) {
  if (typeof input === 'string') {
    if (
      !input.length ||
      input.length > TUNING_MAX_BYTES ||
      !input.isWellFormed() ||
      Buffer.byteLength(input) > TUNING_MAX_BYTES
    )
      throw new RangeError(
        'tuning JSON exceeds limits or is not well-formed UTF-8',
      )
    return new TextEncoder().encode(input)
  }
  if (!(input instanceof Uint8Array))
    throw new TypeError('tuning JSON must be a string or Uint8Array')
  const length = typedByteLength.call(input)
  if (!length || length > TUNING_MAX_BYTES)
    throw new RangeError('invalid tuning JSON size')
  return new Uint8Array(input)
}
function algorithmName(name: string) {
  if (
    typeof name !== 'string' ||
    !name.length ||
    name.length > 256 ||
    !name.isWellFormed() ||
    name.includes('\0') ||
    Buffer.byteLength(name) > 256
  )
    throw new RangeError('invalid tuning algorithm name')
  return new TextEncoder().encode(name)
}
function pathName(path: string) {
  if (
    typeof path !== 'string' ||
    !path.length ||
    path.length > 4096 ||
    !path.isWellFormed() ||
    path.includes('\0') ||
    Buffer.byteLength(path) > 4096
  )
    throw new RangeError('invalid tuning path')
  return path
}
/** Snapshot JSON data without invoking toJSON, caller iterators or getters twice. */
function encodeValue(value: TuningValue) {
  let nodes = 0,
    strings = 0
  const parents = new Set<object>()
  const string = (text: string) => {
    if (text.length > TUNING_MAX_BYTES || !text.isWellFormed())
      throw new RangeError('invalid tuning string')
    strings += Buffer.byteLength(text)
    if (strings > TUNING_MAX_BYTES)
      throw new RangeError('tuning value exceeds byte budget')
    return text
  }
  const snapshot = (source: unknown, depth: number): TuningValue => {
    if (++nodes > 262144 || depth > 64)
      throw new RangeError('tuning value exceeds structural budget')
    if (source === null || typeof source === 'boolean') return source
    if (typeof source === 'string') return string(source)
    if (typeof source === 'number') {
      if (
        !Number.isFinite(source) ||
        (Number.isInteger(source) && !Number.isSafeInteger(source))
      )
        throw new RangeError('use raw tuning JSON for nonrepresentable numbers')
      return source
    }
    if (typeof source !== 'object' || parents.has(source))
      throw new TypeError('invalid or cyclic tuning value')
    parents.add(source)
    try {
      if (Array.isArray(source)) {
        const count = source.length
        if (count > 262144 - nodes)
          throw new RangeError('tuning array exceeds node budget')
        const values: TuningValue[] = []
        for (let i = 0; i < count; i++)
          values.push(snapshot(source[i], depth + 1))
        return values
      }
      const prototype = Object.getPrototypeOf(source)
      if (prototype !== null && prototype !== Object.prototype)
        throw new TypeError('tuning values must be plain JSON data')
      const keys = Object.keys(source)
      if (keys.length > 262144 - nodes)
        throw new RangeError('tuning object exceeds node budget')
      const result = Object.create(null) as Record<string, TuningValue>
      for (const key of keys)
        result[string(key)] = snapshot(
          (source as Record<string, unknown>)[key],
          depth + 1,
        )
      return result
    } finally {
      parents.delete(source)
    }
  }
  return JSON.stringify(snapshot(value, 0))
}
export class TuningDocument {
  private constructor(private nativeHandle?: Pointer) {}
  static parse(input: string | Uint8Array) {
    const bytes = jsonBytes(input),
      out = outPointer()
    check(
      n.zc_tuning_document_open(ptr(bytes), BigInt(bytes.length), ptr(out)),
      'parse tuning document',
    )
    return new TuningDocument(handle(out))
  }
  static fromObject(value: { [key: string]: TuningValue }) {
    return this.parse(encodeValue(value))
  }
  private open() {
    if (!this.nativeHandle) throw new CameraError(-2, 'closed tuning document')
    return this.nativeHandle
  }
  get version() {
    const out = new Uint32Array(1)
    check(n.zc_tuning_document_version(this.open(), ptr(out)), 'tuning version')
    return out[0] as 1 | 2
  }
  private copy(
    operation: (data: Pointer | null, size: bigint, out: Pointer) => number,
  ) {
    const length = new BigUint64Array(1)
    check(operation(null, 0n, ptr(length)), 'tuning JSON size')
    if (length[0] > BigInt(TUNING_MAX_BYTES))
      throw new RangeError('tuning JSON exceeds byte budget')
    const data = storage(Number(length[0]))
    check(
      operation(ptr(data), BigInt(data.length), ptr(length)),
      'copy tuning JSON',
    )
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  }
  json() {
    const owned = this.open()
    return this.copy((data, size, out) =>
      n.zc_tuning_document_copy(owned, data, size, out),
    )
  }
  algorithmJSON(name: string) {
    const key = algorithmName(name),
      owned = this.open()
    return this.copy((data, size, out) =>
      n.zc_tuning_document_find(owned, ptr(key), key.length, data, size, out),
    )
  }
  findAlgorithm(name: string): TuningValue {
    return JSON.parse(this.algorithmJSON(name))
  }
  toObject(): { [key: string]: TuningValue } {
    return JSON.parse(this.json())
  }
  replaceAlgorithmJSON(name: string, input: string | Uint8Array) {
    const bytes = jsonBytes(input),
      key = algorithmName(name),
      owned = this.open()
    check(
      n.zc_tuning_document_replace(
        owned,
        ptr(key),
        key.length,
        ptr(bytes),
        BigInt(bytes.length),
      ),
      'replace tuning algorithm',
    )
    return this
  }
  replaceAlgorithm(name: string, value: TuningValue) {
    return this.replaceAlgorithmJSON(name, encodeValue(value))
  }
  save(path: string) {
    const target = resolve(pathName(path)),
      bytes = Buffer.from(this.json()),
      temporary = join(dirname(target), `.zc-tuning-${randomUUID()}.tmp`)
    let fd: number | undefined,
      identity: { ino: bigint; dev: bigint } | undefined,
      published = false
    const errors: unknown[] = []
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      )
      identity = fstatSync(fd, { bigint: true })
      let offset = 0
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset)
        if (!written) throw Error('tuning file write made no progress')
        offset += written
      }
      fsyncSync(fd)
      const owned = fd
      fd = undefined
      closeSync(owned)
      const staged = lstatSync(temporary, { bigint: true })
      if (
        staged.ino !== identity.ino ||
        staged.dev !== identity.dev ||
        !staged.isFile()
      )
        throw Error('staged tuning file changed')
      renameSync(temporary, target)
      published = true
    } catch (error) {
      errors.push(error)
    } finally {
      // If the first stat failed, retry on our still-owned descriptor before
      // closing. Never unlink a path for which ownership cannot be established.
      if (fd !== undefined && !identity) {
        try {
          identity = fstatSync(fd, { bigint: true })
        } catch (error) {
          errors.push(error)
        }
      }
      try {
        if (fd !== undefined) {
          const owned = fd
          fd = undefined
          closeSync(owned)
        }
      } catch (error) {
        errors.push(error)
      }
      if (!published && identity) {
        try {
          const staged = lstatSync(temporary, { bigint: true })
          if (staged.ino === identity.ino && staged.dev === identity.dev)
            unlinkSync(temporary)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            errors.push(error)
        }
      }
    }
    throwFailures(errors)
  }
  close() {
    const owned = this.nativeHandle
    this.nativeHandle = undefined
    if (owned) n.zc_tuning_document_close(owned)
  }
  [Symbol.dispose]() {
    this.close()
  }
}
export interface LoadTuningOptions {
  directory?: string
  directories?: readonly string[]
  platform?: 'pisp' | 'vc4'
}
export function loadTuningFile(
  name: string,
  options: LoadTuningOptions = {},
): TuningDocument {
  pathName(name)
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('invalid tuning search options')
  const directory = options.directory,
    supplied = options.directories,
    platform = options.platform ?? 'pisp'
  if (platform !== 'pisp' && platform !== 'vc4')
    throw new RangeError('invalid tuning platform')
  if (directory !== undefined && supplied !== undefined)
    throw new RangeError('choose directory or directories')
  let directories: string[]
  if (directory !== undefined) directories = [pathName(directory)]
  else if (supplied !== undefined) {
    if (!Array.isArray(supplied) || !supplied.length || supplied.length > 32)
      throw new RangeError('1..32 tuning search directories required')
    directories = []
    for (let i = 0, count = supplied.length; i < count; i++)
      directories.push(pathName(supplied[i]))
  } else
    directories = [
      join(homedir(), 'libcamera/src/ipa/rpi', platform, 'data'),
      `/usr/local/share/libcamera/ipa/rpi/${platform}`,
      `/usr/share/libcamera/ipa/rpi/${platform}`,
    ]
  const candidates = isAbsolute(name)
    ? [name]
    : directories.map((directory) => resolve(directory, name))
  for (const candidate of candidates) {
    pathName(candidate)
    let fd: number
    try {
      fd = openSync(candidate, constants.O_RDONLY | constants.O_NONBLOCK)
    } catch (error) {
      if (
        ['ENOENT', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        continue
      throw error
    }
    let bytes: Buffer | undefined
    const errors: unknown[] = []
    try {
      const before = fstatSync(fd, { bigint: true })
      if (before.isFile()) {
        if (before.size > BigInt(TUNING_MAX_BYTES))
          throw new RangeError('tuning file exceeds byte budget')
        const data = Buffer.alloc(Number(before.size) + 1)
        let length = 0
        while (length < data.length) {
          const read = readSync(fd, data, length, data.length - length, length)
          if (!read) break
          length += read
        }
        const after = fstatSync(fd, { bigint: true })
        if (
          BigInt(length) !== before.size ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw Error('tuning file changed during read')
        bytes = data.subarray(0, length)
      }
    } catch (error) {
      errors.push(error)
    } finally {
      try {
        closeSync(fd)
      } catch (error) {
        errors.push(error)
      }
    }
    throwFailures(errors)
    // Close the file before allocating a native document, so even exceptional
    // close failures cannot lose an unpublished document owner.
    if (bytes) return TuningDocument.parse(bytes)
  }
  throw Object.assign(Error(`Tuning file not found: ${name}`), {
    code: 'ENOENT',
  })
}
export function findTuningAlgorithm(document: TuningDocument, name: string) {
  return document.findAlgorithm(name)
}
