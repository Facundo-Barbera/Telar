import { createRequire } from "node:module";

type Ffi = typeof import("bun:ffi");

const ATTR_BIT_MAP_COUNT = 5;
const ATTR_CMN_RETURNED_ATTRS = 0x8000_0000;
const ATTR_CMNEXT_PRIVATESIZE = 0x8;
const FSOPT_NOFOLLOW = 0x1;
const FSOPT_ATTR_CMN_EXTENDED = 0x20;

type Getattrlist = (target: Buffer, list: number, out: number, size: number, options: number) => number;

let loaded: { call: Getattrlist; list: Uint8Array; out: Uint8Array; ptr: Ffi["ptr"] } | null | undefined;

function load() {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (process.platform !== "darwin" || typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return loaded;
  try {
    const { dlopen, FFIType, ptr } = createRequire(import.meta.url)("bun:ffi") as Ffi;
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      getattrlist: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    });
    const list = new Uint8Array(24);
    const view = new DataView(list.buffer);
    view.setUint16(0, ATTR_BIT_MAP_COUNT, true);
    view.setUint32(4, ATTR_CMN_RETURNED_ATTRS, true);
    view.setUint32(20, ATTR_CMNEXT_PRIVATESIZE, true);
    loaded = { call: symbols.getattrlist as unknown as Getattrlist, list, out: new Uint8Array(40), ptr };
  } catch {
    loaded = null;
  }
  return loaded;
}

/** Bytes only this file holds: an APFS clone's shared extents are not counted. Undefined off APFS. */
export function privateBytes(target: string): number | undefined {
  const api = load();
  if (!api) return undefined;
  const status = api.call(Buffer.from(`${target}\0`), api.ptr(api.list), api.ptr(api.out), api.out.byteLength, FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED);
  if (status !== 0) return undefined;
  const view = new DataView(api.out.buffer);
  if ((view.getUint32(20, true) & ATTR_CMNEXT_PRIVATESIZE) === 0) return undefined;
  return Number(view.getBigInt64(24, true));
}
