"use client";

/**
 * WHERE TELAR READS CODE HOSTING FROM, AND WHAT IT WOULD TAKE TO FIX IT.
 *
 * The cockpit reads issues, pull requests and checks through the `gh` CLI the
 * user already authenticated (`apps/engine/src/github.ts` states why: a token
 * in Telar's state is a different product, with a place to live, a rotation
 * story and an audit story). That arrangement has never had a screen. When
 * `gh` is missing or signed out, the only surface that says so is the forge
 * panel inside a session — which a reader only opens once they already
 * expected it to work.
 *
 * AN UNAVAILABLE INTEGRATION'S DESCRIPTION IS THE FIX. That is the one idea
 * worth taking from the reference here (`15-settings-source-control.png`): the
 * exact command, in the row, rather than a "Learn more" that leaves the app.
 * So a machine with no `gh` reads the install line, and one that is signed out
 * reads `gh auth login`, in the slot where the explanation would otherwise be.
 *
 * THE ROWS ARE DRAWN BEFORE THE PROBE LANDS. Asking `gh` is a network round
 * trip that can take seconds, and everything worth knowing here except the
 * status word is true whatever it answers. So the pane renders its copy
 * immediately and fills the badge in when the engine replies — the same rule
 * every other loader in this directory follows.
 *
 * THE PROBE IS ONE PROJECT, AND THAT IS ENOUGH. `not_installed` and
 * `not_authenticated` are facts about the MACHINE: `gh` would answer them for
 * any checkout at all. Everything else — a repository, or `no_repository` —
 * means `gh` ran, which is the only other thing this pane claims. So one read
 * against the first registered project distinguishes every state it reports,
 * without a route of its own.
 *
 * GITLAB IS LISTED AND SAYS NO. A person whose repositories are on GitLab
 * should learn that from this pane rather than by opening a forge panel that
 * stays empty — the reference's "disabled things stay visible" rule, applied to
 * the thing Telar genuinely does not do.
 */

import { useCallback, useEffect, useState } from "react";
// No brand glyphs: lucide dropped them, and a wordmark drawn by hand would be
// the one icon in the app nobody could restyle with the rest.
import { GitBranchIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import type { GitHubUnavailable } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { UNAVAILABLE } from "@/lib/github-forge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/**
 * What this pane knows about `gh` right now.
 *
 * `no_projects` IS NOT A FAILURE OF ANYTHING. A cockpit with nothing registered
 * has no checkout to ask `gh` from, and saying "not installed" on that evidence
 * would be a diagnosis the pane cannot support.
 */
export type GhState =
  | { status: "checking" }
  | { status: "ready"; repository?: string }
  | { status: "unavailable"; reason: Exclude<GitHubUnavailable, "no_repository">; message?: string }
  | { status: "no_projects" };

/**
 * The engine's per-project answer, read as a fact about this machine.
 *
 * Pure and exported so every branch is testable without a network — the
 * interesting one being that `no_repository` is a SUCCESS here: it is `gh`
 * running fine and reporting that this particular checkout has no GitHub
 * remote, which says nothing about whether the CLI works.
 */
export function readGhState(snapshot: { unavailable?: GitHubUnavailable; message?: string; repository?: string }): GhState {
  const reason = snapshot.unavailable;
  if (reason === undefined || reason === "no_repository") {
    return { status: "ready", ...(snapshot.repository ? { repository: snapshot.repository } : {}) };
  }
  return { status: "unavailable", reason, ...(snapshot.message ? { message: snapshot.message } : {}) };
}

/**
 * THE SENTENCE THAT FIXES IT, per state, and it names the command.
 *
 * `lib/github-forge.ts` already decided what each `gh` failure MEANS — it is
 * the module the forge panel reads — so the diagnosis is taken from there
 * rather than written twice. What this pane adds is the instruction, which the
 * panel has no room for.
 */
const FIX: Record<Exclude<GitHubUnavailable, "no_repository">, string> = {
  not_installed: "Install the GitHub CLI — `brew install gh` on macOS, or your own package manager — then run `gh auth login`.",
  not_authenticated: "Run `gh auth login` in a terminal on this machine. Sign-in lives outside Telar, the same as it does for Claude and Codex.",
  failed: "Run `gh auth status` in a terminal on this machine to see what it says.",
};

function GhStatus({ state }: { state: GhState }) {
  if (state.status === "checking") return <Spinner />;
  if (state.status === "ready") return <Badge variant="secondary">Authenticated</Badge>;
  if (state.status === "no_projects") return <Badge variant="outline">Not checked</Badge>;
  return <Badge variant="outline">{UNAVAILABLE[state.reason].title}</Badge>;
}

export function SourceControlPage() {
  const [state, setState] = useState<GhState>({ status: "checking" });

  const probe = useCallback(async (refresh = false) => {
    setState({ status: "checking" });
    try {
      const { projects } = await api.projects();
      const first = projects[0];
      if (!first) return setState({ status: "no_projects" });
      const { github } = await api.projectGitHub(first.id, refresh ? { refresh: true } : {});
      setState(readGhState(github));
    } catch (cause) {
      setState({ status: "unavailable", reason: "failed", message: cause instanceof Error ? cause.message : "The engine did not answer." });
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void probe(), 0);
    return () => window.clearTimeout(task);
  }, [probe]);

  return (
    <SettingsGroup
      title="Source control"
      description="Telar never holds a token of its own — it reads through a CLI you signed in to yourself."
    >
      <Row
        label="GitHub"
        icon={GitPullRequestIcon}
        hint={
          state.status === "unavailable"
            ? // THE FIX TAKES THE SLOT. A reader looking at "not installed" wants
              // the command, not a restatement of how the integration works.
              `${UNAVAILABLE[state.reason].detail} ${FIX[state.reason]}`
            : state.status === "no_projects"
              ? "Nothing is registered yet, so there is no checkout to ask gh from. Register a project and this fills in."
              : "Issues, pull requests and checks, read through the gh CLI. Sessions get the same access you have in a terminal."
        }
        {...(state.status === "ready" && state.repository ? { status: <Badge variant="outline">{state.repository}</Badge> } : {})}
        control={
          <div className="flex items-center gap-2">
            <GhStatus state={state} />
            {/* A refresh, because the fix happens in a TERMINAL. Somebody who
                has just run `gh auth login` should not have to guess whether
                this screen re-reads on its own. */}
            <Button
              size="sm"
              variant="outline"
              disabled={state.status === "checking"}
              onClick={() => void probe(true)}
              aria-label="Check gh again"
            >
              <RefreshCwIcon className="size-3.5" />
              Check again
            </Button>
          </div>
        }
      />
      <Row
        label="GitLab"
        icon={GitBranchIcon}
        control={<Badge variant="outline">Not supported</Badge>}
        unavailable={{
          reason:
            "Telar reads GitHub through gh and has no GitLab reader. A GitLab project still works everywhere else — sessions, worktrees, branches and diffs are git, not GitHub.",
        }}
      />
    </SettingsGroup>
  );
}
