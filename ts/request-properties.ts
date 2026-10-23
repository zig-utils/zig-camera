import {ptr,check,storage,type Pointer} from './ffi'
import {decodeCatalog} from './catalog'
/** @internal Caller holds an immutable native snapshot through both calls. */
export function readPropertiesCatalog(copy:(data:Pointer|null,capacity:bigint,length:Pointer)=>number){
  const size=new BigUint64Array(1)
  check(copy(null,0n,ptr(size)))
  const expected=size[0]
  if(expected<16n||expected>4n*1024n*1024n)throw new Error('invalid source properties size')
  const bytes=storage(Number(expected))
  check(copy(ptr(bytes),expected,ptr(size)))
  if(size[0]!==expected)throw new Error('source properties size changed')
  const catalog=decodeCatalog(bytes)
  if(catalog.kind!=='properties')throw new Error('invalid source properties kind')
  return catalog
}
