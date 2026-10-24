// Independent receiver for the un-laced SimpleBlocks emitted by Home. Honor
// the Segment TimestampScale; do not mistake raw ticks for milliseconds.
export function simpleBlocks(bytes:Buffer) {
  const blocks:{track:number; ticks:bigint; data:Buffer}[] = []
  let scale = 1_000_000n
  function vint(at:number, id = false):{value:number; end:number; unknown:boolean}{
    let width = 1; while(width<=8 && !(bytes[at] & (1<<(8 - width))))width++
    if(width > 8 || at + width>bytes.length)throw Error('truncated EBML VINT')
    const mask = (1<<(8 - width))-1
    let value = id?bytes[at]:bytes[at]&mask, unknown = !id && value===mask
    for(let i = 1; i<width; i++) {value = value * 256 + bytes[at + i]; unknown &&= bytes[at + i]===255}
    if(!unknown&&!Number.isSafeInteger(value))throw Error('oversized EBML value')
    return {value, end:at + width, unknown}
  }
  function uint(at:number, end:number) { if(end - at < 1||end - at > 8)throw Error('invalid EBML uint'); let value = 0n; for(; at<end; at++)value = (value<<8n)|BigInt(bytes[at]); return value}
  function walk(at:number, end:number, cluster = 0n) {
    while(at<end) { const id = vint(at, true), size = vint(id.end), stop = size.unknown?end:size.end + size.value
    if(stop>end||stop<=at)throw Error('invalid EBML element')
    if(id.value===0x18538067||id.value===0x1f43b675||id.value===0x1549a966)walk(size.end, stop, 0n)
    else if(id.value===0x2ad7b1) {scale = uint(size.end, stop); if(scale===0n)throw Error('zero timestamp scale')}
    else if(id.value===0xe7)cluster = uint(size.end, stop)
    else if(id.value===0xa3) { const track = vint(size.end); if(track.end + 3>stop)throw Error('short SimpleBlock')
    if(bytes[track.end + 2]&6)throw Error('unexpected lacing')
    blocks.push({track:track.value, ticks:cluster + BigInt(bytes.readInt16BE(track.end)), data:bytes.subarray(track.end + 3, stop)})}
    at = stop
  }
}
walk(0, bytes.length); return blocks.map(({ticks, ...block})=>({...block, timeNs:ticks * scale, timeMs:Number(ticks * scale)/1e6}))
}
