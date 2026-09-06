/**
 * Runs inside every integrated-browser tab (sandboxed, isolated) with ONE job:
 * tell the shell a human's hands landed on this page. pointerdown/keydown/
 * wheel in the capture phase is the earliest, least-fakeable place to hear it;
 * WHO it actually was (agent-synthesized CDP input raises the same DOM events)
 * is decided in the main process by temporal attribution — see
 * the interaction model in browser-manager.js. Throttled because a scroll
 * emits hundreds of wheels and one report per burst is enough.
 */
const { contextBridge, ipcRenderer } = require("electron");

// Short: the main process counts the agent's own echoes against what it
// dispatched, and a dropped echo would leave an expectation that could
// swallow a real hand. One report per event burst is still all it needs.
const REPORT_EVERY_MS = 40;
let lastReport = 0;

function report() {
  const now = Date.now();
  if (now - lastReport < REPORT_EVERY_MS) return;
  lastReport = now;
  try {
    ipcRenderer.send("telar:browser:human-input");
  } catch {
    // A torn-down frame mid-navigation must not surface as a page error.
  }
}

for (const type of ["pointerdown", "keydown", "wheel"]) {
  window.addEventListener(type, report, { capture: true, passive: true });
}

/**
 * CREDENTIAL FIELDS. A password, one-time-code or username field getting
 * focus, or a value landing in one (typed, pasted, or filled by a password
 * manager's inline suggestion — which never touches the toolbar), is a
 * private interaction. Only the FACT is reported, never a value.
 */
const PROTECTED = 'input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[autocomplete="one-time-code"], input[autocomplete="username"]';
/** What BLOCKS a resume while non-empty: a password, or a field whose
 *  autocomplete token says it holds a password or one-time code even when
 *  its type is text (a "show password" toggle, an OTP box). A username alone
 *  does not block. */
const BLOCKING = 'input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[autocomplete="one-time-code"]';
function isProtected(target) {
  return target instanceof HTMLInputElement && target.matches(PROTECTED);
}
let lastCredentialReport = 0;
function reportCredential(kind) {
  const now = Date.now();
  if (now - lastCredentialReport < 500) return;
  lastCredentialReport = now;
  try {
    ipcRenderer.send("telar:browser:credential-field", { kind });
  } catch {
    // Torn-down frame; nothing to protect.
  }
}
window.addEventListener("focusin", (event) => { if (isProtected(event.target)) reportCredential("focus"); }, { capture: true, passive: true });
window.addEventListener("input", (event) => { if (isProtected(event.target) && event.target.value) reportCredential(event.isTrusted && event.inputType ? "input" : "fill"); }, { capture: true, passive: true });

/** Asked by the main process to decide whether a credential interaction is
 *  still ACTIVE in THIS frame — for the automatic release lifecycle. Active
 *  means EITHER a blocking field (password/current-password/new-password/
 *  one-time-code) is non-empty, OR one is FOCUSED even while empty (the human
 *  is about to type). A focused-but-empty username does not count. Answers a
 *  boolean only; field values are never read out of this function. Runs in
 *  every frame; the main process asks each and any "true" — or any frame that
 *  cannot answer — keeps the interaction private. */
contextBridge.executeInMainWorld?.({
  func: (selector) => {
    const entryActive = () => {
      const fields = [...document.querySelectorAll(selector)];
      if (fields.some((el) => el instanceof HTMLInputElement && el.value.length > 0)) return true;
      const active = document.activeElement;
      return active instanceof HTMLInputElement && active.matches(selector);
    };
    Object.defineProperty(globalThis, "__telarCredentialEntryActive", {
      value: entryActive, configurable: false, writable: false, enumerable: false,
    });
    // Back-compat name kept for any caller that only asks "is a field filled".
    Object.defineProperty(globalThis, "__telarProtectedFieldsFilled", {
      value: () => [...document.querySelectorAll(selector)].some((el) => el instanceof HTMLInputElement && el.value.length > 0),
      configurable: false, writable: false, enumerable: false,
    });
  },
  args: [BLOCKING],
});
