/**
 * One kitty graphics command, as the OSC handler receives it: `G<keys>;<payload>`.
 *
 * Keys are `k=v` pairs separated by commas; a value is an integer or a single
 * character. Keys this decoder does not use are accepted and ignored, as kitty
 * itself does. A pair it cannot read makes the whole command malformed.
 *
 * https://sw.kovidgoyal.net/kitty/graphics-protocol/
 */
export type KittyCommand = {
  keys: Map<string, string | number>;
  payload: string;
};

const PAIR = /^([a-zA-Z])=(-?\d+|[a-zA-Z])$/;

export function parseKittyCommand(data: string): KittyCommand | undefined {
  if (!data.startsWith("G")) return undefined;
  const semi = data.indexOf(";");
  const control = semi === -1 ? data.slice(1) : data.slice(1, semi);
  const payload = semi === -1 ? "" : data.slice(semi + 1);
  const keys = new Map<string, string | number>();
  if (control !== "") {
    for (const pair of control.split(",")) {
      const match = PAIR.exec(pair);
      if (!match) return undefined;
      const [, key, value] = match;
      keys.set(key, /^-?\d+$/.test(value) ? Number(value) : value);
    }
  }
  return { keys, payload };
}

export function numberKey(command: KittyCommand, key: string, fallback = 0): number {
  const value = command.keys.get(key);
  return typeof value === "number" ? value : fallback;
}

export function charKey(command: KittyCommand, key: string, fallback: string): string {
  const value = command.keys.get(key);
  return typeof value === "string" ? value : fallback;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Undefined for anything that is not base64 — a malformed chunk, not an image. */
export function decodeBase64(text: string): Uint8Array | undefined {
  if (!BASE64.test(text) || text.length % 4 === 1) return undefined;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}
