"use client";

/**
 * DICTATION — speak into any message box on this Mac (#544).
 *
 * ── WHY THIS IS ONE ROW AND NOT A PANE ──────────────────────────────────────
 * There is exactly one decision to make: which account pays for the
 * transcription. Everything else about dictation is a button on a composer, and
 * a settings pane for a feature whose whole interface is one button would be
 * chrome. If a second provider arrives, the row above this one becomes a picker
 * and the key row stays exactly as it is — which is why the engine's answer
 * carries `provider` rather than assuming Deepgram everywhere.
 *
 * ── THE FIELD NEVER SHOWS A STORED KEY ──────────────────────────────────────
 * It shows WHETHER one is there, which is what the Agent's key row does and
 * what every provider login on the Providers pane does, for the same reason: a
 * field that displayed a secret would be one screen-share away from leaking it.
 * Typing a new one replaces it; the button beside it removes it.
 *
 * ── AND IT SAYS WHAT THE KEY IS ACTUALLY SPENT ON ───────────────────────────
 * The long-lived key never leaves this Mac. What the browser and the phone get
 * is a token that expires in five minutes and can only reach the voice APIs —
 * that is the whole reason the engine is in this loop at all, and it is worth a
 * sentence, because "paste your API key into a web app" is a thing a careful
 * person is right to hesitate over.
 *
 * SAVE-PER-INTERACTION, AND THE ENGINE'S ANSWER IS THE STATE — the two rules
 * every settings pane here follows. A refused write leaves the controls showing
 * what is stored and says why underneath.
 */

import { useState } from "react";
import { KeyRoundIcon, MicIcon } from "lucide-react";
import { useDictationSettings } from "@/lib/dictation/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, SettingsGroup } from "./settings-shell";

export function DictationSection() {
  const { configured, loading, save, error } = useDictationSettings();
  const [key, setKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);

  async function saveKey(value: string): Promise<void> {
    setKeySaved(false);
    // AN EMPTY STRING IS AN EXPLICIT CLEAR, the same departure the Agent's key
    // row makes from the provider registry's "blank never clears". There,
    // blank is indistinguishable from "I did not retype it" on a shared form;
    // here this field is the only writer of the secret and Remove has to mean
    // it.
    await save({ apiKey: value.trim() });
    setKey("");
    if (value.trim()) setKeySaved(true);
  }

  return (
    <SettingsGroup
      title="Dictation"
      description="Speak into any message box — the mic button on the composer, here and on the phone. The audio goes from the device straight to the transcription service; it does not pass through this Mac."
    >
      <Row
        label="Deepgram key"
        icon={KeyRoundIcon}
        // THE ROW'S OWN STATE, beside the label rather than in the field: the
        // field says whether a key is there by its placeholder, and this is
        // the word a reader scanning the pane sees without reading the hint.
        {...(configured ? { status: "set" } : {})}
        {...(error ? { error } : {})}
        hint={
          configured
            ? "Stored with this Mac’s engine state and never shown again. It stays here: each dictation spends it once for a token that expires in five minutes, and that token is what the browser or the phone gets."
            : "Without one, the mic button says so and nothing is recorded. Create a key at console.deepgram.com — it needs no more than the default permissions."
        }
        control={
          <div className="flex items-center gap-2">
            <Input
              type="password"
              className="h-8 w-56 font-mono text-xs"
              aria-label="Deepgram key"
              // NEVER THE STORED KEY — the engine answers whether there is one
              // and nothing else, by design.
              placeholder={configured ? "A key is saved" : "Paste a Deepgram API key"}
              value={key}
              disabled={loading}
              onChange={(event) => {
                setKeySaved(false);
                setKey(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && key.trim()) void saveKey(key);
              }}
            />
            {configured && !key.trim() ? (
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => void saveKey("")}>
                Remove
              </Button>
            ) : (
              <Button size="sm" disabled={loading || !key.trim()} onClick={() => void saveKey(key)}>
                Save
              </Button>
            )}
          </div>
        }
      >
        {keySaved && <p className="mt-2 text-xs text-muted-foreground">Saved. The mic button on the composer works now.</p>}
      </Row>
      <Row
        label="How it works"
        icon={MicIcon}
        hint="Press the mic on the composer to start and press it again to stop — it is a toggle, not a hold, so it works the same on a phone with the keyboard up. Words appear in the box as they are confirmed; what is still being heard is shown beside the button and is not typed until it settles. Nothing sends on its own."
      />
    </SettingsGroup>
  );
}
