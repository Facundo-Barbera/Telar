const { ipcRenderer } = require("electron");

const REPORT_EVERY_MS = 40;
let lastReport = 0;

function report() {
  const now = Date.now();
  if (now - lastReport < REPORT_EVERY_MS) return;
  lastReport = now;
  try {
    ipcRenderer.send("telar:browser:human-input");
  } catch {
  }
}

for (const type of ["pointerdown", "keydown", "wheel"]) {
  window.addEventListener(type, report, { capture: true, passive: true });
}

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
  }
}
window.addEventListener(
  "input",
  (event) => { if (isLoginField(event.target) && event.target.value) reportLoginEntry(event.isTrusted && event.inputType ? "input" : "fill"); },
  { capture: true, passive: true },
);
