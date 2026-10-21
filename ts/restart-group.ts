import { native as n, ptr, check, type Pointer } from './ffi'
interface Member {
  native?: Pointer
  resolvePublication?: () => void
  rejectPublication?: (error: unknown) => void
  check?: () => void
  install?: () => void
  resolveInstallation?: () => void
  failed?: boolean
}
/** Internal readiness rendezvous; native code owns the shared commit decision. */
export class RestartGroup {
  private members: Member[]
  private resolveReady!: () => void
  private rejectReady!: (error: unknown) => void
  readonly ready: Promise<void>
  get error() {
    return this.failure
  }
  published = false
  private installationDone = false
  private failure: unknown
  constructor(
    count: number,
    private installCamera: () => void,
  ) {
    if (!Number.isInteger(count) || count < 1 || count > 8)
      throw new RangeError('recording mode group size')
    this.members = Array.from({ length: count }, () => ({}))
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.ready.catch(() => {})
  }
  prepared(index: number, native: Pointer, checkReady: () => void) {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const member = this.members[index]
    if (!member || member.native) throw Error('duplicate restart preparation')
    member.native = native
    member.check = checkReady
    const publication = new Promise<void>((resolve, reject) => {
      member.resolvePublication = resolve
      member.rejectPublication = reject
    })
    if (this.members.every((m) => m.native)) this.resolveReady()
    return publication
  }
  publish(seal: () => void) {
    if (this.failure !== undefined) throw this.failure
    if (this.published || !this.members.every((m) => m.native))
      throw Error('restart group is not ready')
    for (const member of this.members) member.check!()
    const jobs = new BigUint64Array(this.members.map((m) => BigInt(m.native!)))
    check(
      n.zc_producer_jobs_restart_publish(ptr(jobs), jobs.length),
      'recording group publication',
    )
    this.published = true
    try {
      seal()
    } finally {
      for (const member of this.members) member.resolvePublication!()
    }
  }
  installed(index: number, install: () => void) {
    const member = this.members[index]
    if (!this.published || !member || member.install)
      throw Error('invalid restart installation')
    member.install = install
    const done = new Promise<void>((resolve) => {
      member.resolveInstallation = resolve
    })
    this.installIfReady()
    return done
  }
  private installIfReady() {
    if (
      !this.published ||
      this.installationDone ||
      !this.members.every((m) => m.install || m.failed)
    )
      return
    this.installationDone = true
    for (const member of this.members) {
      try {
        member.install?.()
      } catch (error) {
        this.failure ??= error
      }
    }
    try {
      this.installCamera()
    } catch (error) {
      this.failure ??= error
    }
    for (const member of this.members) member.resolveInstallation?.()
  }
  failed(index: number, error: unknown) {
    const member = this.members[index]
    if (member) member.failed = true
    this.abort(error)
  }
  abort(error: unknown) {
    this.failure ??= error === undefined ? Error('restart group failed') : error
    if (!this.published) {
      this.rejectReady(this.failure)
      for (const member of this.members)
        member.rejectPublication?.(this.failure)
    } else this.installIfReady()
  }
}
export interface GroupRestartMember {
  group: RestartGroup
  index: number
}
