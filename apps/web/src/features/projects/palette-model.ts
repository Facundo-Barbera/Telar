import { BoxesIcon, CloudIcon, FolderOpenIcon, GitBranchIcon, LinkIcon, ServerIcon } from "lucide-react";

export type NewConversationTarget = {
  id: string;
  name: string;
  icon?: string;
  iconName?: string;
  hostId?: string;
  hostName?: string;
  root?: string;
};

export type PalettePage = "projects" | "sources";

export const QUICK_PICK_LIMIT = 9;

export function targetPlace(target: NewConversationTarget): string {
  const where = target.hostName ?? "Local";
  return target.root ? `${where} · ${target.root}` : where;
}

export function matchTargets(targets: readonly NewConversationTarget[], query: string): NewConversationTarget[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...targets];
  return targets.filter((target) => `${target.name} ${targetPlace(target)}`.toLocaleLowerCase().includes(needle));
}

export type ProjectSource = {
  id: string;
  title: string;
  hint: string;
  icon: typeof FolderOpenIcon;
  setupRequired?: true;
  clones?: true;
};

export const PROJECT_SOURCES: ProjectSource[] = [
  { id: "local", title: "Local folder", hint: "Browse a folder on disk", icon: FolderOpenIcon },
  { id: "git-url", title: "Git URL", hint: "Clone from a remote URL", icon: LinkIcon, clones: true },
  { id: "github", title: "GitHub repository", hint: "Clone GitHub owner/repo", icon: GitBranchIcon, clones: true },
  { id: "azure", title: "Azure DevOps", hint: "Clone from an Azure DevOps project", icon: CloudIcon, setupRequired: true },
  { id: "bitbucket", title: "Bitbucket", hint: "Clone from a Bitbucket workspace", icon: BoxesIcon, setupRequired: true },
  { id: "forgejo", title: "Forgejo / Gitea", hint: "Clone from a self-hosted forge", icon: ServerIcon, setupRequired: true },
];

const GIT_URL = /^(?:https?|ssh|git):\/\/\S+$/i;
const SCP_URL = /^[\w.-]+@[\w.-]+:\S+$/;
const SHORTHAND = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function cloneRequest(query: string): { source: string; url: string } | undefined {
  const url = query.trim();
  if (!url) return undefined;
  if (SHORTHAND.test(url.replace(/\.git$/, ""))) return { source: "github", url };
  if (!GIT_URL.test(url) && !SCP_URL.test(url)) return undefined;
  return { source: /github\.com/i.test(url) ? "github" : "git-url", url };
}

export function pathRequest(query: string): string | undefined {
  let text = query.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
  if (quoted) text = quoted[2]!.trim();
  if (/^file:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.host && url.host !== "localhost") return undefined;
      text = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
  }
  if (text === "~" || text.startsWith("~/") || text.startsWith("/")) return text;
  return undefined;
}

export function sourceRows(query: string, sources: readonly ProjectSource[] = PROJECT_SOURCES): ProjectSource[] {
  const clone = cloneRequest(query);
  if (clone) {
    const row = sources.find((source) => source.id === clone.source);
    return row ? [{ ...row, hint: `Clone ${clone.url}` }] : [];
  }
  const folder = pathRequest(query);
  if (folder) {
    const row = sources.find((source) => source.id === "local");
    return row ? [{ ...row, hint: `Open ${folder}` }] : [];
  }
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...sources];
  return sources.filter((source) => `${source.title} ${source.hint}`.toLocaleLowerCase().includes(needle));
}

export function folderName(root: string): string {
  return (
    root
      .trim()
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? root
  );
}

export type Registered = { projectId: string; name: string; ignored: boolean };

export function paletteBack(page: PalettePage, query: string, root: PalettePage): PalettePage | "root" | undefined {
  if (query !== "") return undefined;
  if (page === "sources" && root !== "sources") return "projects";
  return "root";
}
