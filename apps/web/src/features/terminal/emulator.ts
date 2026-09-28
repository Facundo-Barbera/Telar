import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon, type IImageAddonOptions } from "@xterm/addon-image";
import { WebglAddon } from "@xterm/addon-webgl";
import { createEngineApi } from "@/platform/engine";
import type { TerminalBridge } from "./bridge";
import { domImageBackend, KittyGraphicsAddon } from "./kitty/addon";
import { terminalKeyHandler } from "./session";
import { terminalTheme, type CssVarReader } from "./theme";

const api = createEngineApi();

// The addon implements SIXEL and IIP only; kitty graphics is our own KittyGraphicsAddon.
// IIP (what fastfetch's logo uses) is the addon's alpha-quality protocol: suspect it first.
export const TERMINAL_IMAGE_OPTIONS: IImageAddonOptions = {
  sixelSupport: true,
  iipSupport: true,
  // CSI 14/16/18 t: a program cannot scale an image to the grid without the cell size in pixels.
  enableSizeReports: true,
};

const SCROLLBACK = 5000;

/** One per attempt: xterm cannot re-open a disposed terminal, and a refused cwd disposes before showing. */
export function createEmulator(
  element: HTMLElement,
  bridge: TerminalBridge,
  look: { read: CssVarReader; fontFamily: string; fontSize: number },
  events: { onTitle: (title: string) => void; write: (bytes: string) => void },
): { term: Terminal; fit: FitAddon; cleanups: Array<() => void> } {
  const term = new Terminal({
    allowProposedApi: true,
    theme: terminalTheme(look.read),
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
    scrollback: SCROLLBACK,
    cursorBlink: true,
    macOptionIsMeta: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const images = new ImageAddon(TERMINAL_IMAGE_OPTIONS);
  term.loadAddon(images);
  // After the image addon: kitty images draw through its store. `readFile` exists only on the local host.
  const readFile = bridge.readImageFile?.bind(bridge);
  term.loadAddon(new KittyGraphicsAddon(images, { ...domImageBackend, readFile }));
  term.open(element);
  // WebGL is optional: on no context, or a lost one, xterm falls back to its DOM renderer.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // No GL here.
  }
  const cleanups = [term.onTitleChange(events.onTitle).dispose];
  term.attachCustomKeyEventHandler(terminalKeyHandler(events.write));
  return { term, fit, cleanups };
}

/** The session's checkout, else the project's root. Failing to answer means the shell's own default. */
export async function startingDirectory(sessionId?: string, projectId?: string): Promise<string | undefined> {
  try {
    if (sessionId) return (await api.sessionFiles(sessionId)).listing.workspacePath;
    if (projectId) return (await api.projectFiles(projectId)).listing.workspacePath;
  } catch {
    // The engine is away or the checkout is unavailable.
  }
  return undefined;
}
