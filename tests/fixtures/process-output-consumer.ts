import { closeSync, writeFileSync, writeSync } from 'node:fs'

const [mode, path = '', extra = ''] = process.argv.slice(2)
if(mode==='hang'||mode==='descendant') {
  process.on('SIGTERM', ()=>{})
  if(mode==='descendant') {
    const child = Bun.spawn([process.execPath, import.meta.path, 'hang', extra], {stdin:'ignore', stdout:'inherit', stderr:'inherit'})
    writeFileSync(path, JSON.stringify({pid:process.pid, descendant:child.pid}))
  }else if(path)writeFileSync(path, JSON.stringify({pid:process.pid}))
  setInterval(()=>{}, 1000)
}else if(mode==='closed-input') {
  closeSync(0); writeFileSync(path, JSON.stringify({pid:process.pid})); process.on('SIGTERM', ()=>{}); setInterval(()=>{}, 1000)
}else {
  if(mode==='flood') {
    const bytes = Uint8Array.from({length:4096}, (_, i)=>i&255)
    for(let i = 0; i < 128; i++) {writeSync(1, bytes); writeSync(2, bytes)}
    if(path)writeFileSync(path, JSON.stringify({pid:process.pid}))
  }
  if(mode==='early-exit') {writeSync(2, Buffer.from('consumer failed early')); process.exit(42)}
  const output = mode==='copy-file'||mode==='slow-file'?Bun.file(path).writer():undefined
  for await(const bytes of Bun.stdin.stream()) {
    if(mode==='fail-first-input') {writeSync(2, Buffer.from('consumer failed after input')); process.exit(42)}
    if(mode==='slow-file')await Bun.sleep(2)
    if(output) {await output.write(bytes); await output.flush()}
    else if(mode!=='flood')writeSync(1, bytes)
  }
  if(output)await output.end()
  if(mode==='fail-at-eof') {writeSync(2, Buffer.from('consumer failed at EOF')); process.exit(42)}
}
