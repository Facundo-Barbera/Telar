import { activeComposerToken } from "@/lib/composer-registry";

export type DictationControl = {
  toggle: () => void;
};

const mounted = new Map<string, DictationControl>();

/** Register while dictation is available on this composer; returns the unregister. */
export function registerDictation(token: string, control: DictationControl): () => void {
  mounted.set(token, control);
  return () => {
    // A re-register under the same token runs the old cleanup after the new
    // entry is in, so only delete if it is still this control.
    if (mounted.get(token) === control) mounted.delete(token);
  };
}

export function activeDictation(): DictationControl | undefined {
  const token = activeComposerToken();
  return token === undefined ? undefined : mounted.get(token);
}

export function toggleActiveDictation(): void {
  activeDictation()?.toggle();
}
