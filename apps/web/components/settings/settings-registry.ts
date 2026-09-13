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
 *   - THE PROJECT-SCOPED GROUPS ON THE PROJECTS PANE — its MCP list and every
 *     plugin's own editor, which arrived there when the standalone per-project
 *     page was retired (#363). Both are built from data: the MCP group's
 *     heading is the project's own name and a plugin's is the plugin's, which
 *     is the rule two bullets down. The pane's STANDING rows are indexed, and
 *     they are copy rather than one entry per registered folder.
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
  GitPullRequestIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LockIcon,
  MonitorIcon,
  PaletteIcon,
  PlugIcon,
  PlugZapIcon,
  ServerIcon,
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
            /**
             * THE SHELF'S VOCABULARY LIVES HERE NOW (#364). The Settled pane
             * listed the conversations this rail has shelved — a shelf, which
             * the rail already draws — so what is left to FIND in settings is
             * the rule that puts them there, and someone typing "archive" or
             * "where did it go" is owed that row rather than nothing.
             */
            title: "Settle quiet sessions",
            hint: "Quiet sessions leave the list on their own, or nothing does. Shelved ones are on the rail, under Settled.",
            keywords: ["inbox", "archive", "auto", "shelf", "settled", "unsettle", "restore", "hidden", "put away", "quiet"],
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
    /**
     * NAVIGATE-ONLY, and by the rule at the top rather than by omission: every
     * row on this pane is derived from `COMMAND_KEY_BINDINGS`, so its title is
     * a VALUE (`Rail: Jump to conversation 4`) that would rot the moment a
     * binding is added or renamed. One entry for the pane, whose title is the
     * group heading the pane actually draws — and the pane is one card, so
     * arriving on it puts every binding on screen anyway.
     *
     * THE COMMAND PALETTE IS FOUND HERE TOO (#402), and by keyword rather than
     * by a row of its own: every one of its actions IS a binding this pane
     * already draws, ⌘K included, so a row called "Command palette" would be a
     * second name for the card underneath it. The words are what somebody types
     * when they want to change ⌘K, or to find out what it is now bound to.
     */
    id: "keybindings",
    label: "Keybindings",
    icon: KeyboardIcon,
    groups: [
      {
        rows: [
          {
            title: "Keyboard shortcuts",
            hint: "Every chord this app answers to, and what each one does — the same list the command palette runs.",
            keywords: [
              "shortcut",
              "hotkey",
              "chord",
              "accelerator",
              "binding",
              "cmd",
              "command key",
              "keyboard",
              "command palette",
              "palette",
              "cmd k",
              "go to file",
              "quick open",
            ],
            icon: KeyboardIcon,
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
            hint: "On by default. Unpaired devices are refused; off, anything that can reach this address has full control.",
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
    //
    // The label is the nav's, and the nav calls this Browser now (#357). The id
    // stays `integrations` because it is the route; "integrations" survives as a
    // keyword so the old word still finds the pane.
    label: "Browser",
    icon: PlugZapIcon,
    groups: [
      {
        rows: [
          {
            title: "Browser profiles",
            hint: "The identities Telar's own browser signs in as, one set of cookies each.",
            keywords: ["cookies", "account", "sign in", "chrome", "profile", "default", "browser", "integrations"],
            icon: CircleUserRoundIcon,
          },
          {
            title: "Remembered logins",
            hint: "Logins you allowed agents to fill without asking again, one 1Password item each.",
            keywords: ["1password", "password", "credential", "autofill", "revoke", "vault", "integrations"],
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
      {
        /**
         * ALSO NAVIGATE-ONLY, and for the same reason as the group above: the
         * rows under this heading are one per configured hub, which are values
         * rather than copy. What IS indexed is the verb that adds one, because
         * "where do I see how much of my plan is left" is a question search
         * should answer and landing on this pane answers most of it.
         */
        title: "Usage providers",
        rows: [
          {
            title: "Add hub",
            hint: "Hubs that pool subscription accounts. Their remaining quota shows under Limits on the Usage page.",
            keywords: ["cliproxy", "cliproxyapi", "hub", "proxy", "quota", "limit", "limits", "usage", "pooled", "rate limit", "5h", "weekly", "remaining"],
            icon: ServerIcon,
          },
        ],
      },
    ],
  },
  {
    id: "source-control",
    label: "Source control",
    icon: GitPullRequestIcon,
    groups: [
      {
        title: "Source control",
        rows: [
          {
            title: "GitHub",
            hint: "Issues, pull requests and checks, read through the gh CLI you signed in to yourself.",
            keywords: ["gh", "git", "pull request", "issues", "token", "auth", "sign in", "cli", "forge", "gitlab"],
            icon: GitPullRequestIcon,
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
        /**
         * NAVIGATE-ONLY SINCE THE FORM BECAME PROGRESSIVE (#357). "Add a
         * server" is the caption on a form that is not on screen until somebody
         * presses Add, so there is no standing row to anchor to — but it is the
         * question people open this pane with, so it stays indexed.
         */
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
        // ONE ROW, NOT THREE. Engine, Driver daemon and Access were three
        // readouts of one question; the pane answers it once now, so the index
        // asks it once. Their old vocabulary survives as keywords.
        rows: [
          {
            title: "Computer use",
            hint: "Whether sessions can drive Mac apps — screenshots, clicks, typing.",
            keywords: [
              "cua",
              "driver",
              "automation",
              "engine",
              "access",
              "permission",
              "privacy",
              "accessibility",
              "screen recording",
              "grant",
            ],
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
            hint: "Which plugins are registered with the engine, whether each is on for this Mac, and the defaults a project inherits.",
            // The Mac-wide defaults live on this page and are contributed at
            // runtime, so they have no rows of their own to be found by. These
            // are what a person actually types when looking for them — "tectonic"
            // most of all, because somebody with no TeX installed does not yet
            // know the feature is called anything else.
            keywords: [
              "latex",
              "data science",
              "extension",
              "enable",
              "tectonic",
              "tex distribution",
              "texlive",
              "default engine",
              "packages",
              "default python",
            ],
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
