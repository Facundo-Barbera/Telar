/**
 * A browser fixture for the REAL `FileViewSurface` with the Wrap lines toggle.
 *
 * The component, its overlay editor, its gutter and the wrap preference are
 * all production; only the engine transport is stubbed, by answering the file
 * read/write routes from memory. The panel width is adjustable so the narrow
 * case — the one the user's screenshot showed overflowing — can be seen.
 *
 * The verdict strip reads the DRAFT out of the live textarea: wrapping must
 * never change what would be saved, so the character count and the absence of
 * any inserted newline are checked from the DOM rather than asserted.
 */
import { createElement as h, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileViewSurface } from "../../components/session/file-view-surface";

const LONG_PROSE = [
  "# Release notes",
  "",
  "This paragraph is deliberately one very long line of ordinary prose so that the horizontal overflow the user reported in the screenshot is reproducible: it keeps going well past any sensible panel width, and with wrapping off it must scroll sideways rather than fold.",
  "",
  "Short line.",
  "",
  "A second long one follows, because a single wrapped line proves nothing about whether the line beneath it lands where the gutter and the caret expect it to when several lines wrap in a row and the panel is narrow.",
  "",
  "supercalifragilisticexpialidocious-".repeat(12),
  "",
  "- a list item that is also quite long, to check that the wrapped continuation lines up under the first row rather than under the bullet",
  "\ttabbed line, to check that leading whitespace survives a wrap",
  "",
  "Last line.",
].join("\n");

const PLAIN_TEXT = [
  "plain text file, no markdown toolbar buttons, but the Wrap control is still offered because this is prose",
  "",
  "another_extremely_long_unbroken_token_" + "x".repeat(300),
  "",
  "end",
].join("\n");

const CODE = [
  "export function example(alpha: string, beta: string, gamma: string, delta: string, epsilon: string): string {",
  "  return [alpha, beta, gamma, delta, epsilon].join(' — a deliberately long line so code still scrolls sideways');",
  "}",
].join("\n");

const FILES: Record<string, string> = { "notes.md": LONG_PROSE, "notes.txt": PLAIN_TEXT, "example.ts": CODE };
const saved: Record<string, string> = { ...FILES };

/**
 * The two file routes, answered from memory ON THE PRODUCTION CONTRACT:
 * `WorkspaceFile` carries a real sha256, and a write answers
 * `WorkspaceWriteResult` — `{written:true,file}` or `{written:false,refusal}`.
 * The saver only creates a coordinator once it has a baseline hash, so a fake
 * `revision` field silently disabled saving altogether.
 */
const realFetch = window.fetch.bind(window);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const writes: string[] = [];

async function workspaceFile(path: string) {
  const text = saved[path] ?? "";
  return { path, text, bytes: new TextEncoder().encode(text).length, sha256: await sha256(text), binary: false, truncated: false };
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const match = /\/files\?(.*)$/.exec(url);
  if (!match) return realFetch(input as RequestInfo, init);
  const path = new URLSearchParams(match[1]!).get("path") ?? "";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  if (method === "GET") return json({ file: await workspaceFile(path) });

  // PUT — the precondition is real: a stale hash is REFUSED, exactly as the
  // engine refuses when disk moved under the editor.
  const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; expectedSha256?: string };
  const onDisk = await sha256(saved[path] ?? "");
  if (body.expectedSha256 !== onDisk) {
    return json({ written: false, refusal: "conflict", sha256: onDisk });
  }
  saved[path] = body.text ?? "";
  writes.push(`${path}:${saved[path]!.length}B`);
  return json({ written: true, file: await workspaceFile(path) });
}) as typeof window.fetch;

const PATHS = ["notes.md", "notes.txt", "example.ts"];
const WIDTHS = [360, 520, 760, 1040];

function Harness() {
  const [path, setPath] = useState("notes.md");
  const [width, setWidth] = useState(520);

  const button = (label: string, on: boolean, act: () => void) =>
    h(
      "button",
      {
        key: label,
        onClick: act,
        className: `rounded-md border px-2 py-1 text-xs ${on ? "border-primary bg-accent" : "border-border hover:bg-accent"}`,
      },
      label,
    );

  const check = () => {
    const box = document.querySelector<HTMLTextAreaElement>("textarea[aria-label]");
    const pre = document.querySelector<HTMLPreElement>("pre[data-shiki]");
    if (!box || !pre) return "no editor yet";
    // What is ON DISK in the stub, not what the DOM shows — a save that never
    // fired would otherwise read as success.
    const onDisk = saved[path] ?? "";
    const original = FILES[path] ?? "";
    const sameText = box.value === onDisk;
    const sameNewlines = box.value.split("\n").length === onDisk.split("\n").length;
    // The two layers must lay text out identically, or the caret drifts.
    const boxStyle = getComputedStyle(box);
    const preStyle = getComputedStyle(pre);
    const sameWhitespace = boxStyle.whiteSpace === preStyle.whiteSpace;
    const sameWrap = boxStyle.overflowWrap === preStyle.overflowWrap;
    const sameFont = boxStyle.fontSize === preStyle.fontSize && boxStyle.lineHeight === preStyle.lineHeight;
    const overflowing = pre.scrollWidth > pre.clientWidth + 1;
    return [
      `editor matches disk: ${sameText}`,
      `newlines editor/disk/original: ${box.value.split("\n").length}/${onDisk.split("\n").length}/${original.split("\n").length} (same: ${sameNewlines})`,
      `saves acknowledged: ${writes.length ? writes.join(", ") : "none"}`,
      `disk bytes: ${new TextEncoder().encode(onDisk).length}`,
      `layers agree — whitespace ${boxStyle.whiteSpace}/${preStyle.whiteSpace}: ${sameWhitespace}`,
      `layers agree — overflow-wrap: ${sameWrap}`,
      `layers agree — font/line-height: ${sameFont}`,
      `horizontal overflow: ${overflowing}`,
    ].join(" · ");
  };

  const [verdict, setVerdict] = useState("press Check");

  return h(
    "div",
    { className: "flex min-h-screen flex-col gap-3 bg-background p-6 text-foreground" },
    h("h1", { className: "text-base font-semibold" }, "Editor wrap fixture — real FileViewSurface, stubbed file transport"),
    h("div", { className: "flex flex-wrap gap-2" }, ...PATHS.map((entry) => button(entry, entry === path, () => setPath(entry)))),
    h(
      "div",
      { className: "flex flex-wrap items-center gap-2" },
      ...WIDTHS.map((entry) => button(`${entry}px`, entry === width, () => setWidth(entry))),
      button("Check", false, () => setVerdict(check())),
    ),
    h(
      "div",
      { className: "rounded-lg border border-border", style: { width, height: 460 } },
      h(FileViewSurface, { key: path, path, sessionId: "session_1" }),
    ),
    h("div", { id: "verdict", className: "max-w-4xl font-mono text-2xs text-muted-foreground" }, verdict),
  );
}

createRoot(document.getElementById("root")!).render(h(StrictMode, null, h(Harness)));
