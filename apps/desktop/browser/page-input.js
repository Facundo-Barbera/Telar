const CHORD_MODIFIERS = {
  control: "control", ctrl: "control",
  meta: "meta", cmd: "meta", command: "meta",
  alt: "alt", option: "alt",
  shift: "shift",
};
const ELECTRON_KEY_NAMES = {
  arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right",
  escape: "Escape", esc: "Escape", enter: "Enter", return: "Return", space: "Space", " ": "Space",
};

function keyChord(key, platform = process.platform) {
  const spec = String(key ?? "");
  if (!spec) throw new Error("A key is required.");
  let rest;
  let name;
  if (spec === "+") [rest, name] = ["", "+"];
  else if (spec.endsWith("++")) [rest, name] = [spec.slice(0, -2), "+"];
  else {
    const cut = spec.lastIndexOf("+");
    [rest, name] = cut < 0 ? ["", spec] : [spec.slice(0, cut), spec.slice(cut + 1)];
  }
  if (!name) throw new Error(`${spec} names no key after its modifiers. Write a chord like Control+A.`);
  const modifiers = [];
  for (const token of rest ? rest.split("+") : []) {
    const lower = token.trim().toLowerCase();
    const modifier = lower === "controlormeta" ? (platform === "darwin" ? "meta" : "control") : CHORD_MODIFIERS[lower];
    if (!modifier) throw new Error(`Unknown modifier ${token || "(empty)"} in ${spec}. Use Control, Meta, Alt, Shift or ControlOrMeta.`);
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return { keyCode: ELECTRON_KEY_NAMES[name.toLowerCase()] || name, modifiers };
}

const PAGE_DESCRIBE = `
  function describe(el) {
    const attr = (name) => (el.getAttribute && el.getAttribute(name)) || "";
    const role = attr("role") || String(el.tagName || "").toLowerCase();
    const name = attr("aria-label") || attr("title") || attr("alt") || attr("placeholder") || String(el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60);
    return { role, name };
  }`;
const PAGE_FOCUS = `${PAGE_DESCRIBE}
  function deepestFocus() {
    let el = document.activeElement;
    for (;;) {
      if (el && el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
      let inner = null;
      try { inner = el && el.contentDocument ? el.contentDocument.activeElement : null; } catch (e) { inner = null; }
      if (inner) { el = inner; continue; }
      return el;
    }
  }
  function isEditable(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return !["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color", "hidden"].includes(String(el.type || "text").toLowerCase());
    return Boolean(el.isContentEditable);
  }`;
const PAGE_AT_POINT = `function (x, y) {${PAGE_DESCRIBE}
  let el = document.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el ? describe(el) : null;
}`;
const PAGE_FOCUSED_EDITABLE = `function () {${PAGE_FOCUS}
  const el = deepestFocus();
  return isEditable(el) ? describe(el) : null;
}`;

const PAGE_PASTE = `function (text) {${PAGE_FOCUS}
  const el = deepestFocus();
  const target = el || document.body || document.documentElement;
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const handled = !target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
  return { handled, editable: isEditable(el) ? describe(el) : null };
}`;

const PAGE_COPY = `function () {${PAGE_FOCUS}
  const el = deepestFocus();
  const target = el || document.body || document.documentElement;
  const data = new DataTransfer();
  const handled = !target.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
  const written = data.getData("text/plain") || data.getData("text/html");
  if (handled && written) return written;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && typeof el.selectionStart === "number") {
    return String(el.value || "").slice(el.selectionStart, el.selectionEnd);
  }
  const doc = (el && el.ownerDocument) || document;
  return doc.getSelection ? String(doc.getSelection()) : "";
}`;
const COPY_MAX_BYTES = 16 * 1024;

function pageLabel(described) {
  return described.name ? `${described.role} "${described.name}"` : described.role;
}

function pointText(point) {
  return `(${point.x}, ${point.y})`;
}

function capCopied(text) {
  if (Buffer.byteLength(text) <= COPY_MAX_BYTES) return text;

  const cut = Buffer.from(text).subarray(0, COPY_MAX_BYTES).toString("utf8").replace(/�$/, "");
  return `${cut}\n… [truncated]`;
}

module.exports = { keyChord, PAGE_AT_POINT, PAGE_FOCUSED_EDITABLE, PAGE_PASTE, PAGE_COPY, pageLabel, pointText, capCopied };
