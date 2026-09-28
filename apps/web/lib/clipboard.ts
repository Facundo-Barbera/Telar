// `navigator.clipboard` exists only in a secure context, so over plain HTTP (e.g. a
// tailnet address) it is filled in with an execCommand("copy") shim that works in a gesture.

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
