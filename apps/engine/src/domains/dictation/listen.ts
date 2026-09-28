export const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";

// Must match the model the clients open (apps/web/src/features/dictation/deepgram.ts, iOS Dictation.swift):
// a tokenizer belongs to a model, so an answer about another model is about a different request.
const LISTEN_MODEL = "nova-3";

// `status` is 0 when nothing came back at all; `body` is empty for an accepted upgrade.
export type ListenAnswer = {
  status: number;
  body: string;
  accepted: boolean;
  unreachable?: string;
};

const MAX_BODY = 600;

// Asks whether this exact query would open a listen socket. Never throws.
export async function askListen(input: {
  key: string;
  language: string;
  keyterms: readonly string[];
  fetchImpl: typeof fetch;
  url: string;
  signal: AbortSignal;
}): Promise<ListenAnswer> {
  const url = new URL(input.url);
  url.searchParams.set("model", LISTEN_MODEL);
  url.searchParams.set("language", input.language);
  for (const term of input.keyterms) url.searchParams.append("keyterm", term);

  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      headers: {
        Authorization: `Token ${input.key}`,
        // Without the upgrade headers Deepgram refuses before reading the query (measured, #712).
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
        "Sec-WebSocket-Version": "13",
      },
      signal: input.signal,
    });
  } catch (cause) {
    return { status: 0, body: "", accepted: false, unreachable: cause instanceof Error ? cause.message : String(cause) };
  }

  const accepted = response.status === 101 || response.ok;
  return { status: response.status, body: await release(response, accepted), accepted };
}

// An accepted upgrade is a live socket, so its body is cancelled rather than read.
async function release(response: Response, accepted: boolean): Promise<string> {
  try {
    if (accepted) {
      await response.body?.cancel();
      return "";
    }
    return (await response.text()).slice(0, MAX_BODY);
  } catch {
    return "";
  }
}
