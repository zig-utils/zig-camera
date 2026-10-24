/** Shared identity guard across RTP and raw hosted socket adapters. A factory
 * must never hide one underlying descriptor behind multiple wrapper objects. */
export const socketOwners = new WeakMap<object, object>()
