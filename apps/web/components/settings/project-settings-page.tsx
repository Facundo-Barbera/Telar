"use client";

/**
 * One project's settings, on the same frame as the machine's.
 *
 * THE SAME SHELL DELIBERATELY. A project's settings and the app's are the same
 * KIND of screen, and giving one of them its own layout is how two surfaces
 * that should feel identical drift apart. The side-nav is short because this is
 * genuinely the beginning of a surface — MCP servers are the first setting that
 * is honestly per-project rather than per-machine, and the second one will go
 * beside it rather than inventing a third place to look.
 *
 * IT NAMES THE PROJECT AND ITS ROOT. A settings page that could apply to any of
 * five registered repositories has to say which one it is editing, and the
 * checkout path is the unambiguous answer — two projects can share a name, and
 * the id is not something a person recognises.
 */

import { useCallback, useEffect, useState } from "react";
import { CircleAlertIcon, FlaskConicalIcon, FolderGitIcon, SigmaIcon, WrenchIcon } from "lucide-react";
import type { Project } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { canvasHref } from "@/lib/session-list";
import { Badge } from "@/components/ui/badge";
import { DataScienceSection } from "./data-science-section";
import { LatexSection } from "./latex-section";
import { McpSection } from "./mcp-section";
import { RemoveProjectSection } from "./remove-project-section";
import { Row, SettingsGroup, SettingsShell, type SettingsSection } from "./settings-shell";
import { useSectionFromUrl } from "./use-section-from-url";

const api = createEngineApi();

const SECTIONS: SettingsSection[] = [
  { id: "mcp", label: "MCP servers", icon: WrenchIcon, group: "This project" },
  { id: "data-science", label: "Data science", icon: FlaskConicalIcon, group: "This project" },
  { id: "latex", label: "LaTeX", icon: SigmaIcon, group: "This project" },
  { id: "project", label: "Project", icon: FolderGitIcon, group: "This project" },
];

const SECTION_IDS = SECTIONS.map((section) => section.id);

export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  // Already opens on MCP servers, but a sign-in returning here still names the
  // section — so the redirect is identical for both scopes.
  const [active, setActive] = useSectionFromUrl("mcp", SECTION_IDS);
  const [project, setProject] = useState<Project>();
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      const answer = await api.projects();
      const found = answer.projects.find((entry) => entry.id === projectId);
      setProject(found);
      setMissing(!found);
    } catch {
      setMissing(true);
    }
  }, [projectId]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  return (
    <SettingsShell
      title={project?.name ?? "Project"}
      subtitle="Project settings"
      sections={SECTIONS}
      active={active}
      onSelect={setActive}
      // Back to this project's composer. It was `/projects` — a table that no
      // longer exists, and would have been a dead link.
      backHref={canvasHref(projectId)}
    >
      {missing && (
        <SettingsGroup title="Not registered">
          <Row
            icon={CircleAlertIcon}
            label="No project with that id"
            hint="It may have been unregistered, or the engine is not answering."
            control={<Badge variant="outline">Unknown</Badge>}
          />
        </SettingsGroup>
      )}

      {active === "mcp" &&
        // WAITS FOR THE PROJECT rather than rendering with a placeholder name.
        // The pane's copy states which project a server will belong to, and a
        // sentence naming the wrong project — or none — is worse than a beat of
        // nothing, because a server written into the wrong scope is invisible
        // until a different repo grows a tool it never asked for.
        (project ? (
          <McpSection scope={{ projectId: project.id, projectName: project.name }} />
        ) : (
          <SettingsGroup title="MCP servers">
            <Row label="Loading" control={<Badge variant="outline">…</Badge>} />
          </SettingsGroup>
        ))}

      {active === "data-science" &&
        (project ? (
          <DataScienceSection project={project} onChange={setProject} />
        ) : (
          <SettingsGroup title="Data science">
            <Row label="Loading" control={<Badge variant="outline">…</Badge>} />
          </SettingsGroup>
        ))}

      {active === "latex" &&
        (project ? (
          <LatexSection project={project} onChange={setProject} />
        ) : (
          <SettingsGroup title="LaTeX">
            <Row label="Loading" control={<Badge variant="outline">…</Badge>} />
          </SettingsGroup>
        ))}

      {active === "project" && (
        <SettingsGroup title="Identity" description="Registered facts — moving a project means registering it again.">
          <Row label="Name" control={<span className="text-xs">{project?.name ?? "—"}</span>} />
          <Row
            label="Checkout"
            hint="Sessions run here, or in a worktree cut from it."
            control={<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">{project?.root ?? "—"}</code>}
          />
          <Row label="Id" hint="What sessions and MCP servers store." control={<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">{projectId}</code>} />
        </SettingsGroup>
      )}

      {/* BENEATH THE IDENTITY IT FORGETS, and rendered even while the project
          is still loading — the button is disabled until it arrives, so the
          action is discoverable on the pane it belongs to rather than
          appearing a beat later. */}
      {active === "project" && !missing && <RemoveProjectSection project={project} />}
    </SettingsShell>
  );
}
