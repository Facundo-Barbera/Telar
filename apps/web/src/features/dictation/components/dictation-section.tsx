"use client";

import { useState } from "react";
import type { DictationProviderId } from "@telar/engine-client";
import { BookMarkedIcon, KeyRoundIcon, LanguagesIcon, MicIcon, MicOffIcon } from "lucide-react";
import { DICTATION_AUTOMATIC } from "../automatic";
import { useDictationSettings } from "../settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DictationMicrophoneSection } from "./dictation-microphone-section";
import { Dropdown, Row, SettingsGroup } from "@/features/settings";

const PROVIDERS: { id: DictationProviderId; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "deepgram", label: "Deepgram" },
];

const PROVIDER_INFO: Partial<Record<DictationProviderId, string>> = {
  deepgram: "Audio goes from the device straight to Deepgram; it does not pass through this Mac.",
};

export function DictationSection() {
  const { provider, configured, language, languages, vocabulary, keyterms, loading, save, error } = useDictationSettings();
  const [key, setKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [terms, setTerms] = useState<string>();

  async function saveKey(value: string): Promise<void> {
    setKeySaved(false);
    await save({ apiKey: value.trim() });
    setKey("");
    if (value.trim()) setKeySaved(true);
  }

  async function saveTerms(): Promise<void> {
    if (terms === undefined) return;
    await save({ vocabulary: terms.split("\n") });
    setTerms(undefined);
  }

  return (
    <>
      <SettingsGroup title="Dictation" scope="mac">
        <Row
          label="Provider"
          icon={provider === "off" ? MicOffIcon : MicIcon}
          {...(PROVIDER_INFO[provider] ? { info: PROVIDER_INFO[provider] } : {})}
          {...(PROVIDERS.some(({ id }) => id === provider) ? {} : { hint: "Not a provider this build can drive. Update Telar, or pick another." })}
          {...(error ? { error } : {})}
          control={
            <Dropdown<DictationProviderId>
              value={provider}
              onChange={(next) => void save({ provider: next })}
              options={PROVIDERS.map(({ id, label }) => ({ value: id, label }))}
              className="w-36"
              label="Dictation provider"
              disabled={loading}
            />
          }
        />
        {provider === "deepgram" && (
          <>
            <Row
              label="Language"
              icon={LanguagesIcon}
              {...(language === DICTATION_AUTOMATIC ? {} : { info: "Only this language is transcribed. More accurate within it, wrong for anything else." })}
              control={
                <Dropdown<string>
                  value={language}
                  onChange={(next) => void save({ language: next })}
                  options={languages.map(({ code, label }) => ({ value: code, label }))}
                  className="w-64"
                  label="Dictation language"
                  disabled={loading || languages.length === 0}
                />
              }
            />
            <Row
              label="Deepgram key"
              icon={KeyRoundIcon}
              {...(configured ? { status: "set" } : {})}
              info="The key stays on this Mac. Browsers and phones get a five-minute token instead."
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    className="h-8 w-56 font-mono text-xs"
                    aria-label="Deepgram key"
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
              {keySaved && <p className="mt-2 text-xs text-muted-foreground">Saved.</p>}
            </Row>
            <Row
              label="Vocabulary"
              icon={BookMarkedIcon}
              info="Projects, branches and open conversations are sent automatically. This is for the names only you know."
              control={
                <Textarea
                  className="h-28 w-64 font-mono text-xs"
                  aria-label="Dictation vocabulary"
                  placeholder={"One word per line"}
                  value={terms ?? vocabulary.join("\n")}
                  disabled={loading}
                  onChange={(event) => setTerms(event.target.value)}
                  onBlur={() => void saveTerms()}
                />
              }
            >
              {keyterms && keyterms.sent < keyterms.built && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {`Deepgram took ${keyterms.sent} of the ${keyterms.built} words Telar sent it last time. `}
                  {keyterms.reason === "refused"
                    ? "Over budget: branch names go first, then projects, then old conversations. This box is never cut."
                    : "Telar sent the number it can prove is safe; the next press tries the full list again."}
                </p>
              )}
            </Row>
          </>
        )}
      </SettingsGroup>
      {provider === "deepgram" && <DictationMicrophoneSection />}
    </>
  );
}
