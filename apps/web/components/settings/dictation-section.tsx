"use client";

/**
 * DICTATION — speak into any message box on this Mac (#544).
 *
 * ── THE FIRST ROW IS "WHETHER AT ALL", AND IT ANSWERS OFF ───────────────────
 * Nothing is forced. macOS dictation works on the composer already — it is a
 * plain editable — and so do Wispr Flow and everything like it, so a mic button
 * that appeared on every message box uninvited would be Telar claiming a job
 * somebody may have given elsewhere. `off` is the default, and with it there is
 * no key row and no button on any surface: the web, the desktop shell and the
 * phone all read this one setting.
 *
 * THE PICKER COMES FIRST because everything under it is a property of the
 * provider. A key row above a provider row would be asking "which key" before
 * "whose".
 *
 * ── THE FIELD NEVER SHOWS A STORED KEY ──────────────────────────────────────
 * It shows WHETHER one is there, which is what the Agent's key row does and
 * what every provider login on the Providers pane does, for the same reason: a
 * field that displayed a secret would be one screen-share away from leaking it.
 * Typing a new one replaces it; the button beside it removes it.
 *
 * AND SWITCHING BACK TO OFF KEEPS THE KEY. Turning dictation on again is one
 * click rather than a trip to the vendor's console — which is also why
 * `configured` is answered while the provider is off.
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
import type { DictationProviderId } from "@telar/engine-client";
import { KeyRoundIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useDictationSettings } from "@/lib/dictation/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row, SettingsGroup } from "./settings-shell";

/** The names a person picks between. `off` is a member rather than an absent
 *  choice: "nobody has chosen" and "chosen: nobody" are the same state here,
 *  and one name for it means no row has to handle an empty value. */
const PROVIDERS: { id: DictationProviderId; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "deepgram", label: "Deepgram" },
];

const PROVIDER_HINT: Record<DictationProviderId, string> = {
  off: "No mic button anywhere — on this Mac’s composers or on a paired phone. macOS dictation and anything like Wispr Flow keep working in the message box exactly as they do now; Telar simply does not add one of its own.",
  deepgram:
    "A mic button on every message box here and on the phone. Audio goes from the device straight to Deepgram — it does not pass through this Mac — and the words appear in the box as they are heard.",
};

export function DictationSection() {
  const { provider, configured, loading, save, error } = useDictationSettings();
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
      description="Speak into any message box — the mic button on the composer, here and on the phone. Off by default: this Mac’s own dictation and anything you already use keep working either way."
    >
      <Row
        label="Provider"
        icon={provider === "off" ? MicOffIcon : MicIcon}
        hint={PROVIDER_HINT[provider] ?? "Chosen on this Mac, and not one this cockpit knows how to drive. Update Telar, or pick another."}
        {...(error ? { error } : {})}
        control={
          <Select
            value={provider}
            // base-ui hands back `null` for a cleared selection; this Select is
            // never clearable, so that case is ignored rather than written
            // through as a provider of "null".
            onValueChange={(next) => {
              if (typeof next === "string") void save({ provider: next as DictationProviderId });
            }}
            disabled={loading}
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map(({ id, label }) => (
                <SelectItem key={id} value={id}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {/* THE PROVIDER'S OWN ROWS, and only when there is a provider. A key
          field under "Off" would be asking for a credential nothing will
          spend. The key itself is kept when the provider goes off — it is the
          row that goes away, not the secret. */}
      {provider === "deepgram" && (
        <>
          <Row
            label="Deepgram key"
            icon={KeyRoundIcon}
            // THE ROW'S OWN STATE, beside the label rather than in the field:
            // the field says whether a key is there by its placeholder, and
            // this is the word a reader scanning the pane sees without reading
            // the hint.
            {...(configured ? { status: "set" } : {})}
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
                  // NEVER THE STORED KEY — the engine answers whether there is
                  // one and nothing else, by design.
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
            hint="Press the mic on the composer to start and press it again to stop — it is a toggle, not a hold, so it works the same on a phone with the keyboard up. Words appear in the box as they are heard and are rewritten in place until Deepgram settles them. Nothing sends on its own."
          />
        </>
      )}
    </SettingsGroup>
  );
}
