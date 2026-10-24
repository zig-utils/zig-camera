import { existsSync, writeFileSync, renameSync } from 'node:fs'
import { ProcessSink } from '../../ts/process-output'

const [pids, grand, ready] = process.argv.slice(2)
const child = new URL('./process-output-consumer.ts', import.meta.url).pathname
const sink = new ProcessSink({command:[process.execPath, child, 'descendant', pids, grand], writeTimeoutMs:60000, terminationGraceMs:30})
await sink.start(); sink.commit()
while(!existsSync(pids)||!existsSync(grand))await Bun.sleep(1)
const publication = ready + '.pending'
writeFileSync(publication, JSON.stringify(sink.stats(), (_, value)=>typeof value==='bigint'?String(value):value), { flag: 'wx' })
renameSync(publication, ready)
await sink.write(new Uint8Array(4 * 1024 * 1024))
await sink.stop()
