import { DEEPGRAM_LISTEN_URL, askListen, type ListenAnswer } from "./listen";
import { DictationError, NO_KEY_CONFIGURED, deepgramSaid, scrub } from "./token";

// A client's WebSocket error carries no reason, so the engine asks Deepgram after a failure.
export const DIAGNOSE_DEADLINE_MS = 6_000;

export type DictationDiagnosis = {
  fault: "refused" | "unreachable" | "elsewhere" | "unconfigured";
  reason: string;
};

// Deepgram's edge refuses an oversized request line with plain HTML, before reading the credential.
const EDGE_HTML = /<html/i;

export async function diagnoseDictation(input: {
  key: string | undefined;
  language: string;
  keyterms: readonly string[];
  fetchImpl?: typeof fetch;
  url?: string;
  signal?: AbortSignal;
}): Promise<DictationDiagnosis> {
  const key = input.key?.trim();
  if (!key) throw new DictationError("unconfigured", NO_KEY_CONFIGURED);

  const answer = await askListen({
    key,
    language: input.language,
    keyterms: input.keyterms,
    fetchImpl: input.fetchImpl ?? fetch,
    url: input.url ?? DEEPGRAM_LISTEN_URL,
    signal: input.signal ?? AbortSignal.timeout(DIAGNOSE_DEADLINE_MS),
  });

  const read = diagnosis(answer);
  return { ...read, reason: scrub(read.reason, key) };
}

function diagnosis(answer: ListenAnswer): DictationDiagnosis {
  if (answer.accepted) {
    return {
      fault: "elsewhere",
      reason:
        "Deepgram accepted a connection from this computer just now, with the same settings — so the service is reachable and this computer's key is good. The dictation failed somewhere between the device that was listening and Deepgram: a network on the way, or something in front of it that does not pass WebSocket connections.",
    };
  }

  if (answer.status === 0) {
    return {
      fault: "unreachable",
      reason: `This computer could not reach Deepgram at all${answer.unreachable ? `: ${answer.unreachable}` : "."} Check that it is online, then try again.`,
    };
  }

  const words = deepgramSaid(answer.body);
  if (words) return { fault: "refused", reason: `Deepgram refused the transcription connection: HTTP ${answer.status} — ${words}` };

  if (EDGE_HTML.test(answer.body)) {
    return {
      fault: "refused",
      reason: `Deepgram's edge refused the request before reading the credential (HTTP ${answer.status}) — the query was too long. That is the glossary: it is bounded on this computer, so this is worth reporting.`,
    };
  }

  return { fault: "refused", reason: `Deepgram refused the transcription connection with HTTP ${answer.status} and said nothing about why.` };
}
