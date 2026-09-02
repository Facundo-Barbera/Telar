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
 * DECLARED — client, machine, os. Whatever is pairing says these about
 * itself. They are the useful ones ("Facundo's iPhone", "telar-cli 0.4") and
 * they are also entirely under the caller's control, so they are bounded,
 * stripped of control characters, and never interpreted — only shown.
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

/** Coarse kind, open enough for clients that do not exist yet. `unknown` is a
 *  real answer: a caller that declined to say should not be guessed at. */
export const DEVICE_KINDS = ["browser", "phone", "tablet", "desktop", "cli", "service", "unknown"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

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
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const stripped = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return stripped.length === 0 ? undefined : stripped.slice(0, limit);
}

export function isDeviceKind(value: unknown): value is DeviceKind {
  return typeof value === "string" && (DEVICE_KINDS as readonly string[]).includes(value);
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
export function sniffUserAgent(header: string | null | undefined): { kind: DeviceKind; client?: string; os?: string } {
  const ua = typeof header === "string" ? header.slice(0, 400) : "";
  if (ua.length === 0) return { kind: "unknown" };

  const client =
    /\bEdg\//.test(ua) ? "Edge"
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

  const kind: DeviceKind = /\biPhone\b|\bAndroid\b.*\bMobile\b/.test(ua)
    ? "phone"
    : /\biPad\b|\bTablet\b/.test(ua)
      ? "tablet"
      : client
        ? "browser"
        : "unknown";

  return { kind, ...(client ? { client } : {}), ...(os ? { os } : {}) };
}

/**
 * The row's title. Prefers what the client called itself, falls back to what
 * it appears to be, and never returns an empty string — a device with no name
 * at all is still a device someone has to recognise and revoke.
 */
export function describeDevice(identity: DeviceIdentity, declaredName?: string): string {
  const name = cleanDeclared(declaredName);
  if (name) return name;
  const parts = [identity.client, identity.machine ?? identity.os].filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.join(" · ");
  return identity.kind === "unknown" ? "Unknown device" : identity.kind[0]!.toUpperCase() + identity.kind.slice(1);
}
