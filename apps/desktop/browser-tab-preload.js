/**
 * Runs inside every integrated-browser tab (sandboxed, isolated) with ONE job:
 * tell the shell a human's hands landed on this page. pointerdown/keydown/
 * wheel in the capture phase is the earliest, least-fakeable place to hear it;
 * WHO it actually was (agent-synthesized CDP input raises the same DOM events)
 * is decided in the main process by temporal attribution — see
 * HUMAN_ATTRIBUTION_GRACE_MS in browser-manager.js. Throttled because one
 * takeover only needs one report, and a scroll emits hundreds of wheels.
 */
const { ipcRenderer } = require("electron");

const REPORT_EVERY_MS = 250;
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
