/**
 * THE KITTY GRAPHICS PROTOCOL, ON TOP OF @xterm/addon-image (#884).
 *
 * addon-image 0.9.0 speaks SIXEL and iTerm2's IIP. It already owns what an
 * image in a terminal needs: a store that writes image tiles into buffer cells,
 * evicts them as they scroll away, and a canvas layer that draws them. This
 * addon adds a third decoder in front of that store and nothing else — the
 * image reaches the screen through the same `addImage` the SIXEL and IIP
 * handlers call.
 *
 * WHAT IS SPOKEN: direct transmission (`t=d`) of PNG (`f=100`) and raw RGB /
 * RGBA (`f=24` / `f=32`), chunked with `m=1`; transmit (`a=t`), transmit and
 * display (`a=T`), display a stored image (`a=p`), delete (`a=d`, by `d=a`/`A`
 * and `d=i`/`I`), and the query (`a=q`), whose answer is what a program's
 * auto-detection reads. Placement sizes to `c` columns by `r` rows when asked.
 * Shared memory and file transmission are not spoken: they are answered with an
 * error, as kitty answers any medium it cannot use.
 *
 * THE STORE IS REACHED THROUGH THE ADDON'S PRIVATE FIELDS. The package exports
 * only `ImageAddon`; its `ImageStorage` is internal. The alternative was a copy
 * of the storage and renderer, which is a fork by another name. What is used is
 * small — `_storage.addImage`, `_storage._lastId`, `_storage._images`,
 * `_renderer.cellSize` — and checked at activation: if a future addon-image
 * moves any of it, this addon registers nothing, so no query is answered and
 * programs fall back to what they drew before. A test asserts the fields on the
 * installed version, so that day fails CI rather than a terminal.
 */
import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";
import type { ImageAddon } from "@xterm/addon-image";
import { KITTY_GRAPHICS_OSC } from "./apc";
import { charKey, decodeBase64, isPng, numberKey, parseKittyCommand, type KittyCommand } from "./command";

/** A decoded image, as the store takes it: a canvas or an ImageBitmap in the
 *  browser. Only its size is read here. */
export type KittyImage = { width: number; height: number };

/** Where pixels come from. The DOM one is the default; a test hands in its own,
 *  because a headless DOM has no 2D canvas and no `createImageBitmap`. */
export type KittyImageBackend = {
  decodePng: (bytes: Uint8Array) => Promise<KittyImage | undefined>;
  fromPixels: (bytes: Uint8Array, width: number, height: number, channels: 3 | 4) => KittyImage | undefined;
  scale: (image: KittyImage, width: number, height: number) => KittyImage | undefined;
};

type StoredSpec = { marker?: { dispose: () => void } };
type ImageInternals = {
  _storage?: {
    addImage: (image: KittyImage) => void;
    _lastId: number;
    _images: Map<number, StoredSpec>;
    _delImg?: (id: number) => void;
  };
  _renderer?: { cellSize: { width: number; height: number } };
};
type BufferLineInternals = { _extendedAttrs: Record<number, { imageId?: number; tileId?: number } | undefined> };
type TerminalInternals = {
  _core: {
    buffer: {
      x: number;
      y: number;
      ybase: number;
      lines: { length: number; get: (index: number) => BufferLineInternals | undefined };
    };
  };
};

/** addon-image's own fallback when no renderer has measured a cell yet. It is
 *  not exported, and placement has to size against the same number the store
 *  divides by, or `c=4` lands as five columns. */
const CELL_SIZE_DEFAULT = { width: 7, height: 14 };
/** addon-image's default `pixelLimit`: 4096 × 4096. */
const PIXEL_LIMIT = 4096 * 4096;
/** The base64 of one RGBA image at that limit. A transmission past it is
 *  refused before it is decoded. */
const TRANSMISSION_LIMIT = Math.ceil((PIXEL_LIMIT * 4 * 4) / 3);
/** Transmitted-but-not-shown images kept for `a=p`, oldest dropped first. */
const STORED_LIMIT = 64;

type Pending = { command: KittyCommand; chunks: string[]; size: number };

export const domImageBackend: KittyImageBackend = {
  decodePng: async (bytes) => {
    try {
      return await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" }));
    } catch {
      return undefined;
    }
  },
  fromPixels: (bytes, width, height, channels) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const data = context.createImageData(width, height);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      data.data[pixel * 4] = bytes[pixel * channels];
      data.data[pixel * 4 + 1] = bytes[pixel * channels + 1];
      data.data[pixel * 4 + 2] = bytes[pixel * channels + 2];
      data.data[pixel * 4 + 3] = channels === 4 ? bytes[pixel * 4 + 3] : 255;
    }
    context.putImageData(data, 0, 0);
    return canvas;
  },
  scale: (image, width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(image as CanvasImageSource, 0, 0, width, height);
    return canvas;
  },
};

export class KittyGraphicsAddon implements ITerminalAddon {
  private term: Terminal | undefined;
  private disposables: IDisposable[] = [];
  private pending: Pending | undefined;
  private readonly stored = new Map<number, KittyImage>();
  /** Kitty image id → the store's ids for its placements, for `d=i`. */
  private readonly placements = new Map<number, Set<number>>();
  /** Every store id this addon placed, for `d=a` — which must not wipe a
   *  SIXEL or IIP image sharing the screen. */
  private readonly placed = new Set<number>();

  constructor(
    private readonly images: ImageAddon,
    private readonly backend: KittyImageBackend = domImageBackend,
  ) {}

  /** Load after the ImageAddon: its store exists only once it has activated. */
  activate(term: Terminal): void {
    const internals = this.images as unknown as ImageInternals;
    if (typeof internals._storage?.addImage !== "function" || !(internals._storage._images instanceof Map) || !internals._renderer) return;
    this.term = term;
    this.disposables.push(
      term.parser.registerOscHandler(KITTY_GRAPHICS_OSC, (data) => this.handle(data)),
      // RIS forgets every image, as kitty does. `false` lets xterm and
      // addon-image run their own reset too.
      term.parser.registerEscHandler({ final: "c" }, () => {
        this.forget();
        return false;
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.forget();
    this.term = undefined;
  }

  private forget(): void {
    this.pending = undefined;
    this.stored.clear();
    this.placements.clear();
    this.placed.clear();
  }

  private handle(data: string): boolean | Promise<boolean> {
    const command = parseKittyCommand(data);
    if (!command) {
      // Unreadable, so there is no id to answer. Dropped; the stream goes on.
      this.pending = undefined;
      return true;
    }
    if (this.pending) {
      const continuation = [...command.keys.keys()].every((key) => key === "m" || key === "q");
      if (continuation) return this.continueTransmission(command);
      // A new command before the last chunk: the unfinished image is dropped.
      this.pending = undefined;
    }
    const action = charKey(command, "a", "t");
    switch (action) {
      case "t":
      case "T":
      case "q":
        return this.startTransmission(command);
      case "p":
        return this.placeStored(command);
      case "d":
        this.delete(command);
        return true;
      default:
        this.reply(command, "EINVAL:unsupported action");
        return true;
    }
  }

  private startTransmission(command: KittyCommand): boolean | Promise<boolean> {
    if (charKey(command, "t", "d") !== "d") {
      this.reply(command, "EINVAL:unsupported transmission medium");
      return true;
    }
    if (![24, 32, 100].includes(numberKey(command, "f", 32))) {
      this.reply(command, "EINVAL:unsupported format");
      return true;
    }
    if (command.keys.has("o")) {
      this.reply(command, "EINVAL:unsupported compression");
      return true;
    }
    this.pending = { command, chunks: [command.payload], size: command.payload.length };
    return numberKey(command, "m") === 1 ? true : this.finishTransmission();
  }

  private continueTransmission(chunk: KittyCommand): boolean | Promise<boolean> {
    const pending = this.pending!;
    pending.chunks.push(chunk.payload);
    pending.size += chunk.payload.length;
    if (pending.size > TRANSMISSION_LIMIT) {
      this.pending = undefined;
      this.reply(pending.command, "EFBIG:image too large");
      return true;
    }
    return numberKey(chunk, "m") === 1 ? true : this.finishTransmission();
  }

  private finishTransmission(): boolean | Promise<boolean> {
    const { command, chunks } = this.pending!;
    this.pending = undefined;
    const bytes = decodeBase64(chunks.join(""));
    if (!bytes) {
      this.reply(command, "EINVAL:malformed payload");
      return true;
    }
    const format = numberKey(command, "f", 32);
    const channels = format === 24 ? 3 : 4;
    const refusal = format === 100 ? (isPng(bytes) ? undefined : "EBADPNG:not a PNG") : this.rawRefusal(command, bytes, channels);
    if (refusal) {
      this.reply(command, refusal);
      return true;
    }
    if (charKey(command, "a", "t") === "q") {
      // Checked, never kept: that is what distinguishes the query.
      this.reply(command, "OK");
      return true;
    }
    if (format !== 100) {
      return this.accept(command, this.backend.fromPixels(bytes, numberKey(command, "s"), numberKey(command, "v"), channels));
    }
    return this.backend.decodePng(bytes).then((image) => this.accept(command, image));
  }

  private rawRefusal(command: KittyCommand, bytes: Uint8Array, channels: 3 | 4): string | undefined {
    const width = numberKey(command, "s");
    const height = numberKey(command, "v");
    if (width <= 0 || height <= 0) return "EINVAL:width and height are required";
    if (width * height > PIXEL_LIMIT) return "EFBIG:image too large";
    if (bytes.length !== width * height * channels) return "ENODATA:image data does not match its size";
    return undefined;
  }

  private accept(command: KittyCommand, image: KittyImage | undefined): boolean {
    if (!image || image.width <= 0 || image.height <= 0) {
      this.reply(command, "EBADPNG:could not decode");
      return true;
    }
    if (image.width * image.height > PIXEL_LIMIT) {
      this.reply(command, "EFBIG:image too large");
      return true;
    }
    const id = numberKey(command, "i");
    if (id > 0) this.store(id, image);
    if (charKey(command, "a", "t") === "T" && !this.place(command, id, image)) {
      this.reply(command, "EINVAL:could not place");
      return true;
    }
    this.reply(command, "OK");
    return true;
  }

  private store(id: number, image: KittyImage): void {
    this.stored.delete(id);
    this.stored.set(id, image);
    if (this.stored.size > STORED_LIMIT) this.stored.delete(this.stored.keys().next().value!);
  }

  private placeStored(command: KittyCommand): boolean {
    const id = numberKey(command, "i");
    const image = this.stored.get(id);
    if (!image) {
      this.reply(command, "ENOENT:no such image");
      return true;
    }
    this.reply(command, this.place(command, id, image) ? "OK" : "EINVAL:could not place");
    return true;
  }

  /**
   * At the cursor, `c` × `r` cells when asked — one of them alone keeps the
   * aspect ratio — else at the image's own pixel size. The cursor then sits
   * after the image's last column on its last row, which is where kitty leaves
   * it and what fastfetch's layout counts on; `C=1` leaves it where it was.
   */
  private place(command: KittyCommand, id: number, image: KittyImage): boolean {
    const { _storage: storage } = this.images as unknown as ImageInternals;
    const term = this.term;
    if (!storage || !term) return false;
    const cell = this.cellSize();
    const cols = numberKey(command, "c");
    const rows = numberKey(command, "r");
    let width = image.width;
    let height = image.height;
    // FLOORED: the store takes ceil(width / cell), so a float cell width
    // rounded up would spill the image into one more column than asked.
    if (cols > 0) width = Math.max(1, Math.floor(cols * cell.width));
    if (rows > 0) height = Math.max(1, Math.floor(rows * cell.height));
    if (cols > 0 && rows <= 0) height = Math.max(1, Math.round((image.height * width) / image.width));
    if (rows > 0 && cols <= 0) width = Math.max(1, Math.round((image.width * height) / image.height));
    const sized = width === image.width && height === image.height ? image : this.backend.scale(image, width, height);
    if (!sized) return false;

    const buffer = (term as unknown as TerminalInternals)._core.buffer;
    const originX = buffer.x;
    const originRow = buffer.ybase + buffer.y;
    storage.addImage(sized);
    const storeId = storage._lastId;
    this.placed.add(storeId);
    if (id > 0) {
      const ids = this.placements.get(id) ?? new Set<number>();
      ids.add(storeId);
      this.placements.set(id, ids);
    }
    if (numberKey(command, "C") === 1) {
      buffer.x = originX;
      buffer.y = Math.max(0, originRow - buffer.ybase);
    } else {
      buffer.x = Math.min(originX + Math.ceil(sized.width / cell.width), term.cols);
    }
    return true;
  }

  /** `d=a`/`d=i` take the images off the screen; the capital forms also free
   *  what was stored for `a=p`. Other selectors are not spoken and change
   *  nothing — kitty sends no answer to a delete either way. */
  private delete(command: KittyCommand): void {
    const which = charKey(command, "d", "a");
    if (which === "a" || which === "A") {
      this.clear(new Set(this.placed));
      this.placements.clear();
      if (which === "A") this.stored.clear();
      return;
    }
    if (which === "i" || which === "I") {
      const id = numberKey(command, "i");
      this.clear(this.placements.get(id) ?? new Set());
      this.placements.delete(id);
      if (which === "I") this.stored.delete(id);
    }
  }

  /** Blank every cell showing one of these images, then drop them from the
   *  store. Dropping alone is not enough: the store draws a placeholder in a
   *  cell whose image has gone. */
  private clear(storeIds: Set<number>): void {
    const { _storage: storage } = this.images as unknown as ImageInternals;
    const term = this.term;
    if (!storage || !term || storeIds.size === 0) return;
    const lines = (term as unknown as TerminalInternals)._core.buffer.lines;
    for (let row = 0; row < lines.length; row += 1) {
      const attrs = lines.get(row)?._extendedAttrs;
      if (!attrs) continue;
      for (const attr of Object.values(attrs)) {
        if (attr?.imageId !== undefined && storeIds.has(attr.imageId)) {
          attr.imageId = -1;
          attr.tileId = -1;
        }
      }
    }
    for (const storeId of storeIds) {
      storage._images.get(storeId)?.marker?.dispose();
      storage._delImg?.(storeId);
      this.placed.delete(storeId);
    }
    term.refresh(0, term.rows - 1);
  }

  private cellSize(): { width: number; height: number } {
    const measured = (this.images as unknown as ImageInternals)._renderer?.cellSize;
    return measured && measured.width > 0 && measured.height > 0 ? measured : CELL_SIZE_DEFAULT;
  }

  /**
   * `ESC _ G i=<id> ; <message> ESC \`, into the PTY as if typed. Only a
   * command that carried an id is answered, as the protocol says; `q=1` keeps
   * the OKs quiet and `q=2` the errors too.
   */
  private reply(command: KittyCommand, message: string): void {
    const id = numberKey(command, "i");
    const quiet = numberKey(command, "q");
    if (id <= 0 || !this.term) return;
    if (message === "OK" ? quiet >= 1 : quiet >= 2) return;
    this.term.input(`\u001b_Gi=${id};${message}\u001b\\`, false);
  }
}
