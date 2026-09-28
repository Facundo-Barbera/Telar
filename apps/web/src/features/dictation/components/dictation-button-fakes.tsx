import { afterEach, beforeAll, beforeEach } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Composer } from "@/features/composer";
import { resolveWebCommandKeyAction, keymapSnapshot, restoreDefaultKeymap, runCommand } from "@/features/commands";
import { installPageApi } from "@/features/composer/page-api";

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

export let live: FakeSocket | undefined;
export let sent: unknown[] = [];
export let tracks: FakeTrack[] = [];
export let tokenCalls = 0;

export const knobs = {
  provider: "deepgram" as "off" | "deepgram",
  language: "multi",
  keyterms: ["Telar", "Zarigüeya"] as string[] | undefined,
  caretAt: { x: 120, y: 400 },
  secure: true,
};

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  readonly frames: unknown[] = [];
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {}
  send(data: unknown) {
    this.frames.push(data);
    sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    act(() => this.onopen?.());
  }
  say(frame: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(frame) }));
  }
}

class FakeRecorder {
  static isTypeSupported = (type: string) => type.startsWith("audio/webm");
  state = "inactive";
  ondataavailable?: (event: { data: { size: number } }) => void;
  constructor(
    readonly stream: unknown,
    readonly options?: { mimeType?: string },
  ) {}
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
  }
}

export const results = (transcript: string, isFinal: boolean) => ({
  type: "Results",
  is_final: isFinal,
  channel: { alternatives: [{ transcript }] },
});

function installBrowserFakes(): void {
  live = undefined;
  sent = [];
  tracks = [];
  tokenCalls = 0;
  Object.assign(knobs, { provider: "deepgram", language: "multi", keyterms: ["Telar", "Zarigüeya"], caretAt: { x: 120, y: 400 }, secure: true });
  // happy-dom has no `isSecureContext` at all, which reads as insecure.
  Object.defineProperty(window, "isSecureContext", { configurable: true, get: () => knobs.secure });
  restoreDefaultKeymap();
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  });
  // A real collapsed caret is one line high; `caretRectIn` treats zero height as no layout.
  Range.prototype.getBoundingClientRect = function () {
    return new DOMRect(knobs.caretAt.x, knobs.caretAt.y, 0, 18);
  };
  const media = globalThis as unknown as Record<string, unknown>;
  media.MediaRecorder = FakeRecorder;
  const open = function (url: string, protocols?: string | string[]) {
    live = new FakeSocket(url, protocols);
    return live;
  };
  // The hook compares `readyState` against `WebSocket.OPEN` before every send.
  open.OPEN = FakeSocket.OPEN;
  media.WebSocket = open;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        tracks.push(new FakeTrack());
        return { getTracks: () => tracks };
      },
    },
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("/api/dictation/token")) {
      tokenCalls += 1;
      return Response.json({ provider: "deepgram", token: "jwt-abc", expiresAt: Date.now() + 300_000, language: knobs.language, keyterms: knobs.keyterms });
    }
    if (url.includes("/api/dictation")) return Response.json({ dictation: { provider: knobs.provider, configured: knobs.provider !== "off" } });
    return Response.json({});
  }) as typeof fetch;
}

export const roots: { root: Root; host: HTMLElement }[] = [];

/** Call once at the top of a test file, after registering the DOM. */
export function installDictationFakes(): void {
  beforeEach(installBrowserFakes);
  afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
      act(() => root.unmount());
      host.remove();
    }
  });
  beforeAll(() => {
    installPageApi();
  });
}

export function Box({ kind }: { kind: "session" }) {
  const [draft, setDraft] = useState("");
  return (
    <>
      <p data-testid="draft">{draft}</p>
      <Composer
        draft={draft}
        kind={kind}
        ready
        attachments={[]}
        onAttach={() => {}}
        busy={false}
        sending={false}
        backgroundTasks={0}
        onDraftChange={setDraft}
        onSubmit={() => {}}
        onStop={() => {}}
        onStopBackground={() => {}}
        onRuntimeMode={() => {}}
      />
    </>
  );
}

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  roots.push({ root, host });
  return host;
}

/** Mount and wait a macrotask for the provider setting; the button is absent until it lands. */
export async function mounted(node: React.ReactNode): Promise<HTMLElement> {
  const host = mount(node);
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
  return host;
}

export const micIn = (host: HTMLElement): HTMLButtonElement => {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Dictate"], button[aria-label="Stop dictating"]');
  if (!button) throw new Error("no mic button rendered");
  return button;
};

export const draftOf = (host: HTMLElement): string => host.querySelector('[data-testid="draft"]')?.textContent ?? "";

export async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

/** ⌘D as `useCommandKeys` dispatches it; answers whether any command was bound. */
export async function chord(target?: unknown): Promise<boolean> {
  let ran = false;
  await act(async () => {
    const id = resolveWebCommandKeyAction(keymapSnapshot(), { metaKey: true, key: "d", code: "KeyD", target });
    ran = id ? runCommand(id) : false;
    await new Promise((settle) => setTimeout(settle, 0));
  });
  return ran;
}

export const unavailableMicIn = (host: HTMLElement): HTMLButtonElement => {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Dictation unavailable here"]');
  if (!button) throw new Error("no unavailable mic button rendered");
  return button;
};

export const noticeTextIn = (host: HTMLElement): string => host.querySelector('[data-slot="dictation-notice"]')?.textContent ?? "";

export const pill = (): HTMLElement | null => document.querySelector('[data-slot="dictation-caret-pill"]');
export const dimmed = (): HTMLElement | null => document.querySelector("[data-dictation-interim]");

/** Put a caret at the end of the editor, the way its own `placeCaret` does. */
export function focusBox(host: HTMLElement): void {
  const editable = host.querySelector<HTMLElement>('[data-slot="composer-editor"]');
  if (!editable) throw new Error("no composer editor rendered");
  act(() => {
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}
