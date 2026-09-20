/**
 * ONE WEBSOCKET UPGRADE, BY HAND, SO THE REFUSAL CAN BE READ (#707, #712).
 *
 * A browser's `WebSocket` error event carries no reason — deliberately, because
 * it would be a cross-origin oracle. Deepgram DOES send one: it refuses the
 * upgrade with an ordinary HTTP status and a JSON body, and every WebSocket
 * client on every surface throws both away. This opens the socket over a raw TLS
 * connection instead, and hands back the status line and the body.
 *
 * IT LIVES IN ITS OWN FILE BECAUSE TWO PROBES NEED IT — `probe-deepgram-listen`
 * asks what Deepgram says when it refuses, and `probe-deepgram-keyterm-bound`
 * asks where exactly the keyterm boundary is. A second copy of a function that
 * handles a credential is how one of them quietly stops scrubbing.
 *
 * ── IT NEEDS A KEY, AND IT NEVER PRINTS ONE ────────────────────────────────
 * The key is read from `DEEPGRAM_API_KEY` — an environment variable a script is
 * TOLD, never a credentials file it goes looking for, so running one cannot
 * quietly spend a key somebody did not mean to spend. It goes into one
 * `Authorization` header on the wire and nowhere else: not into the query, not
 * into a return value, not into an error path (the transport's own error is
 * swallowed rather than echoed, for that reason alone). THE URL IS NEVER
 * RETURNED EITHER, on the principle that a URL is the thing a credential leaks
 * into — only the request line's LENGTH, which is its own limit's unit.
 */

const HOST = "api.deepgram.com";
const PATH = "/v1/listen";

/** What one upgrade answered. No URL, no credential — see the header. */
export type Handshake = {
  /** The status line with `HTTP/1.1 ` stripped, or `(no answer)`. */
  status: string;
  /** Deepgram's body, verbatim and untrimmed of meaning: the caller decides
   *  what counts as which refusal, because that rule is the thing under test. */
  body: string;
  /** The request line's length, which is the OTHER limit's unit — Deepgram's
   *  edge answers a plain-HTML 400 once this passes a few kilobytes. */
  requestLineBytes: number;
};

/** The key, once, from the environment. Exits rather than running keyless: a
 *  probe that silently measured nothing would be worse than one that stops. */
export function requireKey(): string {
  const key = process.env.DEEPGRAM_API_KEY?.trim();
  if (!key) {
    console.error("Set DEEPGRAM_API_KEY in the environment. It is never printed.");
    process.exit(2);
  }
  return key;
}

/** The same query `listenUrl` builds, minus the credential (which is a header). */
export function listenQuery(input: { language: string; keyterms: readonly string[]; model?: string }): URLSearchParams {
  const parameters = new URLSearchParams();
  parameters.set("model", input.model ?? "nova-3");
  parameters.set("interim_results", "true");
  parameters.set("smart_format", "true");
  parameters.set("language", input.language);
  parameters.set("endpointing", "300");
  for (const term of input.keyterms) parameters.append("keyterm", term);
  return parameters;
}

/** One handshake. Returns the status and the body Deepgram sends with a refusal
 *  — which is the whole point, and the thing a browser discards. */
export async function handshake(parameters: URLSearchParams, key: string): Promise<Handshake> {
  const target = `${PATH}?${parameters.toString()}`;
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const request = [
    `GET ${target} HTTP/1.1`,
    `Host: ${HOST}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${nonce}`,
    "Sec-WebSocket-Version: 13",
    `Authorization: Token ${key}`,
    "",
    "",
  ].join("\r\n");

  let received = "";
  const done = Promise.withResolvers<void>();
  const settle = setTimeout(() => done.resolve(), 10_000);

  let socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  try {
    socket = await Bun.connect({
      hostname: HOST,
      port: 443,
      tls: true,
      socket: {
        open: (s) => void s.write(request),
        data: (_s, chunk) => {
          received += new TextDecoder().decode(chunk);
          if (received.includes("\r\n\r\n")) setTimeout(() => done.resolve(), 200);
        },
        close: () => done.resolve(),
        // NO CAUSE IS RETURNED HERE. A transport error message is not a place a
        // credential ends up, but this module's rule is that nothing from the
        // request side is ever echoed.
        error: () => done.resolve(),
      },
    });
    await done.promise;
  } finally {
    clearTimeout(settle);
    try {
      socket?.end();
    } catch {
      // Already closed.
    }
  }

  const [head = "", ...rest] = received.split("\r\n\r\n");
  return {
    status: head.split("\r\n")[0]?.replace("HTTP/1.1 ", "").trim() || "(no answer)",
    body: rest.join("\r\n\r\n").trim(),
    requestLineBytes: `GET ${target} HTTP/1.1`.length,
  };
}

/** Deepgram's own sentence when the body carries one, bounded. */
export function said(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { err_code?: string; err_msg?: string };
    if (parsed.err_msg) return `${parsed.err_code ?? "?"}: ${parsed.err_msg}`;
  } catch {
    // Not JSON — an edge refusal is HTML, and that is itself the finding.
  }
  return body.slice(0, 200).replace(/\s+/g, " ");
}
