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
 * ── AND WHICH LANGUAGE, WHICH IS A ROW BECAUSE IT WAS A BUG (#560) ──────────
 * Nothing sent `language` on the socket and Deepgram defaults to English, so
 * dictation quietly transcribed everybody into English-shaped words. The row
 * answers "Automatic" by default — Nova-3 code-switching between the languages
 * it supports, mid-sentence — and naming one is the NARROWING, offered for the
 * accuracy it buys in a single tongue rather than as the thing to pick first.
 *
 * THE NAMES COME FROM THE ENGINE. Seventy of them, per provider; a copy in this
 * file would be the list that is wrong the day Deepgram adds one, and a second
 * copy on the phone would make two.
 *
 * ── AND THE WORDS NOTHING COULD HAVE GUESSED (#581) ─────────────────────────
 * Dictation was primed with no vocabulary at all, so anything Deepgram had no
 * reason to expect — "Telar", a colleague's surname, a product spelled the
 * unobvious way — came back as whatever it sounded closest to. The engine
 * already sends what it can work out on its own: the conversations that are
 * unsettled, the projects, the branches. This box is for the rest, which is the
 * half only the person knows.
 *
 * ONE PER LINE, AND IT SAVES WHEN THE BOX LOSES FOCUS. A list is not a value
 * that can be saved on every keystroke — half a word typed is not a term — and
 * a Save button beside a textarea is a button people forget to press. Blur is
 * the moment somebody is done with it.
 *
 * SAVE-PER-INTERACTION, AND THE ENGINE'S ANSWER IS THE STATE — the two rules
 * every settings pane here follows. A refused write leaves the controls showing
 * what is stored and says why underneath.
 *
 * ── AND THE COPY CUT, WHICH IS THE SAME CHANGE AS THE DEMO (#643) ───────────
 * This pane carried five hints, a standing caption, and a row called "How it
 * works" whose entire content was ~300 characters of manual — on a row with no
 * control, in a pane of settings. The rule it broke is already written down in
 * `updates-section.tsx`: a hint may never restate its own control, and a standing
 * caption over rows that each carry a live sentence is the doubling #357 was
 * about.
 *
 * WHAT WENT, AND WHY EACH ONE:
 *   - THE GROUP'S CAPTION. "Speak into any message box … off by default: this
 *     Mac's own dictation keeps working either way" is what the Provider row's
 *     own hint says, live, on whichever value is chosen. The caption said it
 *     standing, above it, in both states at once.
 *   - "HOW IT WORKS", ENTIRELY. Behaviour belongs where the mic button is, or in
 *     docs. And the live demo in `dictation-microphone-section.tsx` now SHOWS the
 *     half worth knowing — words appearing as they are heard and being rewritten
 *     until they settle — which is what earned the deletion rather than a
 *     shortening. Build the demo and the cut separately and you keep the
 *     paragraph.
 *   - "Narrow it below only if you speak one language…" off the Automatic hint:
 *     an instruction to use the control the hint is sitting under. The cost of
 *     narrowing is still stated, on the hint for a narrowed language, where it is
 *     a live fact rather than a warning about a thing nobody has done.
 *   - "…and the words appear in the box as they are heard" off the Deepgram
 *     hint: the third copy of one sentence, and the demo shows it.
 *
 * WHAT STAYED IS WHAT A CONTROL CANNOT SAY ITSELF: what each provider actually
 * means for this Mac and for a paired phone, where the audio goes and what the
 * key is spent on, what Automatic buys and what narrowing costs, what the
 * vocabulary box affects and when it saves.
 */

import { useState } from "react";
import type { DictationProviderId } from "@telar/engine-client";
import { BookMarkedIcon, KeyRoundIcon, LanguagesIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useDictationSettings } from "@/lib/dictation/settings";
import { DICTATION_AUTOMATIC } from "@/lib/dictation/automatic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DictationMicrophoneSection } from "./dictation-microphone-section";
import { Dropdown, Row, SettingsGroup } from "./settings-shell";

/** The names a person picks between. `off` is a member rather than an absent
 *  choice: "nobody has chosen" and "chosen: nobody" are the same state here,
 *  and one name for it means no row has to handle an empty value. */
const PROVIDERS: { id: DictationProviderId; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "deepgram", label: "Deepgram" },
];

const PROVIDER_HINT: Record<DictationProviderId, string> = {
  off: "No mic button anywhere — on this Mac’s composers or on a paired phone. macOS dictation and anything like Wispr Flow keep working in the message box exactly as they do now; Telar simply does not add one of its own.",
  // THE PRIVACY FACT AND NOTHING ELSE (#643). "…and the words appear in the box
  // as they are heard" was the third copy of one sentence — the caption said it,
  // "How it works" said it, and the live demo below now shows it.
  deepgram: "A mic button on every message box here and on the phone. Audio goes from the device straight to Deepgram — it does not pass through this Mac.",
};

export function DictationSection() {
  const { provider, configured, language, languages, vocabulary, keyterms, loading, save, error } = useDictationSettings();
  const [key, setKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  /**
   * `undefined` MEANS "SHOW WHAT IS STORED", which is what keeps this box in
   * step with the engine without an effect syncing two copies of one list. It
   * holds a draft only while somebody is typing in it, and drops back to the
   * engine's answer the moment the save lands — so a refused write leaves the
   * stored terms on screen rather than the ones that did not take.
   */
  const [terms, setTerms] = useState<string>();

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

  /** One per line, and the engine tidies the rest: blanks and repeats go there
   *  rather than here, so a hand-written file and this box agree about what a
   *  stored term is. */
  async function saveTerms(): Promise<void> {
    if (terms === undefined) return;
    await save({ vocabulary: terms.split("\n") });
    setTerms(undefined);
  }

  return (
    <>
      {/* NO CAPTION (#643). It said what the Provider row's hint says of
          whichever value is chosen — and said it standing, in both states at
          once, above a row that answers live. The same rule `updates-section.tsx`
          states for the same reason. */}
      <SettingsGroup title="Dictation">
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
            {/* AUTOMATIC IS FIRST AND IS THE DEFAULT. It is the engine that puts
                it there — the row renders the order it was given rather than
                hoisting a code it would have to recognise by name. */}
            <Row
              label="Language"
              icon={LanguagesIcon}
              // THE LAST SENTENCE WENT (#643): "Narrow it below only if you speak
              // one language…" was an instruction to use the control the hint sits
              // under. What narrowing costs is still said — on the hint for a
              // narrowed language, where it is a live fact about the chosen value
              // rather than a warning about a thing nobody has done.
              hint={
                language === DICTATION_AUTOMATIC
                  ? "Words are transcribed in whichever supported language they are spoken in, including switching between two of them inside one sentence — which is what a name dropped into another language actually is."
                  : "Only this language is transcribed. More accurate than Automatic within it, and wrong for anything else — a sentence in another language comes back as whatever this one sounded closest to."
              }
              control={
                // `Dropdown` RATHER THAN A SELECT WRITTEN OUT HERE, for the one
                // thing it fixes in a single place: a bare `<SelectValue />`
                // renders the VALUE, so this trigger would read "es" where a
                // person chose Spanish (#318).
                <Dropdown<string>
                  value={language}
                  onChange={(next) => void save({ language: next })}
                  options={languages.map(({ code, label }) => ({ value: code, label }))}
                  className="w-64"
                  label="Dictation language"
                  // NO LANGUAGES MEANS THE ENGINE HAS NOT ANSWERED YET. A picker
                  // with nothing in it is a control that does nothing when it is
                  // opened.
                  disabled={loading || languages.length === 0}
                />
              }
            />
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
              label="Vocabulary"
              icon={BookMarkedIcon}
              hint="Words the recogniser has no reason to expect — a product name, a colleague's surname, a piece of jargon — one per line. Your conversations, your projects and their branches are already sent; this is for the rest. Saved when you click away."
              control={
                <Textarea
                  className="h-28 w-64 font-mono text-xs"
                  aria-label="Dictation vocabulary"
                  placeholder={"Kubernetes\nZarigüeya\nPostgres"}
                  // THE STORED LIST WHEN NOBODY IS TYPING — see `terms`. Joined
                  // here rather than kept as text anywhere, so what is on screen
                  // is what the engine actually holds.
                  value={terms ?? vocabulary.join("\n")}
                  disabled={loading}
                  onChange={(event) => setTerms(event.target.value)}
                  onBlur={() => void saveTerms()}
                />
              }
            >
              {/* WHEN NOT ALL OF IT FITS, SAY SO (#712).
                  Deepgram's glossary has a token budget, the engine builds up to
                  a measured bound and asks, and a list over the budget is
                  shortened from the tail rather than refused — which is the
                  right trade, and exactly the kind of thing that goes unnoticed
                  for a month. It is said HERE and not on the composer: a shrink
                  is a standing property of this Mac's glossary rather than an
                  event, it stays true until the list changes, and this is the
                  screen somebody would be on to do something about it.
                  Interrupting a press to report a degradation nobody can act on
                  mid-sentence would be the worse version. */}
              {keyterms && keyterms.sent < keyterms.built && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {`Deepgram took ${keyterms.sent} of the ${keyterms.built} words Telar sent it last time. `}
                  {keyterms.reason === "refused"
                    ? "The rest were over its budget. What goes is the end of the list — branch names first, then project names, then your oldest open conversations. The words in this box are never the ones dropped."
                    : "Deepgram could not be asked which would fit, so Telar sent the number it can prove is safe. The next press tries the full list again."}
                </p>
              )}
            </Row>
            {/* "HOW IT WORKS" STOOD HERE (#643) — ~300 characters of manual on a
                row with nothing to change. The live demo in the group below shows
                the half of it worth knowing, which is what earned the deletion
                rather than a rewrite. */}
          </>
        )}
      </SettingsGroup>
      {/* PICK, TEST, WATCH — its own group, and only under a chosen provider,
          for the key row's reason: a microphone picker for a dictation that does
          not exist is a setting with nowhere to land, and the demo needs a
          provider to demonstrate. */}
      {provider === "deepgram" && <DictationMicrophoneSection />}
    </>
  );
}
