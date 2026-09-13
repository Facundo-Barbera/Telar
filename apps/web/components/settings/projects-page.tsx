"use client";

/**
 * EVERY PROJECT THIS COCKPIT KNOWS, ON ONE PANE, WITH A SCOPE BAR AT THE TOP.
 *
 * WHY A SCOPE BAR RATHER THAN A LIST OF PROJECTS. A registry with five entries
 * rendered as five collapsible blocks is a pane whose length is a property of
 * somebody's disk, and the reader is looking for ONE project's setting. So the
 * pane holds one project's rows at a time and the bar says which — the Mac on
 * the left, the project on the right, above the first card. The rows below
 * never move.
 *
 * THE BAR IS NOT A CARD, and that is the point of it. It was two rows in a
 * "Scope" group, which framed the control that decides what the pane is ABOUT
 * identically to the settings it governs: the first card read as the first
 * group, and the picker read as one more setting to configure.
 *
 * "ALL PROJECTS" IS A REAL CHOICE, NOT AN EMPTY ONE, and it is where the pane
 * opens. It is what a reader sees before they have named a project, and every
 * per-project row stays VISIBLE and goes inert with a sentence saying which
 * choice would make it answer (`Row`'s `unavailable`, see settings-shell.tsx).
 * A row that vanished until a project was picked would teach nobody that the
 * setting exists; a row that stayed live would apply somebody's change to a
 * project they never named.
 *
 * WHAT IS INERT AT BOTH SCOPES, AND WHY IT IS STILL HERE. Four of these rows
 * have no write path in today's engine: `PATCH /v2/projects/:id` takes plugin
 * switches and nothing else, so a project's NAME and ICON are facts of its
 * registration and its checkout, and there is no per-project default model or
 * workspace mode stored anywhere. Those rows render the true value with the
 * true reason in the hint slot rather than a control that would silently do
 * nothing. The scope selector still changes what they SAY: at All projects the
 * reason is "pick one", at one project it is why the engine cannot store it.
 * When the engine grows those fields the reasons come off and the controls go
 * live; nothing else here moves.
 *
 * THE PLUGIN TOGGLES ARE THE WORKING HALF, and they are the same write
 * `project-settings-page.tsx` makes — one project's opt-in switches, through
 * the generic plugin arm.
 *
 * THE PER-PROJECT PAGE IS NOT REPLACED. `/projects/:id/settings` keeps its own
 * shell, its MCP scope and every plugin's bespoke editor; this pane links to it
 * rather than trying to nest a settings shell inside a settings shell.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BlocksIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  FolderGitIcon,
  FolderKanbanIcon,
  ImageIcon,
  MonitorIcon,
  SparklesIcon,
} from "lucide-react";
import type { EnvMode, PluginStatus, Project } from "@telar/engine-client";
import { pluginEnabled, readProjectPlugins } from "@telar/engine-client";
import type { PublicHost } from "@/lib/hosts/store";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher } from "@/lib/hosts/client";
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
import { enablePatch, projectPluginSections } from "@/lib/plugins/sections";
import { useSessionDefaults } from "@/lib/session-defaults";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RemoveProjectSection } from "./remove-project-section";
import { Row, Segmented, SettingsGroup, ToggleRow } from "./settings-shell";

const api = createEngineApi();

/** The Select's value for "no project named". base-ui refuses `""`, and the
 *  sentinel keeps the All-projects scope a value rather than an absence. */
const ALL_PROJECTS = "__all-projects";

/** One project, plus the Mac it is registered on when that is not this one. */
export type ScopedProject = Project & { hostId?: string; hostName?: string };

/**
 * THE PER-PROJECT ROWS, taking the project as a prop rather than fetching —
 * so the two states this pane exists to distinguish can both be rendered, by
 * the pane and by its test, without a network.
 */
export function ProjectIdentityRows({ project }: { project?: ScopedProject }) {
  return (
    <SettingsGroup title="Identity" description="What this project is called, and the mark it wears in the rail.">
      <Row
        label="Name"
        icon={FolderKanbanIcon}
        control={<span className="text-xs text-muted-foreground">{project?.name ?? "—"}</span>}
        unavailable={{
          reason: project
            ? "Set when the folder was registered. The engine has no rename yet — registering the same folder again keeps this name."
            : "Select a project to see its name.",
        }}
      />
      <Row
        label="Icon"
        icon={ImageIcon}
        control={
          project ? (
            <ProjectAvatar
              name={project.name}
              projectId={project.id}
              {...(project.icon ? { icon: project.icon } : {})}
              size={20}
            />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )
        }
        unavailable={{
          reason: project
            ? "Found in the checkout — a favicon, an app icon, or .telar/icon.*. Replace that file and the rail follows it."
            : "Select a project to see its icon.",
        }}
      />
      {project && (
        <Row
          label="Checkout"
          icon={FolderGitIcon}
          hint="Sessions run here, or in a worktree cut from it."
          control={<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">{project.root}</code>}
        />
      )}
    </SettingsGroup>
  );
}

/**
 * WHAT A CONVERSATION IN THIS PROJECT OPENS ON. Both rows are inert today and
 * both say why in their own sentence — see the file comment. The workspace row
 * shows the MACHINE's standing answer, because that is the value a new session
 * here will actually be built with, and naming a value the reader can go and
 * change is more use than an em dash.
 */
export function ProjectConversationRows({ project, envMode }: { project?: ScopedProject; envMode: EnvMode }) {
  return (
    <SettingsGroup title="New conversations" description="What a conversation in this project is built with before you change it.">
      <Row
        label="Default model"
        icon={SparklesIcon}
        control={<Badge variant="outline">Last used</Badge>}
        unavailable={{
          reason: project
            ? "A conversation opens on the model you last chose. The engine stores no per-project default yet."
            : "Select a project to set the model its conversations open on.",
        }}
      />
      <Row
        label="Where new conversations start"
        icon={FolderGitIcon}
        control={
          <Segmented<EnvMode>
            value={envMode}
            onChange={() => undefined}
            options={[
              { value: "local", label: "Project checkout" },
              { value: "worktree", label: "Own worktree" },
            ]}
          />
        }
        unavailable={{
          reason: project
            ? "This Mac's standing answer, shown because it is what a session here is built with. Change it on General ▸ Workspace; it is not stored per project yet."
            : "Select a project to see where its conversations start.",
        }}
      />
    </SettingsGroup>
  );
}

/**
 * ONE SWITCH PER PLUGIN, for the named project — the same write the project's
 * own page makes, and the only rows on this pane that change anything.
 *
 * A REMOTE PROJECT'S SWITCHES ARE READ-ONLY HERE. The patch would have to go to
 * that Mac's engine, and this pane's `api` is this one's; rather than write to
 * the wrong registry the row says where to go. Turning a plugin on for a
 * project on the mini is done on the mini.
 */
export function ProjectPluginRows({
  project,
  plugins,
  onChange,
}: {
  project?: ScopedProject;
  plugins?: PluginStatus[];
  onChange?: (project: Project) => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const entries = useMemo(() => projectPluginSections(plugins), [plugins]);
  const remote = Boolean(project?.hostId);

  const toggle = async (pluginId: string, next: boolean) => {
    if (!project) return;
    setBusy(pluginId);
    setError(undefined);
    try {
      const answer = await api.updateProject(project.id, enablePatch(pluginId, next));
      onChange?.(answer.project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  // Nothing registered: one row that says so, rather than a heading over air.
  const shown = entries.length > 0 ? entries : undefined;

  return (
    <SettingsGroup title="Plugins" description="Which of this Mac's plugins this project has opted into.">
      {!shown && <Row icon={BlocksIcon} label="No plugins registered" control={<Badge variant="outline">None</Badge>} />}
      {shown?.map((entry) => {
        const failed = entry.state === "failed";
        const reason = !project
          ? `Select a project to turn ${entry.label} on for it.`
          : remote
            ? `Registered on ${project?.hostName ?? "another Mac"}. Change it in that Mac's own settings.`
            : failed
              ? (entry.error ?? "This plugin did not start, so turning it on would do nothing.")
              : undefined;
        return (
          <ToggleRow
            key={entry.key}
            label={entry.label}
            icon={BlocksIcon}
            hint={entry.blurb ?? "Sessions in this project get its tools; turning it off lets running work finish."}
            checked={project ? pluginEnabled(readProjectPlugins(project).plugins, entry.pluginId) : false}
            onCheckedChange={(next) => void toggle(entry.pluginId, next)}
            {...(busy === entry.pluginId ? { status: <Badge variant="outline">Saving</Badge> } : {})}
            {...(reason ? { unavailable: { reason } } : {})}
          />
        );
      })}
      {error && <Row icon={CircleAlertIcon} label="Could not save" hint={error} control={<Badge variant="outline">Error</Badge>} />}
    </SettingsGroup>
  );
}

export function ProjectsPage() {
  const [hosts, setHosts] = useState<PublicHost[]>([]);
  const [hostId, setHostId] = useState<string>(LOCAL_HOST_ID);
  const [byHost, setByHost] = useState<Record<string, ScopedProject[]>>({});
  const [selected, setSelected] = useState<string>(ALL_PROJECTS);
  const [plugins, setPlugins] = useState<PluginStatus[]>();
  const [unreachable, setUnreachable] = useState(false);
  const { defaults } = useSessionDefaults();

  const projects = byHost[hostId] ?? [];
  const project = projects.find((entry) => entry.id === selected);

  const loadHost = useCallback(async (id: string) => {
    // ALWAYS AN EXPLICIT HOST, including the local one — the same rule the rail
    // follows: a pathname-following fetcher reads whichever engine the current
    // URL names, which is the wrong one while looking at a remote Mac.
    const hostApi = createEngineApi(hostFetcher(id));
    const answer = await hostApi.projects();
    return answer.projects;
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void (async () => {
        // The book first, and never fatal: a cockpit with no paired Mac is the
        // ordinary one, and its scope row is just "This Mac".
        const book = await api
          .hosts()
          .then((answer) => answer.hosts)
          .catch(() => [] as PublicHost[]);
        setHosts(book);
        try {
          setByHost({ [LOCAL_HOST_ID]: await loadHost(LOCAL_HOST_ID) });
          setUnreachable(false);
        } catch {
          setUnreachable(true);
        }
        // WHICH PLUGINS EXIST is this Mac's answer. A project on another Mac
        // still lists them, and says so rather than offering a write.
        setPlugins(await api.health().then((health) => health.plugins ?? []).catch(() => []));
      })();
    }, 0);
    return () => window.clearTimeout(task);
  }, [loadHost]);

  /**
   * A REMOTE MAC'S REGISTRY IS READ WHEN IT IS ASKED FOR, not on mount. Pairing
   * three Macs would otherwise cost three requests to open a pane whose reader
   * is almost always looking at this one.
   */
  useEffect(() => {
    if (hostId === LOCAL_HOST_ID || byHost[hostId]) return;
    const task = window.setTimeout(() => {
      void loadHost(hostId)
        .then((found) => {
          const host = hosts.find((entry) => entry.id === hostId);
          setByHost((current) => ({
            ...current,
            [hostId]: found.map((entry) => ({ ...entry, hostId, ...(host ? { hostName: host.name } : {}) })),
          }));
        })
        .catch(() => setByHost((current) => ({ ...current, [hostId]: [] })));
    }, 0);
    return () => window.clearTimeout(task);
  }, [hostId, byHost, hosts, loadHost]);

  /**
   * `?project=<id>` OPENS THE PANE ON ONE PROJECT, which is what makes a link
   * from anywhere that already knows a project id land somewhere useful. Read
   * in a deferred effect for the reason `use-section-from-url.ts` gives: this
   * renders on the server first, and seeding from `window.location` would make
   * the two disagree about the same markup.
   */
  useEffect(() => {
    const task = window.setTimeout(() => {
      const named = new URLSearchParams(window.location.search).get("project");
      if (named) setSelected(named);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const replaceProject = (next: Project) => {
    setByHost((current) => ({
      ...current,
      [hostId]: (current[hostId] ?? []).map((entry) => (entry.id === next.id ? { ...entry, ...next } : entry)),
    }));
  };

  return (
    <>
      {/*
        THE SCOPE IS A BAR, NOT A GROUP OF ROWS.

        It was two `Row`s in a "Scope" card, which put the thing that decides
        what the whole pane is ABOUT inside the same frame as the settings it
        governs — the first card read as the first group, and a reader looking
        for the project picker had to work out that one of these rows was not a
        setting. The reference puts both controls on their own line above the
        first card (`docs/design/t3code-survey/08-settings-projects.png`):
        machine on the left, project on the right, and the rows below bind to
        whatever they say.

        `justify-between` with no left-hand control still pushes the picker
        right, which is where it belongs on a cockpit with no paired Mac — so
        the common case needs no branch of its own.
      */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* ONLY WHEN THERE IS A CHOICE. A one-segment control is a button that
            does nothing, and a cockpit with no paired Mac is the common one. */}
        {hosts.length > 0 && (
          <Segmented<string>
            value={hostId}
            onChange={(next) => {
              setHostId(next);
              setSelected(ALL_PROJECTS);
            }}
            options={[
              { value: LOCAL_HOST_ID, label: "This Mac" },
              ...hosts.map((host) => ({
                value: host.id,
                label: (
                  <>
                    <MonitorIcon className="size-3" />
                    {host.name}
                  </>
                ),
              })),
            ]}
          />
        )}
        <Select value={selected} onValueChange={(next) => typeof next === "string" && setSelected(next)}>
          <SelectTrigger size="sm" className="ml-auto w-56" aria-label="Project these settings are about">
            <FolderKanbanIcon className="size-3.5 shrink-0 text-muted-foreground" />
            {/*
              THE LABEL, NOT THE VALUE (#318). A bare `<SelectValue />` renders
              the value string when the Select has no item-to-label mapping,
              so the trigger read `__all-projects` and then a project id — the
              list beside it having shown the right names all along.

              Stated as a CHILD rather than passed as `items`, because the id
              may name a project this Mac's registry has not answered with yet:
              `?project=` is read on the first paint and a remote Mac's list
              arrives a request later. A mapping would fall back to printing
              the id in exactly that window; this says what the rows below say.
            */}
            <SelectValue>
              {selected === ALL_PROJECTS ? "All projects" : (project?.name ?? "Select a project")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
            {projects.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* The one thing the picker cannot say for itself: an empty list because
          nothing answered is not the same as an empty registry. */}
      {unreachable && (
        <p className="-mt-4 mb-6 text-xs text-muted-foreground">The engine is not answering, so there is nothing to choose from.</p>
      )}

      <ProjectIdentityRows {...(project ? { project } : {})} />
      <ProjectConversationRows {...(project ? { project } : {})} envMode={defaults.envMode} />
      <ProjectPluginRows {...(project ? { project } : {})} {...(plugins ? { plugins } : {})} onChange={replaceProject} />

      {/* WHAT IS LEFT ON THE PER-PROJECT PAGE, AND ONLY THAT. It used to be
          offered as "everything this pane does not hold"; the pane holds the
          identity, the conversation defaults and the plugin switches now, so
          the page is the destination for the two things that cannot be rows
          here — MCP servers scoped to the project, and each plugin's own
          bespoke editor. There is no `/hosts/:id/projects/:id/settings` route,
          so a project on another Mac says so rather than offering a link that
          would open this Mac's page for a foreign id. */}
      {project && (
        <SettingsGroup title="Elsewhere">
          <Row
            label="This project's own page"
            icon={ExternalLinkIcon}
            control={
              project.hostId ? (
                <Badge variant="outline">On {project.hostName ?? "another Mac"}</Badge>
              ) : (
                <Button variant="outline" size="sm" render={<a href={`/projects/${encodeURIComponent(project.id)}/settings`} />}>
                  Open
                </Button>
              )
            }
            {...(project.hostId
              ? { unavailable: { reason: "Open it in that Mac's own cockpit — this route names projects on this Mac only." } }
              : { hint: "MCP servers scoped to it, and each plugin's own editor. Everything else about this project is on this pane." })}
          />
        </SettingsGroup>
      )}

      {/* THE DANGER GROUP IS LAST, AND ONLY FOR A PROJECT ON THIS MAC. Removing
          a registration on another Mac would be a write to its engine; the
          section is the project's own page's, unchanged. */}
      {project && !project.hostId && <RemoveProjectSection key={project.id} project={project} onChange={replaceProject} />}
    </>
  );
}
