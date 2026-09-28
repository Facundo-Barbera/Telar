/**
 * KITTY GRAPHICS, AGAINST A REAL XTERM.JS AND THE REAL @xterm/addon-image (#884).
 *
 * The bytes go in where a PTY's do — `attachTerminal`'s writer — so the APC
 * rewrite is under test too; without it xterm discards every command and each
 * placement assertion below fails. What is read back is the buffer: which cells
 * the image store says hold an image, where the cursor ended, and what was
 * written back towards the PTY.
 *
 * Pixels are the one thing faked. A headless DOM has no 2D canvas and no
 * `createImageBitmap`, so the backend reads the PNG's own IHDR for its size and
 * hands back an object of that size; the store places by size alone.
 *
 * The fixture is built here rather than recorded: a real 4×4 PNG, sent the way
 * fastfetch's `kitty` logo sends one — `a=T,f=100` with `c`/`r` — and chunked
 * the way kitty's docs chunk it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { KittyFileAnswer, TerminalBridge, TerminalChunk } from "../bridge";
import { attachTerminal } from "../session";
import { kittyApcRewriter, KITTY_GRAPHICS_OSC } from "./apc";
import type { KittyGraphicsAddon as KittyAddonType, KittyImageBackend } from "./addon";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

let Terminal: typeof import("@xterm/xterm").Terminal;
let ImageAddon: typeof import("@xterm/addon-image").ImageAddon;
let KittyGraphicsAddon: typeof KittyAddonType;
beforeAll(async () => {
  ({ Terminal } = await import("@xterm/xterm"));
  ({ ImageAddon } = await import("@xterm/addon-image"));
  ({ KittyGraphicsAddon } = await import("./addon"));
});

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc32(body));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = new Uint8Array(height * (1 + width * 4)).fill(0xff);
  for (let row = 0; row < height; row += 1) rows[row * (1 + width * 4)] = 0;
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", header),
    ...chunk("IDAT", new Uint8Array(deflateSync(rows))),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const apc = (control: string, payload = "") => `\u001b_G${control}${payload === "" ? "" : `;${payload}`}\u001b\\`;

/** Kitty's own chunking: 4096 base64 bytes per command, `m=1` on all but the
 *  last, and only the first carrying the keys. */
function chunked(control: string, payload: string, size = 4096): string {
  const parts: string[] = [];
  for (let at = 0; at < payload.length; at += size) parts.push(payload.slice(at, at + size));
  return parts.map((part, i) => {
    const more = i < parts.length - 1 ? 1 : 0;
    return apc(i === 0 ? `${control},m=${more}` : `m=${more}`, part);
  }).join("");
}

const fakeBackend: KittyImageBackend = {
  decodePng: async (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  },
  fromPixels: (_bytes, width, height) => ({ width, height }),
  scale: (_image, width, height) => ({ width, height }),
};

function setup(cols = 20, rows = 8, backend: KittyImageBackend = fakeBackend) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  const images = new ImageAddon({ sixelSupport: true, iipSupport: true, enableSizeReports: false });
  term.loadAddon(images);
  term.loadAddon(new KittyGraphicsAddon(images, backend));
  const writes: string[] = [];
  const listeners: Array<(chunk: TerminalChunk) => void> = [];
  const bridge: Pick<TerminalBridge, "write" | "onData" | "onExit"> = {
    write: async (_id, data) => {
      writes.push(data);
      return { ok: true };
    },
    onData: (listener) => {
      listeners.push(listener);
      return () => {};
    },
    onExit: () => () => {},
  };
  attachTerminal(term, bridge, "t1");
  const send = async (...chunks: string[]) => {
    for (const data of chunks) listeners.forEach((listener) => listener({ id: "t1", data }));
    await new Promise<void>((resolve) => term.write("", () => resolve()));
  };
  /** Which cells of a rows × cols window the image store holds an image in. */
  const imageCells = (width = cols, height = rows): string[] => {
    const out: string[] = [];
    for (let y = 0; y < height; y += 1) {
      let line = "";
      for (let x = 0; x < width; x += 1) line += images.getImageAtBufferCell(x, y) ? "#" : ".";
      out.push(line);
    }
    return out;
  };
  const text = (y: number) => term.buffer.active.getLine(y)?.translateToString(true) ?? "";
  return { term, images, writes, send, imageCells, text };
}

describe("a transmitted image lands in the cells it declared", () => {
  test("a chunked PNG with c=4,r=2 fills exactly 4×2 cells at the cursor, and the cursor ends after it", async () => {
    const { term, send, imageCells } = setup();
    const payload = base64(png(4, 4));
    // Small chunks, so a 4×4 PNG still arrives in several `m=1` pieces.
    await send("ab", chunked("a=T,f=100,c=4,r=2", payload, 32));
    expect(imageCells(10, 4)).toEqual([
      "..####....",
      "..####....",
      "..........",
      "..........",
    ]);
    // Kitty leaves the cursor after the image's last column, on its last row.
    expect(term.buffer.active.cursorX).toBe(6);
    expect(term.buffer.active.cursorY).toBe(1);
  });

  test("raw RGB with no c/r is placed at its own pixel size", async () => {
    const { send, imageCells } = setup();
    // 8×20 px against addon-image's 7×14 fallback cell: 2 columns, 2 rows.
    const pixels = new Uint8Array(8 * 20 * 3).fill(0x80);
    await send(apc("a=T,f=24,s=8,v=20", base64(pixels)));
    expect(imageCells(4, 3)).toEqual(["##..", "##..", "...."]);
  });

  test("C=1 leaves the cursor where the image started", async () => {
    const { term, send, imageCells } = setup();
    await send("xyz", apc("a=T,f=100,c=3,r=3,C=1", base64(png(4, 4))));
    expect(imageCells(7, 4)).toEqual(["...###.", "...###.", "...###.", "......."]);
    expect(term.buffer.active.cursorX).toBe(3);
    expect(term.buffer.active.cursorY).toBe(0);
  });

  test("an introducer split across two PTY chunks still places the image", async () => {
    const { send, imageCells } = setup();
    const whole = apc("a=T,f=100,c=2,r=1", base64(png(4, 4)));
    await send(whole.slice(0, 1), whole.slice(1, 2), whole.slice(2));
    expect(imageCells(3, 1)).toEqual(["##."]);
  });

  test("a=t stores, a=p places later, and d=i takes it back off the screen", async () => {
    const { send, imageCells, writes } = setup();
    await send(apc("a=t,f=100,i=7", base64(png(4, 4))));
    expect(imageCells(3, 1)).toEqual(["..."]);
    await send(apc("a=p,i=7,c=2,r=1"));
    expect(imageCells(3, 1)).toEqual(["##."]);
    await send(apc("a=d,d=i,i=7"));
    expect(imageCells(3, 1)).toEqual(["..."]);
    expect(writes).toEqual(["\u001b_Gi=7;OK\u001b\\", "\u001b_Gi=7;OK\u001b\\"]);
  });

  test("d=a clears kitty images", async () => {
    const { send, imageCells } = setup();
    await send(apc("a=T,f=100,c=2,r=1", base64(png(4, 4))), "\r\n", apc("a=T,f=100,c=1,r=1", base64(png(4, 4))));
    expect(imageCells(3, 2)).toEqual(["##.", "#.."]);
    await send(apc("a=d,d=a"));
    expect(imageCells(3, 2)).toEqual(["...", "..."]);
  });
});

describe("a malformed chunk is dropped and the stream goes on", () => {
  test("bad base64 mid-transmission: no image, the text after it lands, and the next image still works", async () => {
    const { send, imageCells, text, writes } = setup();
    const payload = base64(png(4, 4));
    await send(
      apc("a=T,f=100,c=2,r=1,i=3,m=1", payload.slice(0, 16)),
      apc("m=1", "!!not base64!!"),
      apc("m=0", payload.slice(16)),
      "after",
    );
    expect(imageCells(8, 1)).toEqual(["........"]);
    expect(text(0)).toBe("after");
    expect(writes).toEqual(["\u001b_Gi=3;EINVAL:malformed payload\u001b\\"]);

    await send("\r\n", apc("a=T,f=100,c=2,r=1", payload));
    expect(imageCells(3, 2)).toEqual(["...", "##."]);
  });

  test("an unreadable control block is dropped without a reply or a stray character", async () => {
    const { send, imageCells, text, writes } = setup();
    await send("a", apc("a==T,,f", "AAAA"), "b");
    expect(text(0)).toBe("ab");
    expect(imageCells(4, 1)).toEqual(["...."]);
    expect(writes).toEqual([]);
  });

  test("RGB whose byte count does not match s×v is refused", async () => {
    const { send, imageCells, writes } = setup();
    await send(apc("a=T,f=24,s=2,v=2,i=9", base64(new Uint8Array(5))));
    expect(imageCells(3, 1)).toEqual(["..."]);
    expect(writes).toEqual(["\u001b_Gi=9;ENODATA:image data does not match its size\u001b\\"]);
  });

  test("without a host that can read files, file and shared-memory transmission are refused, not read", async () => {
    const { send, writes } = setup();
    await send(apc("a=T,f=100,t=f,i=4", btoa("/tmp/logo.png")), apc("a=T,f=100,t=s,i=5", btoa("/shm")));
    expect(writes).toEqual([
      "\u001b_Gi=4;EINVAL:unsupported transmission medium\u001b\\",
      "\u001b_Gi=5;EINVAL:unsupported transmission medium\u001b\\",
    ]);
  });
});

describe("file transmission (t=f) — what fastfetch's kitty-direct logo sends", () => {
  /** A host reader that records what it was asked for and answers as told. */
  function fileHost(answer: (path: string) => Promise<KittyFileAnswer>) {
    const asked: string[] = [];
    const backend: KittyImageBackend = {
      ...fakeBackend,
      readFile: async (path) => {
        asked.push(path);
        return answer(path);
      },
    };
    return { asked, backend };
  }
  const LOGO = "/Users/someone/.config/fastfetch/logo.png";

  test("fastfetch's exact sequence draws 4×2 cells, and nothing at all is written back into the PTY", async () => {
    const { asked, backend } = fileHost(async () => ({ ok: true, bytes: png(64, 64) }));
    const { term, send, imageCells, writes } = setup(20, 8, backend);
    // Byte for byte what fastfetch 2.68.1 `--logo-type kitty-direct` wrote,
    // followed by the layout it then relies on.
    await send(`\u001b[m\u001b_Ga=T,f=100,t=f,c=4,r=2;${btoa(LOGO)}\u001b\\\r\n\u001b[2A\u001b[8Cfacundo`);
    expect(asked).toEqual([LOGO]);
    expect(imageCells(10, 3)).toEqual(["####......", "####......", ".........."]);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("        facundo");
    expect(writes).toEqual([]);
  });

  test("with an id, the answer is OK and only OK — the file's bytes never reach the PTY", async () => {
    const { backend } = fileHost(async () => ({ ok: true, bytes: png(4, 4) }));
    const { send, writes } = setup(20, 8, backend);
    await send(apc("a=T,f=100,t=f,i=12,c=2,r=1", btoa(LOGO)));
    expect(writes).toEqual(["\u001b_Gi=12;OK\u001b\\"]);
  });

  test("each host refusal is answered with kitty's short code and a fixed sentence, never the path", async () => {
    for (const code of ["EINVAL", "ENOENT", "EPERM", "EFBIG", "EBADPNG", "EIO"]) {
      const { backend } = fileHost(async () => ({ ok: false, code }));
      const { send, writes, imageCells } = setup(20, 8, backend);
      await send(apc("a=T,f=100,t=f,i=1", btoa(LOGO)));
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(new RegExp(`^\\u001b_Gi=1;${code}:[a-zA-Z ]+\\u001b\\\\$`));
      expect(writes[0]).not.toContain("logo");
      expect(imageCells(3, 1)).toEqual(["..."]);
    }
  });

  test("a code the addon does not know — even one carrying a path — is answered as EIO, and so is a reader that throws", async () => {
    const odd = fileHost(async () => ({ ok: false, code: `ENOENT ${LOGO}` }));
    const first = setup(20, 8, odd.backend);
    await first.send(apc("a=T,f=100,t=f,i=1", btoa(LOGO)));
    expect(first.writes).toEqual(["\u001b_Gi=1;EIO:could not read file\u001b\\"]);

    const proto = fileHost(async () => ({ ok: false, code: "toString" }));
    const second = setup(20, 8, proto.backend);
    await second.send(apc("a=T,f=100,t=f,i=2", btoa(LOGO)));
    expect(second.writes).toEqual(["\u001b_Gi=2;EIO:could not read file\u001b\\"]);

    const throws = fileHost(async () => {
      throw new Error(`EACCES: permission denied, open '${LOGO}'`);
    });
    const third = setup(20, 8, throws.backend);
    await third.send(apc("a=T,f=100,t=f,i=3", btoa(LOGO)), "after");
    expect(third.writes).toEqual(["\u001b_Gi=3;EIO:could not read file\u001b\\"]);
    expect(third.text(0)).toBe("after");
  });

  test("bytes the host returned are still checked: a file that is not a PNG is refused here too", async () => {
    const { backend } = fileHost(async () => ({ ok: true, bytes: new TextEncoder().encode("plain text, not an image") }));
    const { send, writes } = setup(20, 8, backend);
    await send(apc("a=T,f=100,t=f,i=5", btoa(LOGO)));
    expect(writes).toEqual(["\u001b_Gi=5;EBADPNG:not a PNG\u001b\\"]);
  });

  test("t=f with raw pixels is refused without asking the host — file transmission is PNG only", async () => {
    const { asked, backend } = fileHost(async () => ({ ok: true, bytes: png(4, 4) }));
    const { send, writes } = setup(20, 8, backend);
    await send(apc("a=T,f=32,s=1,v=1,t=f,i=6", btoa(LOGO)), apc("a=T,t=f,i=7", btoa(LOGO)));
    expect(asked).toEqual([]);
    expect(writes).toEqual([
      "\u001b_Gi=6;EINVAL:file transmission is PNG only\u001b\\",
      "\u001b_Gi=7;EINVAL:file transmission is PNG only\u001b\\",
    ]);
  });

  test("temporary-file and shared-memory transmission stay refused even with a file reader", async () => {
    const { asked, backend } = fileHost(async () => ({ ok: true, bytes: png(4, 4) }));
    const { send, writes } = setup(20, 8, backend);
    await send(apc("a=T,f=100,t=t,i=8", btoa(LOGO)), apc("a=T,f=100,t=s,i=9", btoa("/shm")));
    expect(asked).toEqual([]);
    expect(writes).toEqual([
      "\u001b_Gi=8;EINVAL:unsupported transmission medium\u001b\\",
      "\u001b_Gi=9;EINVAL:unsupported transmission medium\u001b\\",
    ]);
  });
});

describe("the query is answered", () => {
  test("a=q gets OK back through the PTY, before the DA1 answer detection waits for", async () => {
    const { send, writes, imageCells } = setup();
    // The probe kitty's docs give for detection: a 1×1 RGB query, then DA1.
    await send(apc("i=31,s=1,v=1,a=q,t=d,f=24", "AAAA") + "\u001b[c");
    expect(writes[0]).toBe("\u001b_Gi=31;OK\u001b\\");
    expect(writes[1]).toMatch(/^\u001b\[\?/);
    // Checked, never shown.
    expect(imageCells(2, 1)).toEqual([".."]);
  });

  test("a query with bad data gets the error, and q=2 silences it", async () => {
    const { send, writes } = setup();
    await send(apc("i=1,a=q,f=100", base64(new Uint8Array([1, 2, 3, 4]))), apc("i=2,a=q,f=100,q=2", "AAAA"));
    expect(writes).toEqual(["\u001b_Gi=1;EBADPNG:not a PNG\u001b\\"]);
  });
});

describe("the parts the rest leans on", () => {
  test("only ESC _ G is rewritten, into the OSC the addon listens on", () => {
    const rewrite = kittyApcRewriter();
    expect(rewrite("a\u001b_Ga=q;AAAA\u001b\\b")).toBe(`a\u001b]${KITTY_GRAPHICS_OSC};Ga=q;AAAA\u001b\\b`);
    expect(rewrite("\u001b_Xother\u001b\\")).toBe("\u001b_Xother\u001b\\");
    expect(rewrite("x\u001b")).toBe("x");
    expect(rewrite("_")).toBe("");
    expect(rewrite("G;\u001b\\")).toBe(`\u001b]${KITTY_GRAPHICS_OSC};G;\u001b\\`);
  });

  test("the installed @xterm/addon-image still has the private store this addon draws through", () => {
    // If an upgrade moves these, the addon registers nothing and kitty goes
    // silent. This is where that is found out.
    const term = new Terminal({ cols: 10, rows: 4, allowProposedApi: true });
    const images = new ImageAddon();
    term.loadAddon(images);
    const internals = images as unknown as {
      _storage: { addImage: unknown; _lastId: unknown; _images: unknown; _delImg: unknown };
      _renderer: { cellSize: unknown };
    };
    expect(typeof internals._storage.addImage).toBe("function");
    expect(typeof internals._storage._delImg).toBe("function");
    expect(typeof internals._storage._lastId).toBe("number");
    expect(internals._storage._images).toBeInstanceOf(Map);
    expect(internals._renderer.cellSize).toEqual({ width: -1, height: -1 });
  });
});
