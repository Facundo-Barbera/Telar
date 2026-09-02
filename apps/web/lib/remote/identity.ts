/**
 * WHAT A PAIRED THING SAYS ABOUT ITSELF, AND WHAT WE OBSERVE ANYWAY.
 *
 * The device list read "Browser, Browser, Browser" because the only identity a
 * pairing carried was a hardcoded name and a two-value platform enum whose
 * values were `ios` and `browser`. That enum was the deeper mistake: the
 * clients that pair with a cockpit are not all browsers and were never going
 * to be — a phone app, a CLI, a script, another Telar — and a closed set of
 * two forced every one of them to lie or say nothing.
 *
 * TWO KINDS OF FACT, KEPT APART ON PURPOSE.
 *
 * DECLARED — kind, client, machine, os. Whatever is pairing says these about
 * itself. They are the useful ones ("Facundo's iPhone", "telar-cli 0.4") and
 * they are also entirely under the caller's control, so they are bounded,
 * stripped of control characters, and never interpreted — only shown. None of
 * them is a closed set, for the reason above: the first list of seven kinds
 * had no room for the client somebody was actually running.
 *
 * OBSERVED — address, origin. Taken from the request by the server. A client
 * cannot claim to have connected from somewhere it did not, which is what
 * makes these the ones worth trusting when two rows look alike. They are the
 * answer to "which of these three is the laptop on the tailnet?".
 *
 * A browser cannot be asked to fill in the declared fields — it has no idea
 * what it is beyond a User-Agent string — so the server derives a coarse
 * fallback from that header, and ONLY when the caller said nothing. A native
 * client that declares itself is always believed over a sniffed string.
 */

/**
 * THE KIND IS A SLUG, NOT AN ENUM.
 *
 * It was a closed union of seven, which is the same mistake as the two-value
 * platform enum one size up: a client named Lintel is not a browser, a phone,
 * or a "service", and forcing it to pick the least-wrong member throws away
 * the one fact the row existed to show. So a client declares whatever slug it
 * likes and we show it.
 *
 * The known list survives for ONE job — picking an icon. An unrecognised kind
 * gets the fallback glyph and its own name in the row, which is strictly more
 * informative than a familiar icon over a lie.
 */
export const KNOWN_DEVICE_KINDS = [
  "browser",
  "phone",
  "tablet",
  "desktop",
  "cli",
  "service",
  "unknown",
] as const;
export type KnownDeviceKind = (typeof KNOWN_DEVICE_KINDS)[number];

/** Any slug a client cares to declare. `unknown` is a real answer: a caller
 *  that declined to say should not be guessed at. */
export type DeviceKind = string;

export interface DeviceIdentity {
  kind: DeviceKind;
  /** Declared. The product doing the pairing — "Firefox", "Telar for iOS". */
  client?: string;
  /** Declared. The machine it runs on — a hostname, a phone's name. */
  machine?: string;
  /** Declared. Operating system and version, as the client words it. */
  os?: string;
  /** Observed. The peer address the pairing request arrived from. */
  address?: string;
  /** Observed. The origin it paired against — which matters because pairing is
   *  per-origin, so this is how a reader tells a loopback pairing from a
   *  tailnet one for the same physical machine. */
  origin?: string;
}

/** Declared strings are shown in a settings row and nothing else, so the only
 *  rules are: no control characters, and short enough not to wreck the row. */
export function cleanDeclared(value: unknown, limit = 64): string | undefined {
  if (typeof value !== "string") return undefined;
  const stripped = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return stripped.length === 0 ? undefined : stripped.slice(0, limit);
}

/**
 * A declared kind, reduced to a slug. Lowercased and punctuation-collapsed so
 * "Lintel", "lintel" and "Lintel Desktop" key the same icon lookup and read
 * the same in a row, and bounded because it is caller-controlled like the
 * rest of the declared fields.
 */
export function cleanKind(value: unknown): DeviceKind | undefined {
  if (typeof value !== "string") return undefined;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? undefined : slug.slice(0, 32);
}

export function isKnownDeviceKind(value: unknown): value is KnownDeviceKind {
  return (
    typeof value === "string" &&
    (KNOWN_DEVICE_KINDS as readonly string[]).includes(value)
  );
}

/** A slug as a person reads it: "lintel" → "Lintel", "smart-tv" → "Smart Tv".
 *  `unknown` has no label — it is the absence of one. */
export function kindLabel(kind: DeviceKind | undefined): string | undefined {
  if (!kind || kind === "unknown") return undefined;
  return kind
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * A COARSE GUESS FROM A USER-AGENT, used only where nothing was declared.
 *
 * Deliberately shallow. Full UA parsing is a library and a maintenance
 * treadmill, and the question here is only "what should this row say so a
 * person recognises their own device" — for which the browser family and the
 * platform are enough. Order matters: Edge and Chrome both claim Safari, and
 * Chromium browsers all claim Chrome.
 */
export function sniffUserAgent(header: string | null | undefined): {
  kind: DeviceKind;
  client?: string;
  os?: string;
} {
  const ua = typeof header === "string" ? header.slice(0, 400) : "";
  if (ua.length === 0) return { kind: "unknown" };

  // AN APP SHELL IS NOT A BROWSER, even though it ships one and says "Chrome"
  // in its UA. Electron puts the product's own token immediately before that
  // claim, so the row can say "Telar" instead of miscounting the desktop app
  // as a fourth tab of Chrome.
  const embedded = /\bElectron\//.test(ua)
    ? /([A-Za-z][A-Za-z0-9._-]*)\/[\d.]+\s+Chrome\//.exec(ua)?.[1]
    : undefined;

  const client =
    embedded ? embedded
    : /\bElectron\//.test(ua) ? "Electron"
    : /\bEdg\//.test(ua) ? "Edge"
    : /\bOPR\//.test(ua) ? "Opera"
    : /\bFirefox\//.test(ua) ? "Firefox"
    : /\bChrome\//.test(ua) ? "Chrome"
    : /\bSafari\//.test(ua) ? "Safari"
    : undefined;

  const os =
    /\biPhone\b/.test(ua) ? "iOS"
    : /\biPad\b/.test(ua) ? "iPadOS"
    : /\bAndroid\b/.test(ua) ? "Android"
    : /\bMac OS X\b/.test(ua) ? "macOS"
    : /\bWindows NT\b/.test(ua) ? "Windows"
    : /\bLinux\b/.test(ua) ? "Linux"
    : undefined;

  const kind: DeviceKind =
    /\bElectron\//.test(ua) ? "desktop"
    : /\biPhone\b|\bAndroid\b.*\bMobile\b/.test(ua) ? "phone"
    : /\biPad\b|\bTablet\b/.test(ua) ? "tablet"
    : client ? "browser"
    : "unknown";

  return { kind, ...(client ? { client } : {}), ...(os ? { os } : {}) };
}

/**
 * The row's title: WHAT it is, then WHERE it runs — "Lintel · mini-fbarbera".
 *
 * The two halves answer the two questions a person actually has in front of
 * this list, and the second is the one the old list never answered: four rows
 * reading "Browser" are not four browsers, they are one laptop and a phone and
 * two tabs, and only the machine tells them apart.
 *
 * The kind stands in for a client that did not name itself, so a declared
 * `kind: "lintel"` still reads "Lintel" rather than being demoted to the
 * hostname alone. Never returns an empty string — a device with no name at all
 * is still one somebody has to recognise and revoke.
 */
export function describeDevice(
  identity: DeviceIdentity,
  declaredName?: string,
): string {
  const name = cleanDeclared(declaredName);
  if (name) return name;
  const what = identity.client ?? kindLabel(identity.kind);
  const where = identity.machine ?? identity.os;
  const parts = [what, where].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "Unknown device";
}
