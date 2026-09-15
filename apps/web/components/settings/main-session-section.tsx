"use client";

/**
 * MAIN SESSION — one designated conversation to coordinate Telar work from.
 * Experimental, off by default (#522).
 *
 * WHY IT IS A SETTING AND NOT A BUTTON ON A CONVERSATION. Which session is Main
 * is a fact about the MACHINE, not about the conversation you happen to have
 * open: the engine reads it on every claim and every rail on every device draws
 * from it. A control on a session would put that decision in as many places as
 * there are sessions.
 *
 * WHAT IT ACTUALLY DOES, so the row can say so honestly: it adds an entry near
 * the top of the rail, and it appends a coordinator briefing to that one
 * session's prompt. It grants nothing — the `sessions_*` and `notes_*` tools sit
 * behind the same gate for it as for every other conversation — and it starts
 * nothing on a timer.
 *
 * TWO CONTROLS, BECAUSE THERE ARE TWO QUESTIONS. The switch is "is this on";
 * the dropdown under it is "which conversation", and it offers a new one in
 * each registered project as well as every conversation that already exists.
 * Turning the switch on with nothing designated is refused by the engine rather
 * than guessed, so the switch stays disabled until the dropdown has an answer —
 * a switch that throws when pressed is worse than one that says why it cannot be.
 *
 * SAVE-PER-INTERACTION, AND THE ENGINE'S ANSWER IS THE STATE — the two rules
 * every settings pane here follows. A refused write leaves the controls showing
 * what is stored and says why underneath.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SparklesIcon } from "lucide-react";
import type { LiveSessionRow, Project } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { useMainSession } from "@/lib/main-session";
import { Switch } from "@/components/ui/switch";
import { Dropdown, Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/** `project:<id>` creates one there; `session:<id>` designates that
 *  conversation. One dropdown, because "which conversation" is one question
 *  whether the answer exists yet or not. */
type Choice = `project:${string}` | `session:${string}` | "";

export function MainSessionSection() {
  const { main, loading, save, error } = useMainSession();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<LiveSessionRow[]>([]);
  const [choice, setChoice] = useState<Choice>("");

  useEffect(() => {
    // One read for both halves, and the one the rail already makes: the
    // projects to create in and the conversations to designate arrive together.
    // Deferred a tick like every other loader on this pane.
    const task = window.setTimeout(() => {
      void api
        .liveSessions()
        .then((answer) => {
          setProjects(answer.projects);
          setSessions(answer.sessions);
        })
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const designated = useMemo(
    () => (main.sessionId ? sessions.find((session) => session.id === main.sessionId) : undefined),
    [main.sessionId, sessions],
  );

  const options = useMemo(
    () => [
      ...projects.map((project) => ({ value: `project:${project.id}` as Choice, label: `New conversation in ${project.name}` })),
      // The conversations that already exist, so "use this one" is a pick
      // rather than a thing you have to create and then abandon.
      ...sessions.map((session) => ({ value: `session:${session.id}` as Choice, label: session.title || session.id })),
    ],
    [projects, sessions],
  );

  /** What the switch would designate if pressed now: whatever is already
   *  designated, else whatever the dropdown says. */
  const designating = main.sessionId !== undefined || choice !== "";

  function patchFor(next: boolean): { enabled: boolean; sessionId?: string; projectId?: string } {
    if (!next || main.sessionId !== undefined) return { enabled: next };
    // THE ENGINE DECIDES WHICH RUNG, not this pane: it reuses an existing
    // designation before it looks at a project at all. All this does is pass on
    // what the reader picked.
    if (choice.startsWith("session:")) return { enabled: true, sessionId: choice.slice("session:".length) };
    return { enabled: true, projectId: choice.slice("project:".length) };
  }

  return (
    <SettingsGroup
      title="Main session"
      description="Experimental. One conversation you coordinate Telar work from — it gets an entry at the top of the rail and a briefing about the job."
    >
      <Row
        label="Main session (experimental)"
        icon={SparklesIcon}
        hint={
          main.enabled
            ? "On. This conversation is briefed to help manage Telar work: look before creating, delegate what you ask it to, report what changed. It holds no extra tools or permissions, and runs nothing on a timer."
            : "Off. Nothing is briefed and the rail is unchanged. Turning it off later keeps the conversation and its history, and stops the wakes it had subscribed to."
        }
        {...(error ? { error } : {})}
        {...(loading || designating
          ? {}
          : { unavailable: { reason: "Pick a conversation below first — Telar will not choose a project for you." } })}
        control={
          <Switch
            checked={main.enabled}
            disabled={loading || !designating}
            onCheckedChange={(next: boolean) => void save(patchFor(next))}
            aria-label="Main session (experimental)"
          />
        }
      />
      <Row
        label="Conversation"
        hint={
          main.sessionId
            ? "Switching to another one leaves this conversation exactly as it is — it simply stops being Main."
            : "A new one is created with this machine's usual provider and workspace settings. Nothing about it is special except the briefing."
        }
        control={
          <Dropdown<Choice>
            value={main.sessionId ? (`session:${main.sessionId}` as Choice) : choice}
            label="Which conversation is Main"
            disabled={loading || options.length === 0}
            onChange={(next) => {
              setChoice(next);
              // ALREADY ON MEANS THE PICK IS THE CHANGE. Off, it is only a
              // choice for the switch to act on — designating a conversation
              // for a feature that is switched off would write a state nobody
              // asked for.
              if (!main.enabled) return;
              if (next.startsWith("session:")) void save({ sessionId: next.slice("session:".length) });
            }}
            options={options.length > 0 ? options : [{ value: "" as Choice, label: "No projects registered" }]}
          />
        }
      >
        {/* THE ROW SAYS WHICH ONE, AND OPENS IT. A designation you cannot click
            through to is a setting that names something you have to go and find
            in the list yourself. */}
        {designated && (
          <p className="mt-2 text-xs text-muted-foreground">
            <Link
              href={designated.projectId ? `/projects/${encodeURIComponent(designated.projectId)}/sessions/${encodeURIComponent(designated.id)}` : "/"}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Open {designated.title || designated.id}
            </Link>
          </p>
        )}
      </Row>
    </SettingsGroup>
  );
}
