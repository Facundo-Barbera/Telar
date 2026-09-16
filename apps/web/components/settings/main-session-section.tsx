"use client";

/**
 * MAIN ASSISTANT — one conversation per Mac to coordinate Telar work from.
 * Experimental, off by default (#522, corrected by #526).
 *
 * WHY IT IS A SETTING AND NOT A BUTTON ON A CONVERSATION. Which session is Main
 * is a fact about the MACHINE, not about the conversation you happen to have
 * open: the engine reads it on every claim and every rail on every device draws
 * from it. A control on a session would put that decision in as many places as
 * there are sessions.
 *
 * ── WHAT #526 TOOK OFF THIS PANE, AND WHAT IT PUT ON ────────────────────────
 * THE PROJECT PICKER IS GONE. It used to ask "which project shall I create the
 * coordinator in", and the answer turned out to be none: Main has no project
 * and no checkout. So the switch no longer needs anything chosen before it can
 * be pressed, and the row that asked stopped being a question.
 *
 * WHAT ARRIVED INSTEAD IS THE TWO THINGS THE ASSISTANT ACTUALLY NEEDS: a model
 * id and a key. Both belong here rather than on the conversation for the
 * reason above — they are facts about the role, and they survive the
 * designation moving to another conversation.
 *
 * ── THE KEY GOES WHERE EVERY OTHER CREDENTIAL IN TELAR GOES ─────────────────
 * The `telar` login's `OPENCODE_API_KEY`, marked sensitive: a 0600 file the
 * registry route never echoes back, and a redacted round trip on every read. So
 * this field NEVER SHOWS A STORED KEY — it shows whether one is there, which is
 * the same thing every provider login on the Providers pane does. Typing a new
 * one replaces it; the button beside it removes it.
 *
 * WHICH RUNG ANSWERED IS SHOWN, because "it works, and it is not the key you
 * pasted" is the confusing state this feature can be in: the engine falls back
 * to `OPENCODE_API_KEY` in its environment and then to the OpenCode CLI's own
 * login. The row says which, never the key.
 *
 * SAVE-PER-INTERACTION, AND THE ENGINE'S ANSWER IS THE STATE — the two rules
 * every settings pane here follows. A refused write leaves the controls showing
 * what is stored and says why underneath.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { KeyRoundIcon, SparklesIcon } from "lucide-react";
import type { LiveSessionRow } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { useMainSession } from "@/lib/main-session";
import { sessionHref } from "@/lib/session-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dropdown, Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/** The login the key is stored on. Its id IS the driver kind, which is what
 *  makes it addressable without a lookup — see the engine's registry. */
const TELAR_INSTANCE = "telar";
const KEY_VAR = "OPENCODE_API_KEY";

/** What runs when nobody picks. Shown as the field's placeholder so the row
 *  answers "what am I on right now" without a second read. Mirrors the
 *  engine's `DEFAULT_GO_MODEL`; the engine is what actually applies it. */
const DEFAULT_MODEL_PLACEHOLDER = "kimi-k3";

/** `session:<id>` designates an existing conversation. There is no `project:`
 *  arm any more — Main is minted with no project, so there is nothing to
 *  create it IN. */
type Choice = `session:${string}` | "";

const SOURCE_LABEL: Record<"setting" | "environment" | "cli", string> = {
  setting: "Using the key saved here.",
  environment: `No key saved here — using ${KEY_VAR} from the engine's environment.`,
  cli: "No key saved here — using the OpenCode CLI's own sign-in.",
};

export function MainSessionSection() {
  const { main, credential, loading, save, error } = useMainSession();
  const [sessions, setSessions] = useState<LiveSessionRow[]>([]);
  const [choice, setChoice] = useState<Choice>("");
  /** `undefined` until somebody types: the stored value is what shows, so a
   *  late first answer cannot overwrite a field nobody has touched — and no
   *  effect writes state, which this app's lint forbids. */
  const [typedModel, setTypedModel] = useState<string>();
  const [key, setKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [keyError, setKeyError] = useState<string>();

  useEffect(() => {
    // The read the rail already makes: every conversation that could be
    // designated. Deferred a tick like every other loader on this pane.
    const task = window.setTimeout(() => {
      void api
        .liveSessions()
        .then((answer) => setSessions(answer.sessions))
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const model = typedModel ?? main.model ?? "";

  const designated = useMemo(
    () => (main.sessionId ? sessions.find((session) => session.id === main.sessionId) : undefined),
    [main.sessionId, sessions],
  );

  const options = useMemo(
    () => sessions.map((session) => ({ value: `session:${session.id}` as Choice, label: session.title || session.id })),
    [sessions],
  );

  async function saveKey(value: string): Promise<void> {
    setKeyError(undefined);
    try {
      await api.saveProviderInstance({
        id: TELAR_INSTANCE,
        driver: "telar",
        // A BLANK VALUE DOES NOT CLEAR A SECRET — that is the registry's own
        // rule, because blank is indistinguishable from "I did not retype it".
        // Clearing is dropping the variable, which is what the empty list does.
        env: value.trim() ? [{ name: KEY_VAR, value: value.trim(), sensitive: true }] : [],
      });
      setKey("");
      setKeySaved(true);
      // Re-read the designation so the row's "which rung" line reflects the
      // key that was just saved, or the fallback that took over when it went.
      await save({});
    } catch (cause) {
      setKeyError(cause instanceof Error ? cause.message : "The engine refused that key.");
    }
  }

  return (
    <SettingsGroup
      title="Main assistant"
      description="Experimental. One conversation per Mac for keeping track of Telar work — it has no project and no checkout: it reads the rail, delegates bounded tasks to project sessions, and reports back."
    >
      <Row
        label="Main assistant (experimental)"
        icon={SparklesIcon}
        hint={
          main.enabled
            ? "On. Telar runs its own agent loop for this one conversation, on OpenCode Go. It holds the sessions and notes tools and nothing else — no shell, no browser, no files — and runs nothing on a timer."
            : "Off. Nothing is briefed and the rail is unchanged. Turning it off later keeps the conversation and its history, and stops the wakes it had subscribed to."
        }
        {...(error ? { error } : {})}
        control={
          <Switch
            checked={main.enabled}
            disabled={loading}
            // NOTHING HAS TO BE CHOSEN FIRST any more (#526): with nothing
            // designated, turning it on mints a project-less conversation.
            onCheckedChange={(next: boolean) => void save({ enabled: next })}
            aria-label="Main assistant (experimental)"
          />
        }
      />
      <Row
        label="Model"
        hint={`The model id OpenCode Go serves this conversation. Empty runs ${DEFAULT_MODEL_PLACEHOLDER}. It is passed through untouched — Telar keeps no list of what Go serves.`}
        control={
          <Input
            className="h-8 w-56 font-mono text-xs"
            aria-label="Main assistant model"
            placeholder={DEFAULT_MODEL_PLACEHOLDER}
            value={model}
            disabled={loading}
            onChange={(event) => setTypedModel(event.target.value)}
            // ON BLUR AND ON ENTER, not on every keystroke: a model id is typed,
            // and a PATCH per character would be a write per character.
            onBlur={() => {
              if (typedModel === undefined) return;
              setTypedModel(undefined);
              void save({ model: typedModel.trim() });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        }
      />
      <Row
        label="OpenCode Go key"
        icon={KeyRoundIcon}
        hint={
          credential === undefined
            ? "This engine does not report where its key comes from."
            : credential.rejected
              ? "OpenCode Go refused the key this Mac is using. Paste a new one."
              : credential.source
                ? SOURCE_LABEL[credential.source]
                : `No key anywhere. Paste one here, or set ${KEY_VAR} in the engine's environment, or sign in with the OpenCode CLI.`
        }
        {...(keyError ? { error: keyError } : {})}
        control={
          <div className="flex items-center gap-2">
            <Input
              type="password"
              className="h-8 w-56 font-mono text-xs"
              aria-label="OpenCode Go key"
              // NEVER THE STORED KEY. The registry hands back a redacted shape
              // by design, and a field that displayed a secret would be one
              // screen-share away from leaking it.
              placeholder={credential?.source === "setting" ? "A key is saved" : "sk-…"}
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
            {credential?.source === "setting" && !key.trim() ? (
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
        {keySaved && <p className="mt-2 text-xs text-muted-foreground">Saved. It is stored with this Mac’s other provider credentials and never shown again.</p>}
      </Row>
      <Row
        label="Conversation"
        hint={
          main.sessionId
            ? "Switching to another one leaves this conversation exactly as it is — it simply stops being Main."
            : "Turning the switch on creates one: no project, no checkout, running Telar's own loop."
        }
        control={
          <Dropdown<Choice>
            value={main.sessionId ? (`session:${main.sessionId}` as Choice) : choice}
            label="Which conversation is Main"
            disabled={loading || options.length === 0}
            onChange={(next) => {
              setChoice(next);
              if (next.startsWith("session:")) void save({ sessionId: next.slice("session:".length) });
            }}
            options={options.length > 0 ? options : [{ value: "" as Choice, label: "No conversations yet" }]}
          />
        }
      >
        {/* THE ROW SAYS WHICH ONE, AND OPENS IT. A designation you cannot click
            through to is a setting that names something you have to go and find
            in the list yourself. `sessionHref` is what knows that a
            project-less conversation lives at `/main`. */}
        {designated && (
          <p className="mt-2 text-xs text-muted-foreground">
            <Link href={sessionHref(designated)} className="underline underline-offset-2 hover:text-foreground">
              Open {designated.title || designated.id}
            </Link>
          </p>
        )}
      </Row>
    </SettingsGroup>
  );
}
