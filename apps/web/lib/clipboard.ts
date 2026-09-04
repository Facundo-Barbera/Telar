/**
 * COPY BUTTONS ON AN ORIGIN THE BROWSER DOES NOT CALL SECURE.
 *
 * `navigator.clipboard` exists only in a secure context — HTTPS, or a loopback
 * host. The cockpit is served over plain HTTP the moment it is bound to a
 * tailnet address so another machine can reach it, and there every copy
 * button in the app went quiet: ours (components/settings/copy-command.tsx,
 * the Spool's MCP command) and the ones we do not own (Streamdown's code-block
 * and link-dialog copies), which check for `navigator.clipboard.writeText` and
 * report "Clipboard API not available" to nobody.
 *
 * `document.execCommand("copy")` carries no such restriction — it only needs
 * to run inside a user gesture, which a copy button is. So rather than teach
 * every call site a second path, the missing API is FILLED IN ONCE, before any
 * button can be clicked: a `writeText` that stages the text in an off-screen
 * textarea, selects it, and copies. Call sites — including third-party ones —
 * keep calling the standard API and it works.
 *
 * Nothing is replaced when the real API is there: this is a shim for its
 * absence, not a wrapper around its presence.
 */

function copyViaSelection(text: string): boolean {
  const stage = document.createElement("textarea");
  stage.value = text;
  stage.setAttribute("readonly", "");
  stage.style.position = "fixed";
  stage.style.top = "0";
  stage.style.left = "0";
  stage.style.opacity = "0";
  stage.style.pointerEvents = "none";
  document.body.appendChild(stage);
  const previous = document.activeElement as HTMLElement | null;
  stage.select();
  stage.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    stage.remove();
    previous?.focus?.();
  }
  return copied;
}

/** Idempotent; safe to call on every mount. Returns whether a shim was installed. */
export function installClipboardShim(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") return false;
  const writeText = (text: string): Promise<void> =>
    copyViaSelection(text) ? Promise.resolve() : Promise.reject(new Error("Copy was refused by the browser."));
  if (navigator.clipboard) {
    Object.defineProperty(navigator.clipboard, "writeText", { value: writeText, configurable: true });
  } else {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  }
  return true;
}
