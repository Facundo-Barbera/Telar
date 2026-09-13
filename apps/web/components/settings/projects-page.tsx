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
 * WHAT IS INERT, AND WHY. Only two things now: a scope with no project named,
 * and a project registered on ANOTHER MAC. Four of these rows used to be inert
 * at every scope because the engine had nowhere to put them — `PATCH
 * /v2/projects/:id` took plugin switches and nothing else — and that is the gap
 * #308 closed. The reasons that remain are the two honest ones, and they still
 * leave the control VISIBLE and inert rather than removing it (`Row`'s
 * `unavailable`, see settings-shell.tsx).
 *
 * EVERY ROW HERE SAVES ON INTERACTION AND TAKES THE ENGINE'S ANSWER AS THE
 * STATE — the two rules every settings pane follows. The text rows commit on
 * blur rather than per keystroke, because each commit is an HTTP write.
 *
 * ABSENCE IS A VALUE ON TWO OF THEM. A project with no `defaultModel` and no
 * `envMode` FOLLOWS THIS MAC, and that is a different answer from any value
 * either could hold — so both controls offer a way back to it (the revert arrow
 * on the model row, the first segment on the workspace one) and both write
 * `null`, which is what the engine reads as "remove the stored answer".
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
import type { EnvMode, ModelSelection, PluginStatus, Project, ProviderDriverKind, ProviderInstance } from "@telar/engine-client";
import { defaultInstanceIdForDriver, pluginEnabled, readProjectPlugins } from "@telar/engine-client";
import type { PublicHost } from "@/lib/hosts/store";
import type { ModelChoice } from "@/lib/models";
import { createEngineApi } from "@/lib/engine/client";
import { hostFetcher } from "@/lib/hosts/client";
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
import { enablePatch, projectPluginSections } from "@/lib/plugins/sections";
import { useSessionDefaults } from "@/lib/session-defaults";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentControl } from "@/components/composer-controls";
import { ProjectAvatar } from "@/components/projects/project-avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RemoveProjectSection } from "./remove-project-section";
import { Row, Segmented, SettingsGroup, ToggleRow } from "./settings-shell";

const api = createEngineApi();

/**
 * Everything a per-project row needs to write, in one prop rather than four.
 *
 * `save` HANDS BACK THE ENGINE'S RECORD, never the patch it sent: a row that
 * advanced its own state on the request would show a value the engine refused.
 * `busy` and `error` belong to the LAST write and are rendered by whichever row
 * made it, which is why the key is a field name.
 */
type ProjectWriter = {
  save: (field: string, patch: ProjectPatch) => void;
  busy?: string;
  error?: { field: string; message: string };
};

type ProjectPatch = Parameters<typeof api.updateProject>[1];

/**
 * WHY A ROW MAY NOT WRITE, or `undefined` when it may. Two reasons, and both
 * are properties of the SCOPE rather than of the row — which is why this is one
 * function the rows call rather than a prop the pane passes down. A row asked
 * to render without a project (its test does exactly that) must go inert on its
 * own, not because a writer happened to be withheld.
 *
 * A REMOTE PROJECT IS READ-ONLY: the patch would have to go to that Mac's
 * engine and this pane's `api` is this one's. Rather than write to the wrong
 * registry, the row says where to go.
 */
function blockedReason(project: ScopedProject | undefined, what: string): string | undefined {
  if (!project) return `Select a project to ${what}.`;
  if (project.hostId) return `Registered on ${project.hostName ?? "another Mac"}. Change it in that Mac's own settings.`;
  return undefined;
}

/** The Segmented value for "no per-project answer" — a project that follows
 *  this Mac. base-ui and `Segmented` both want a string, and absence is a real
 *  choice here rather than the lack of one. */
const FOLLOW_MAC = "__follow-mac";

/**
 * An input that reports on BLUR, not on every keystroke — the same shape
 * `provider-instance-card.tsx` uses, and for its reason: every commit is an HTTP
 * write, so a controlled input wired straight to the patch would write once per
 * character and the last few would race. Uncontrolled against a `key` derived
 * from the stored value, so an edit the engine refused snaps back to what was
 * actually kept rather than lingering on screen as though it had saved.
 */
function BlurInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (next: string) => void } & Omit<React.ComponentProps<"input">, "value" | "onChange" | "onBlur">) {
  const [draft, setDraft] = useState(value);
  return (
    <Input
      {...rest}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

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
export function ProjectIdentityRows({ project, writer }: { project?: ScopedProject; writer?: ProjectWriter }) {
  const errorFor = (field: string) => (writer?.error?.field === field ? writer.error.message : undefined);
  const savingFor = (field: string) => (writer?.busy === field ? <Badge variant="outline">Saving</Badge> : undefined);

  return (
    <SettingsGroup title="Identity" description="What this project is called, and the mark it wears in the rail.">
      <Row
        label="Name"
        icon={FolderKanbanIcon}
        hint="What the rail, the pickers and every session header call it. The folder on disk is not renamed."
        {...(savingFor("name") ? { status: savingFor("name") } : {})}
        {...(errorFor("name") ? { error: errorFor("name") } : {})}
        control={
          // KEYED BY THE STORED NAME so a refused rename snaps back to what the
          // engine actually kept — see `BlurInput`.
          <BlurInput
            key={project?.name ?? ""}
            className="h-8 w-56 text-xs"
            aria-label="Project name"
            value={project?.name ?? ""}
            onCommit={(next) => writer?.save("name", { name: next })}
          />
        }
        {...(blockedReason(project, "rename it") ? { unavailable: { reason: blockedReason(project, "rename it")! } } : {})}
      />
      <Row
        label="Icon"
        icon={ImageIcon}
        /*
          TWO ANSWERS, AND THE ROW SAYS WHICH IT IS SHOWING. A checkout's own
          icon is found rather than chosen (a favicon, an app icon, a
          `.telar/icon.*`), and a mark typed here OUTRANKS it — which is the
          point of being able to type one at all. So the sentence changes with
          what is actually stored rather than describing both states at once.
        */
        hint={
          project?.iconEmoji
            ? "Your mark, which beats whatever icon the checkout carries. Clear it to go back to the file."
            : "Type a character to mark this project. Left empty, the rail uses an icon found in the checkout — a favicon, an app icon, or .telar/icon.*."
        }
        {...(savingFor("iconEmoji") ? { status: savingFor("iconEmoji") } : {})}
        {...(errorFor("iconEmoji") ? { error: errorFor("iconEmoji") } : {})}
        {...(project?.iconEmoji ? { onRevert: () => writer?.save("iconEmoji", { iconEmoji: null }) } : {})}
        control={
          <div className="flex items-center gap-2">
            {project ? (
              <ProjectAvatar
                name={project.name}
                projectId={project.id}
                {...(project.icon ? { icon: project.icon } : {})}
                {...(project.iconEmoji ? { iconEmoji: project.iconEmoji } : {})}
                size={20}
              />
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
            <BlurInput
              key={project?.iconEmoji ?? ""}
              className="h-8 w-16 text-center text-xs"
              aria-label="Project mark"
              placeholder="🧵"
              maxLength={16}
              value={project?.iconEmoji ?? ""}
              // An emptied field is a CLEAR, not an empty string: the engine
              // reads `null` as "remove the stored answer" and would refuse "".
              onCommit={(next) => writer?.save("iconEmoji", { iconEmoji: next.trim() === "" ? null : next.trim() })}
            />
          </div>
        }
        {...(blockedReason(project, "mark it") ? { unavailable: { reason: blockedReason(project, "mark it")! } } : {})}
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
 * WHAT A CONVERSATION IN THIS PROJECT OPENS ON.
 *
 * BOTH ROWS HAVE THREE STATES, NOT TWO, and the third is the interesting one:
 * a project can store an answer, or store NOTHING and follow this Mac. Absence
 * is what the engine reads as "follow", so neither control may collapse it into
 * a value — the workspace row gives it a segment of its own and the model row
 * gives it the revert arrow, and both write `null` to get back to it.
 *
 * `envMode` IS THE MACHINE'S STANDING ANSWER, passed in so the inherited state
 * can SAY what it inherits rather than showing an em dash. A reader looking at
 * "This Mac's answer" is owed the value that phrase resolves to.
 */
export function ProjectConversationRows({
  project,
  envMode,
  instances,
  writer,
}: {
  project?: ScopedProject;
  envMode: EnvMode;
  /** The configured logins, so the model picker can name the one a stored
   *  selection routes to. Absent until the engine has answered once. */
  instances?: ProviderInstance[];
  writer?: ProjectWriter;
}) {
  const stored = project?.defaultModel;
  /**
   * WHICH PROVIDER THE PICKER IS SHOWING. Seeded from the stored selection's
   * own login, because that is the only thing that can say which provider a
   * stored `{instanceId, model}` belongs to — an instance id is a slug, and
   * only the registry maps it back to a driver. Claude when nothing is stored,
   * which is the driver `createSession` falls back to as well.
   */
  const storedDriver = instances?.find((instance) => instance.id === stored?.instanceId)?.driver;
  const [picked, setPicked] = useState<ProviderDriverKind>();
  const driver = picked ?? storedDriver ?? "claude";
  const choice: ModelChoice = {
    ...(stored?.model ? { model: stored.model } : {}),
    ...(stored?.effort ? { effort: stored.effort } : {}),
    ...(stored?.fastMode !== undefined ? { fastMode: stored.fastMode } : {}),
  };

  /**
   * A SELECTION THAT SELECTS NOTHING IS AN ABSENT SELECTION — the contract says
   * so and refuses one — so clearing every field here is a `null`, which is the
   * same sentence the revert arrow writes.
   */
  const commitModel = (next: ModelChoice) => {
    const named = next.model !== undefined || next.effort !== undefined || next.fastMode !== undefined;
    if (!named) return writer?.save("defaultModel", { defaultModel: null });
    // The stored login when it is still this driver's, else this driver's own
    // default slot — a Claude selection must never keep a Codex instance id.
    const instanceId = storedDriver === driver && stored ? stored.instanceId : defaultInstanceIdForDriver(driver);
    const selection = {
      instanceId,
      ...(next.model !== undefined ? { model: next.model } : {}),
      ...(next.effort !== undefined ? { effort: next.effort } : {}),
      ...(next.fastMode !== undefined ? { fastMode: next.fastMode } : {}),
    } as ModelSelection;
    writer?.save("defaultModel", { defaultModel: selection });
  };

  const errorFor = (field: string) => (writer?.error?.field === field ? writer.error.message : undefined);
  const savingFor = (field: string) => (writer?.busy === field ? <Badge variant="outline">Saving</Badge> : undefined);

  return (
    <SettingsGroup title="New conversations" description="What a conversation in this project is built with before you change it.">
      <Row
        label="Default model"
        icon={SparklesIcon}
        hint={
          stored
            ? "Conversations in this project open on this. The composer still overrides it for the one in front of you."
            : "Nothing stored, so a conversation opens on the provider's own default. Pick one to make this project differ."
        }
        {...(savingFor("defaultModel") ? { status: savingFor("defaultModel") } : {})}
        {...(errorFor("defaultModel") ? { error: errorFor("defaultModel") } : {})}
        {...(stored ? { onRevert: () => writer?.save("defaultModel", { defaultModel: null }) } : {})}
        control={
          <AgentControl
            driver={driver}
            choice={choice}
            {...(stored?.instanceId && storedDriver === driver ? { instanceId: stored.instanceId } : {})}
            onChange={commitModel}
            onDriverChange={setPicked}
          />
        }
        {...(blockedReason(project, "set the model its conversations open on") ? { unavailable: { reason: blockedReason(project, "set the model its conversations open on")! } } : {})}
      />
      <Row
        label="Where new conversations start"
        icon={FolderGitIcon}
        hint={
          project?.envMode === undefined
            ? `Following this Mac, which says ${envMode === "worktree" ? "each session gets its own checkout" : "sessions share the project's checkout"}. Change that on General ▸ Workspace, or pin an answer here.`
            : project.envMode === "worktree"
              ? "Each session here gets its own checkout and branch, whatever this Mac says. A project without git falls back to the checkout."
              : "Sessions here share the project's checkout, whatever this Mac says. Two at once will collide."
        }
        {...(savingFor("envMode") ? { status: savingFor("envMode") } : {})}
        {...(errorFor("envMode") ? { error: errorFor("envMode") } : {})}
        control={
          <Segmented<string>
            value={project?.envMode ?? FOLLOW_MAC}
            onChange={(next) => writer?.save("envMode", { envMode: next === FOLLOW_MAC ? null : (next as EnvMode) })}
            options={[
              { value: FOLLOW_MAC, label: "Follow the Mac" },
              { value: "local", label: "Project checkout" },
              { value: "worktree", label: "Own worktree" },
            ]}
          />
        }
        {...(blockedReason(project, "say where its conversations start") ? { unavailable: { reason: blockedReason(project, "say where its conversations start")! } } : {})}
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
  const [instances, setInstances] = useState<ProviderInstance[]>();
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<{ field: string; message: string }>();
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
        // WHICH LOGINS EXIST, so the model row can map a stored selection's
        // instance id back to the provider it belongs to. Never fatal: with no
        // answer the picker opens on Claude, which is where the engine's own
        // fallback lands too.
        setInstances(await api.providerInstances().then((answer) => answer.providerInstances).catch(() => []));
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

  /**
   * ONE WRITER FOR EVERY IDENTITY ROW, and the reason it is one rather than four
   * hooks is the same reason `ProjectPluginRows` keeps one `busy`: only one of
   * these rows is ever mid-write, and the row that made the last write is the
   * one that has to say what happened to it.
   *
   * THE STATE ADVANCES ON THE ENGINE'S OWN RECORD (`replaceProject`), never on
   * the patch — a control that moved on the request would show a value the
   * engine refused, which is exactly what `Row`'s `error` slot exists to make
   * impossible.
   *
   * A REMOTE PROJECT IS READ-ONLY HERE, for `ProjectPluginRows`' reason: the
   * patch would have to go to that Mac's engine and this pane's `api` is this
   * one's. Rather than write to the wrong registry, the rows say where to go.
   */
  const writer: ProjectWriter = {
    ...(busy ? { busy } : {}),
    ...(error ? { error } : {}),
    save: (field, patch) => {
      if (!project || project.hostId) return;
      setBusy(field);
      setError(undefined);
      void api
        .updateProject(project.id, patch)
        .then((answer) => replaceProject(answer.project))
        .catch((cause) => setError({ field, message: cause instanceof Error ? cause.message : String(cause) }))
        .finally(() => setBusy(undefined));
    },
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

      <ProjectIdentityRows {...(project ? { project } : {})} writer={writer} />
      <ProjectConversationRows
        {...(project ? { project } : {})}
        envMode={defaults.envMode}
        {...(instances ? { instances } : {})}
        writer={writer}
      />
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
