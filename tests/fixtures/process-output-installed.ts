import {ProcessSink} from '../../ts/process-output'
process.chdir(process.argv[2])
const sink=new ProcessSink({command:[process.execPath,'-e','await Bun.stdin.text()']})
await sink.start();sink.commit();await sink.stop()
if(sink.stats().consumerExitCode!==0)throw Error('installed consumer exit')
