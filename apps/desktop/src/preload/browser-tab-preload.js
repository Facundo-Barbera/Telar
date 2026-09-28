/**
 * Runs inside every integrated-browser tab (sandboxed, isolated) with ONE job:
 * tell the shell a human's hands landed on this page. pointerdown/keydown/
 * wheel in the capture phase is the earliest, least-fakeable place to hear it;
 * WHO it actually was (agent-synthesized CDP input raises the same DOM events)
 * is decided in the main process by temporal attribution — see
 * the interaction model in browser-manager.js. Throttled because a scroll
 * emits hundreds of wheels and one report per burst is enough.
 */
const { ipcRenderer } = require("electron");

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
 * A LOGIN ENTRY — a value landing in a password, one-time-code or username
 * field, whether typed, pasted, or filled by a password manager's inline
 * suggestion (which never touches the toolbar). Only the FACT is reported,
 * never a value, and the ONLY thing it drives is the login offer — "may agents
 * use this login here?" (login-offer.js). It pauses nothing: no browser tool in
 * any session is gated, delayed or refused by what this reports.
 */
const LOGIN_FIELDS = 'input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[autocomplete="one-time-code"], input[autocomplete="username"]';
function isLoginField(target) {
  return target instanceof HTMLInputElement && target.matches(LOGIN_FIELDS);
}
let lastLoginReport = 0;
function reportLoginEntry(kind) {
  const now = Date.now();
  if (now - lastLoginReport < 500) return;
  lastLoginReport = now;
  try {
    ipcRenderer.send("telar:browser:login-entry", { kind });
  } catch {
    // Torn-down frame; a missed offer is not worth an error in the page.
  }
}
window.addEventListener(
  "input",
  (event) => { if (isLoginField(event.target) && event.target.value) reportLoginEntry(event.isTrusted && event.inputType ? "input" : "fill"); },
  { capture: true, passive: true },
);
