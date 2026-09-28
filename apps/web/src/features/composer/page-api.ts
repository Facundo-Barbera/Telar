
import { activeComposer, type ComposerKind } from "./registry";

type DictateResult =
  | {
      ok: true;
      draft: string;
      submitted?: boolean;
      reason?: string;
    }
  | { ok: false; reason: string };

type SubmitResult = { ok: true } | { ok: false; reason: string };

type ComposerReport = {
  id: string;
  kind: ComposerKind;
  draft: string;
  focused: boolean;
};

export type TelarPageApi = {
  dictate: (text: string, opts?: { submit?: boolean }) => DictateResult;
  submit: () => SubmitResult;
  composer: () => ComposerReport | null;
};

const NO_COMPOSER = "No message box is on screen to type into.";

function dictate(text: string, opts?: { submit?: boolean }): DictateResult {
  if (text.length === 0) return { ok: false, reason: "There was no text to insert." };
  const composer = activeComposer();
  if (!composer) return { ok: false, reason: NO_COMPOSER };

  const inserted = composer.insert(text);
  if (!inserted.ok) return inserted;
  if (!opts?.submit) return { ok: true, draft: inserted.draft };

  const sent = composer.submit();
  return sent.ok
    ? { ok: true, draft: inserted.draft, submitted: true }
    : { ok: true, draft: inserted.draft, submitted: false, reason: sent.reason };
}

function submit(): SubmitResult {
  const composer = activeComposer();
  if (!composer) return { ok: false, reason: NO_COMPOSER };
  return composer.submit();
}

function composer(): ComposerReport | null {
  const found = activeComposer();
  if (!found) return null;
  return { id: found.id, kind: found.kind, draft: found.draft(), focused: found.focused() };
}

type PageApiWindow = typeof window & { telar?: TelarPageApi };

let installed = false;

export function installPageApi(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  (window as PageApiWindow).telar = Object.freeze({ dictate, submit, composer });
}
