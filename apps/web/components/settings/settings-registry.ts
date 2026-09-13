/**
 * EVERY SETTING THIS COCKPIT HAS, STATED ONCE, so search can find one before
 * its pane has ever been opened.
 *
 * WHY A SECOND COPY OF THE TITLES EXISTS AT ALL. The rows themselves are React
 * trees scattered across a dozen section files, several behind a condition
 * ("After" appears only once settling is on) and several rendered from engine
 * data. Nothing can enumerate them without mounting every pane, which is
 * exactly what a person who does not know where a setting lives cannot do. So
 * the rows are DECLARED here, and `settings-registry.test.ts` is what keeps the
 * declaration honest: every title below must still appear in a section file, or
 * the test fails and names the row that moved.
 *
 * THE HINTS ARE THE STABLE HALF OF THE ROW'S OWN SENTENCE. Most rows write
 * their hint from live state — a pairing hint names the address it is reachable
 * at, a channel hint changes with the channel — and a search index cannot carry
 * a sentence that only exists after a fetch. What is here is the part that is
 * true whatever the engine answers, because the hint is matched against and
 * never displayed: a result shows the row's title and the pane it lives on.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   - THE PER-PROJECT ROUTE (`project-settings-page.tsx`). A different shell
 *     with a different nav and a project id in every route; indexing it from
 *     the machine's Settings would offer to jump somewhere this shell cannot
 *     go. The PROJECTS PANE is indexed — it lives on this shell, and its rows
 *     are copy rather than one entry per registered folder.
 *   - PLUGIN-CONTRIBUTED SECTIONS. They arrive from the engine at runtime, and
 *     a plugin does not declare searchable rows in its manifest today. The
 *     Plugins pane itself is indexed; what a plugin puts inside it is not.
 *   - ROWS BUILT FROM DATA — one per MCP server, per paired device, per
 *     provider login, per other Mac. Their titles are values, not copy, and a
 *     stale index of them would be worse than none.
 *   - THE APPEARANCE STUDIO'S OWN TOOLS (looks, themes, palette, type). That
 *     pane bypasses `Row` and `SettingsGroup` entirely — survey item #4 is the
 *     port — so there are no anchors to aim at yet. Its three real rows live
 *     behind the studio's Window tab and are indexed with that caveat: choosing
 *     one lands on Appearance, and the row it named is one tab away.
 */

import {
  BlocksIcon,
  CircleUserRoundIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderGitIcon,
  FolderKanbanIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  KeyRoundIcon,
  LockIcon,
  MonitorIcon,
  PaletteIcon,
  PlugIcon,
  PlugZapIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SparklesIcon,
  TimerIcon,
  WrenchIcon,
} from "lucide-react";
import { indexSettings, type SettingsPageSpec } from "@/lib/settings-search";

/**
 * The panes, in nav order, with the groups and rows each renders.
 *
 * PAGE IDS ARE THE SHELL'S, not new ones: choosing a result calls the same
 * `onSelect` the nav button does, so an id that drifted from `settings-page.tsx`
 * would navigate nowhere. The test pins them against that file.
 */
export const SETTINGS_SEARCH_PAGES: readonly SettingsPageSpec[] = [
  {
    id: "general",
    label: "General",
    icon: SlidersHorizontalIcon,
    groups: [
      {
        title: "New sessions",
        rows: [
          {
            title: "Workspace",
            hint: "Each session gets its own checkout and branch, or every session shares the project checkout.",
            keywords: ["worktree", "branch", "git", "isolation"],
            icon: FolderGitIcon,
          },
        ],
      },
      {
        title: "Links",
        rows: [
          {
            title: "Open in the session's browser",
            hint: "Issues and pull requests open in the right panel; other links open as tabs the agent can see.",
            keywords: ["external", "system browser", "tabs"],
            icon: ExternalLinkIcon,
          },
        ],
      },
      {
        title: "Settling",
        rows: [
          {
            title: "Settle quiet sessions",
            hint: "Off means nothing leaves the list on its own.",
            keywords: ["inbox", "archive", "auto"],
            icon: TimerIcon,
          },
          {
            title: "After",
            hint: "Time without activity. Pinned sessions and open questions stay put.",
            keywords: ["hours", "days", "window"],
            icon: TimerIcon,
          },
        ],
      },
      {
        title: "Generated text",
        rows: [
          {
            title: "Written by",
            hint: "Which provider writes the session title and branch name.",
            keywords: ["claude", "codex", "driver"],
            icon: SparklesIcon,
          },
          {
            title: "Model",
            hint: "The small model that writes titles and branch names.",
            keywords: ["title model", "textgen"],
            icon: SparklesIcon,
          },
          {
            title: "Name sessions",
            hint: "Replaces the truncated first message. A title you set yourself is never touched.",
            keywords: ["title", "rename", "automatic"],
            icon: SparklesIcon,
          },
          {
            title: "Rename branches to match",
            hint: "Only branches the engine cut. Yours keep their names.",
            keywords: ["git", "branch name"],
            icon: SparklesIcon,
          },
        ],
      },
      {
        title: "This build",
        rows: [
          { title: "Version", hint: "Which build of Telar this install is.", keywords: ["about"], icon: InfoIcon },
          {
            title: "Engine",
            hint: "Whether the thing that runs turns is answering.",
            keywords: ["daemon", "offline", "health"],
            icon: InfoIcon,
          },
          {
            title: "State",
            hint: "Sessions, transcripts, worktrees and settings.",
            keywords: ["telar home", "storage", "path"],
            icon: InfoIcon,
          },
        ],
      },
      {
        title: "Updates",
        rows: [
          {
            title: "Update status",
            hint: "Check for a new build, and install one that has been found.",
            keywords: ["upgrade", "download", "version"],
            icon: DownloadIcon,
          },
          {
            title: "Channel",
            hint: "Which stream of builds this install follows.",
            keywords: ["beta", "nightly", "stable", "release"],
            icon: DownloadIcon,
          },
          {
            title: "Install on quit",
            hint: "A downloaded update installs itself the next time you quit Telar.",
            keywords: ["restart", "automatic"],
            icon: DownloadIcon,
          },
        ],
      },
    ],
  },
  {
    /**
     * THE PANE'S ROWS ARE INDEXED; THE PROJECTS ARE NOT. A project's name is a
     * value, not copy — the note at the top of this file — and the pane holds
     * one project at a time anyway, chosen on the pane itself. What search can
     * usefully find here is the SETTING: "where do I change a project's icon",
     * "which project has LaTeX on".
     *
     * The Danger group is `remove-project-section.tsx`'s and appears only once
     * a project is named, so its row is indexed with that caveat: choosing it
     * lands on Projects, and the scope row is the step between.
     */
    id: "projects",
    label: "Projects",
    icon: FolderKanbanIcon,
    groups: [
      {
        /**
         * THE SCOPE BAR, AND IT IS NAVIGATE-ONLY. Both controls are the pane's
         * header rather than rows in a group — see `projects-page.tsx` — so
         * there is no anchor to scroll to. Indexed anyway, and without the
         * caveat the other navigate-only entries carry: the bar is the first
         * thing on the pane, so arriving at Projects puts both controls on
         * screen without a scroll.
         */
        rows: [
          {
            title: "Mac",
            hint: "Projects are registered per Mac. A paired one's registry is read from that Mac.",
            keywords: ["host", "paired", "remote", "other mac", "machine"],
            icon: MonitorIcon,
          },
          {
            title: "Project",
            hint: "All projects leaves the rows below inert; naming one binds them to it.",
            keywords: ["scope", "pick", "select", "all projects", "registry"],
            icon: FolderKanbanIcon,
          },
        ],
      },
      {
        title: "Identity",
        rows: [
          {
            title: "Name",
            hint: "Set when the folder was registered.",
            keywords: ["rename", "title", "project name"],
            icon: FolderKanbanIcon,
          },
          {
            title: "Icon",
            hint: "Found in the checkout — a favicon, an app icon, or a .telar icon file.",
            keywords: ["avatar", "favicon", "logo", "mark"],
            icon: ImageIcon,
          },
          {
            title: "Checkout",
            hint: "Sessions run here, or in a worktree cut from it.",
            keywords: ["root", "path", "folder", "directory"],
            icon: FolderGitIcon,
          },
        ],
      },
      {
        title: "New conversations",
        rows: [
          {
            title: "Default model",
            hint: "Which model a conversation in this project opens on.",
            keywords: ["model", "per project", "default"],
            icon: SparklesIcon,
          },
          {
            title: "Where new conversations start",
            hint: "The project's own checkout, or a worktree cut from it.",
            keywords: ["worktree", "checkout", "workspace", "branch"],
            icon: FolderGitIcon,
          },
        ],
      },
      {
        title: "Elsewhere",
        rows: [
          {
            title: "This project's own page",
            hint: "MCP servers scoped to it, and each plugin's own editor.",
            keywords: ["mcp", "plugin editor", "per project", "latex", "notebook"],
            icon: ExternalLinkIcon,
          },
        ],
      },
      {
        // THE PLUGIN TOGGLES ARE NOT INDEXED, and that is the rule at the top
        // of this file rather than an omission: each row's title is a
        // plugin's own name, arriving from the engine at runtime.
        title: "Danger",
        rows: [
          {
            title: "Remove project from Telar",
            hint: "Put the registration away. Nothing on disk is touched, and it can be restored.",
            keywords: ["unregister", "delete", "forget", "put away"],
            icon: FolderKanbanIcon,
          },
        ],
      },
    ],
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: PaletteIcon,
    groups: [
      {
        // The studio's Window tool. No group wraps these — they sit in a Panel —
        // so their ids are pane and label only, which is what `Row` derives there.
        rows: [
          {
            title: "Translucency",
            hint: "Rebuilds the window. The macOS desktop app only.",
            keywords: ["glass", "blur", "vibrancy", "transparent"],
            icon: MonitorIcon,
          },
          { title: "Glass", hint: "Blur or clear, behind a translucent window.", keywords: ["frost", "blur"], icon: MonitorIcon },
          {
            title: "Show-through",
            hint: "The desktop behind a translucent window, and the backdrop under the app.",
            keywords: ["opacity", "wallpaper", "backdrop"],
            icon: MonitorIcon,
          },
        ],
      },
    ],
  },
  {
    id: "remote",
    label: "Remote access",
    icon: SmartphoneIcon,
    groups: [
      {
        title: "Pairing",
        rows: [
          {
            title: "Require pairing",
            hint: "Unpaired devices are refused. Off, anything that can reach this address has full control.",
            keywords: ["auth", "security", "phone", "ipad"],
            icon: SmartphoneIcon,
          },
        ],
      },
      {
        title: "This environment",
        rows: [
          {
            title: "Network access",
            hint: "Listen on every interface, or on 127.0.0.1 only.",
            keywords: ["expose", "lan", "loopback", "address"],
            icon: GlobeIcon,
          },
          {
            title: "Tailscale HTTPS",
            hint: "Publish through Tailscale Serve at a MagicDNS HTTPS URL, so phone browsers get a secure context.",
            keywords: ["tailnet", "magicdns", "certificate", "serve"],
            icon: LockIcon,
          },
        ],
      },
      {
        title: "Pair a device",
        rows: [
          {
            title: "Pairing code",
            hint: "One code, one device. Codes are shown once and never stored.",
            keywords: ["qr", "link", "token"],
            icon: SmartphoneIcon,
          },
        ],
      },
      {
        title: "Paired devices",
        rows: [
          {
            title: "Revoke all other devices",
            hint: "Keeps this one. The lost-phone button.",
            keywords: ["sign out", "logout", "lost", "stolen"],
            icon: SmartphoneIcon,
          },
        ],
      },
      {
        title: "Other Macs",
        rows: [
          {
            title: "Add a Mac",
            hint: "Another Telar's conversations, in this rail, from its pairing link.",
            keywords: ["host", "pair", "second machine", "remote"],
            icon: MonitorIcon,
          },
        ],
      },
    ],
  },
  {
    id: "integrations",
    // NAVIGATE-ONLY, both rows. A profile row's title is the profile's own name
    // and a grant's is the address it covers — values, not copy, so there is
    // nothing static to anchor to (see the note at the top). The pane is
    // indexed anyway because "where are my saved passwords" and "which account
    // does the browser sign in as" are exactly the questions search exists for,
    // and landing on the right pane answers most of both.
    label: "Integrations",
    icon: PlugZapIcon,
    groups: [
      {
        rows: [
          {
            title: "Browser profiles",
            hint: "The identities Telar's own browser signs in as, one set of cookies each.",
            keywords: ["cookies", "account", "sign in", "chrome", "profile", "default", "browser"],
            icon: CircleUserRoundIcon,
          },
          {
            title: "Remembered logins",
            hint: "Logins you allowed agents to fill without asking again, one 1Password item each.",
            keywords: ["1password", "password", "credential", "autofill", "revoke", "vault"],
            icon: KeyRoundIcon,
          },
        ],
      },
    ],
  },
  {
    id: "providers",
    // NAVIGATE-ONLY, and knowingly. This pane's body is one card per configured
    // login, built from engine data — there is no static `Row` to anchor to, so
    // choosing this opens Providers and stops there. It is indexed anyway
    // because "where do I add my Codex account" is a question search should
    // answer, and landing on the right pane answers most of it.
    label: "Providers",
    icon: PlugIcon,
    groups: [
      {
        rows: [
          {
            title: "Add a login",
            hint: "Each login is a CLI already on this machine. Telar never signs you in; tokens stay where the CLI put them.",
            keywords: ["account", "claude", "codex", "api key", "sign in", "auth", "provider"],
            icon: PlugIcon,
          },
        ],
      },
    ],
  },
  {
    id: "tools",
    label: "Agent tools",
    icon: WrenchIcon,
    groups: [
      {
        title: "Add a server",
        rows: [
          {
            title: "Add a server",
            hint: "Tool servers every project sees. A project can define one with the same id to replace it for itself.",
            keywords: ["mcp", "stdio", "sse", "http", "tool", "server"],
            icon: WrenchIcon,
          },
        ],
      },
      {
        title: "Computer use",
        rows: [
          {
            title: "Engine",
            hint: "Which computer-use backend is installed — screenshots, clicks, typing in Mac apps.",
            keywords: ["cua", "driver", "automation"],
            icon: MonitorIcon,
          },
          {
            title: "Access",
            hint: "Accessibility and Screen Recording permission for driving the Mac.",
            keywords: ["permission", "privacy", "accessibility", "screen recording", "grant"],
            icon: MonitorIcon,
          },
        ],
      },
    ],
  },
  {
    id: "plugins",
    label: "Plugins",
    icon: BlocksIcon,
    groups: [
      {
        // Navigate-only. What is inside is contributed at runtime — see the
        // note at the top about plugin-declared rows.
        rows: [
          {
            title: "Plugins",
            hint: "Which plugins are registered with the engine, and whether each is on for this Mac.",
            keywords: ["latex", "data science", "extension", "enable"],
            icon: BlocksIcon,
          },
        ],
      },
    ],
  },
];

/** Built once at module load — the registry is a constant, and re-indexing it
 *  per keystroke would be work with no possible different answer. */
export const SETTINGS_SEARCH_INDEX = indexSettings(SETTINGS_SEARCH_PAGES);
