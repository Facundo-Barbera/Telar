import path from "node:path";
import type { DictationLanguage, DictationProviderId, Project, Session } from "@telar/engine-client";
import { EngineStateError } from "../../platform/kernel";
import { dictationCredential, readDictationKey, writeDictationKey } from "./credentials";
import { lastKeytermFit, type KeytermFit } from "./fit";
import type { DictationContext } from "./keyterms";
import { dictationLanguages, isDictationLanguage, isDictationProviderId } from "./provider";
import { cleanDictationVocabulary, readDictationSettings, writeDictationSettings } from "./settings";

export type DictationHost = {
  /** The rail's own unsettled list, so the recogniser is primed with exactly the rows a person can see. */
  liveSessions(): Pick<Session, "title" | "workspace">[];
  /** The raw registry: `listProjects` probes every checkout for a branch and an icon, and this wants a name. */
  projects(): Project[];
};

export type DictationState = {
  provider: DictationProviderId;
  configured: boolean;
  language: string;
  languages: readonly DictationLanguage[];
  vocabulary: string[];
  keyterms?: KeytermFit;
};

/** The settings and the 0600 write-only key under `<engineRoot>/dictation`. */
export class Dictation {
  private readonly dir: string;

  constructor(
    engineRoot: string,
    private readonly host: DictationHost,
  ) {
    this.dir = path.join(engineRoot, "dictation");
  }

  credential(): { configured: boolean } {
    return dictationCredential(this.dir);
  }

  /** `configured` is answered even when the provider is off: switching off does not throw a pasted key away. */
  state(): DictationState {
    const fit = lastKeytermFit();
    return {
      ...readDictationSettings(this.dir),
      ...this.credential(),
      languages: dictationLanguages(),
      ...(fit ? { keyterms: fit } : {}),
    };
  }

  setProvider(provider: unknown): void {
    if (!isDictationProviderId(provider)) throw new EngineStateError("invalid_request", "that is not a dictation provider this engine knows");
    writeDictationSettings(this.dir, { ...readDictationSettings(this.dir), provider });
  }

  /** Refused by name: stored, an unsupported code would surface only as a failed handshake. */
  setLanguage(language: unknown): void {
    if (!isDictationLanguage(language)) {
      throw new EngineStateError("invalid_request", "that is not a language this engine's transcription provider can transcribe");
    }
    writeDictationSettings(this.dir, { ...readDictationSettings(this.dir), language });
  }

  /** Tidied rather than refused: a blank line in a list of words is a person pressing return. */
  setVocabulary(vocabulary: unknown): void {
    if (!Array.isArray(vocabulary)) throw new EngineStateError("invalid_request", "the dictation vocabulary must be a list of terms");
    writeDictationSettings(this.dir, { ...readDictationSettings(this.dir), vocabulary: cleanDictationVocabulary(vocabulary) });
  }

  /** Session titles, live project names and worktree branches; a `local` session's branch belongs to the project. */
  context(): DictationContext {
    const sessions = this.host.liveSessions();
    return {
      sessionTitles: sessions.flatMap((session) => (session.title ? [session.title] : [])),
      projectNames: this.host.projects().flatMap((project) => (project.removedAt === undefined ? [project.name] : [])),
      branches: sessions.flatMap((session) => (session.workspace.mode === "worktree" ? [session.workspace.branch] : [])),
    };
  }

  /** Stores the pasted key, or clears it with an empty string. */
  setKey(key: unknown): { configured: boolean } {
    if (typeof key !== "string") throw new EngineStateError("invalid_request", "the dictation key must be text");
    if (key.length > 4096) throw new EngineStateError("invalid_request", "that key is too long");
    writeDictationKey(this.dir, key);
    return this.credential();
  }

  /** Read at call time for the token mint only; never returned to a client, logged or cached. */
  key(): string | undefined {
    return readDictationKey(this.dir);
  }
}
