"use client";

import { useCallback, useEffect, useState } from "react";
import { GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import type { GitHubUnavailable } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine/index";
import { UNAVAILABLE } from "../github-forge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Row, SettingsGroup } from "@/features/settings";

const api = createEngineApi();

export type GhState =
  | { status: "checking" }
  | { status: "ready"; repository?: string }
  | { status: "unavailable"; reason: Exclude<GitHubUnavailable, "no_repository" | "not_github">; message?: string }
  | { status: "no_projects" };

export function readGhState(snapshot: { unavailable?: GitHubUnavailable; message?: string; repository?: string }): GhState {
  const reason = snapshot.unavailable;
  if (reason === undefined || reason === "no_repository" || reason === "not_github") {
    return { status: "ready", ...(snapshot.repository ? { repository: snapshot.repository } : {}) };
  }
  return { status: "unavailable", reason, ...(snapshot.message ? { message: snapshot.message } : {}) };
}

const FIX: Record<Exclude<GitHubUnavailable, "no_repository" | "not_github">, string> = {
  not_installed: "Install the GitHub CLI — `brew install gh` on macOS, or your own package manager — then run `gh auth login`.",
  not_authenticated: "Run `gh auth login` in a terminal on this machine. Sign-in lives outside Telar, the same as it does for Claude and Codex.",
  no_checkout: "Move the project's folder back, or re-register the project pointing at where it lives now.",
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
      description="Read through a CLI you signed in to yourself. Telar holds no token of its own."
    >
      <Row
        label="GitHub"
        icon={GitPullRequestIcon}
        {...(state.status === "unavailable"
          ? { hint: `${UNAVAILABLE[state.reason].detail} ${FIX[state.reason]}` }
          : state.status === "no_projects"
            ? { hint: "Register a project and this fills in — there is no checkout to ask gh from yet." }
            : {})}
        {...(state.status === "ready" && state.repository ? { status: <Badge variant="outline">{state.repository}</Badge> } : {})}
        control={
          <div className="flex items-center gap-2">
            <GhStatus state={state} />
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
    </SettingsGroup>
  );
}
