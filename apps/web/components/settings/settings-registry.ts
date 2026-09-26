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
 *   - THE APPEARANCE STUDIO'S GALLERIES AND EDITORS (the looks shelf, the theme
 *     grid, the sixteen colour swatches, the scene composer, the two font
 *     fields). The pane is stacked `SettingsGroup` cards now rather than a
 *     `Tabs` strip over panels (#399), so its rows ARE anchored and the "one
 *     tab away" caveat is gone — but a gallery is not a `Row` and a colour
 *     swatch's title is a token name, which is the "rows built from data" rule
 *     two bullets up. What is indexed is the fields: the Window group, and the
 *     accent.
 */

import {
  ArchiveIcon,
  AudioLinesIcon,
  BellIcon,
  BlocksIcon,
  BookMarkedIcon,
  CameraIcon,
  CircleUserRoundIcon,
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderGitIcon,
  FolderKanbanIcon,
  GaugeIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HardDriveIcon,
  ImageIcon,
  InfoIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LayersIcon,
  MicIcon,
  LockIcon,
  MonitorIcon,
  NetworkIcon,
  PackageIcon,
  PaletteIcon,
  PlugIcon,
  PlugZapIcon,
  ScrollTextIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  SparklesIcon,
  TerminalIcon,
  TimerIcon,
  TypeIcon,
  VariableIcon,
  WrenchIcon,
} from "lucide-react";
import { indexSettings, type SettingsPageSpec } from "@/lib/settings-search";

/** HOW A NEW WORKTREE IS PREPARED — one project's answer, on Projects. */
const WORKTREE_PREPARATION_ROWS: SettingsPageSpec["groups"][number]["rows"] = [
  {
    title: "Setup",
    hint: "A command run in each new worktree, optionally holding the first turn until it finishes.",
    keywords: ["install", "bootstrap", "prepare", "script", "timeout"],
    icon: TerminalIcon,
  },
  {
    title: "Environment",
    hint: "Variables exported to the setup command.",
    keywords: ["env", "variables", "export"],
    icon: VariableIcon,
  },
  {
    title: "Ports",
    hint: "One stable port per name, exported under that name.",
    keywords: ["port", "server", "collide"],
    icon: NetworkIcon,
  },
  {
    title: "Seed dependencies",
    hint: "Paths copied from the main checkout into a new worktree that lacks them.",
    keywords: ["copy", "clone", "dependencies", "seed"],
    icon: CopyIcon,
  },
  {
    title: "Artifacts",
    hint: "Output a worktree can regenerate, with the command that rebuilds it.",
    keywords: ["build output", "regenerate", "cache", "generated"],
    icon: PackageIcon,
  },
];

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
          {
            title: "Terminals settled sessions may keep open",
            hint: "Past it, the session settled longest ago has its terminals closed first.",
            keywords: ["terminal", "process", "dev server", "shell", "limit", "cap", "running", "settled"],
            icon: TimerIcon,
          },
        ],
      },
      /**
       * DICTATION'S GROUP STOOD HERE, and left for a tab of its own (#544): it
       * ships OFF, so the row a reader wants is the switch that turns it on, and
       * a switch buried inside the pane everybody opens for something else is
       * one nobody finds.
       *
       * It is declared on the `dictation` page below. What
       * `settings-registry.test.ts` pins is that a row is declared on the pane
       * that actually renders it — which is the drift that move would otherwise
       * have introduced silently.
       */
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
            title: "Continue sessions after restarting",
            hint: "When Telar restarts to update, the sessions it stopped pick up where they left off.",
            keywords: ["resume", "restart", "update", "continue", "interrupted"],
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
            title: "Model options",
            hint: "New conversations in this project start with this model and these options.",
            keywords: ["effort", "reasoning", "fast mode", "per project"],
            icon: GaugeIcon,
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
        // Rendered only for a project on this Mac; at All projects a search
        // lands on the pane and the scope picker, which is the step to take.
        title: "New worktrees",
        rows: WORKTREE_PREPARATION_ROWS,
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
        // ORDINARY ANCHORED ROWS NOW (#399). This pane used to be a `Tabs`
        // strip over panels, so these three existed only after a click and the
        // index carried a caveat saying the row was "one tab away". The pane is
        // stacked `SettingsGroup` cards, the heading is real, and the group is
        // half the anchor — `settings-row-appearance-window-translucency`.
        title: "Window",
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
            hint: "The desktop behind a translucent window, and the composition's layers under the app.",
            keywords: ["opacity", "wallpaper", "backdrop", "layers"],
            icon: MonitorIcon,
          },
          {
            title: "Colour scheme",
            hint: "Light, dark, or whatever the system is doing — and which state of the composition the composer edits.",
            keywords: ["light", "dark", "system", "theme", "mode"],
            icon: MonitorIcon,
          },
        ],
      },
      {
        // THE COMPOSER'S OWN ROWS. The layer stack and the sixteen token rows
        // are not `Row`s — a layer card and a colour row have nowhere to live in
        // one — so they carry no anchor to aim at, per the rule at the top of
        // this file. The base is the control a person comes looking for.
        title: "Composer",
        rows: [
          {
            title: "Base",
            hint: "The app colour every surface is derived from, per colour state.",
            keywords: ["colour", "color", "theme", "palette", "hue", "tint", "background", "canvas"],
            icon: PaletteIcon,
          },
        ],
      },
      {
        // DEPTH MOVED HERE WITH THE PANE'S OWN REORGANISATION (#471): it is
        // TASTE and travels in a look, unlike everything in the Window group.
        title: "Type and surfaces",
        rows: [
          {
            title: "Accent",
            hint: "The one hue that means a person acted — buttons, links, the caret.",
            keywords: ["colour", "color", "highlight", "primary", "hue"],
            icon: PaletteIcon,
          },
          {
            title: "Depth",
            hint: "How far raised surfaces — cards, the composer, menus — sit off the page.",
            keywords: ["shadow", "elevation", "flat", "soft", "deep", "raised"],
            icon: LayersIcon,
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
        title: "Push notifications",
        rows: [
          {
            // NAVIGATE-ONLY. The pane is status only since relay v2: its rows
            // are the phones themselves, values rather than copy, so there is
            // no standing row to anchor to — the group heading is the title.
            title: "Push notifications",
            // The words somebody types when notifications are not arriving —
            // they search for the symptom, not for "relay", which is a term
            // they have no reason to know.
            hint: "Whether this Mac can send alerts to your phones, and whether each one is actually being reached.",
            keywords: ["notifications", "apns", "alerts", "push", "relay", "phone", "not working", "test notification"],
            icon: BellIcon,
          },
          {
            // The one standing row: which device an alert goes to.
            title: "Notify on",
            hint: "Each alert goes to one device: this Mac while you're using it, your iPhone once you step away.",
            keywords: ["duplicate", "twice", "desktop notifications", "banner", "iphone", "mac", "idle", "away"],
            icon: BellIcon,
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
      {
        /**
         * THE GROUP IS INDEXED; THE SITES IN IT ARE NOT. Each row's title is an
         * origin and its hint is a profile name — values, not copy, which is the
         * rule at the top of this file. What IS indexed is the heading and the
         * empty state, because "where do I turn the camera back off for that
         * site" is exactly the question search exists for, and landing on this
         * pane answers most of it.
         */
        title: "Site permissions",
        rows: [
          {
            title: "Nothing decided yet",
            hint: "Camera, microphone, notifications, location, clipboard and screen sharing, per site and per browser profile.",
            keywords: ["camera", "microphone", "mic", "webcam", "notifications", "location", "geolocation", "clipboard", "screen share", "screen sharing", "permission", "permissions", "allow", "block", "revoke", "site"],
            icon: CameraIcon,
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
    /**
     * DICTATION (#544) — its own pane now, not a group inside General.
     *
     * The keywords are what somebody types when they have SEEN the mic button
     * and it did not work — "microphone", "mic", "voice" — and, since it ships
     * off, what somebody types looking for a button that is not there. The
     * vendor's name is in there because it is what the error beside the button
     * actually says.
     */
    id: "dictation",
    label: "Dictation",
    icon: MicIcon,
    groups: [
      {
        title: "Dictation",
        rows: [
          {
            /** THE ROW THAT TURNS IT ON, and the only one that exists while it
             *  is off — so it is the one somebody searching for a missing mic
             *  button has to land on. */
            title: "Provider",
            hint: "Who transcribes, or nobody. Off by default: no mic button anywhere, and this Mac's own dictation keeps working in the message box.",
            keywords: [
              "dictation",
              "dictate",
              "microphone",
              "mic",
              "voice",
              "speech",
              "transcribe",
              "transcription",
              "provider",
              "off",
              "disable",
              "turn off",
              "turn on",
              "enable",
              "deepgram",
            ],
            icon: MicIcon,
          },
          {
            title: "Deepgram key",
            hint: "The credential this Mac spends on transcription. Stored with its engine state; the browser and the phone only ever get a token that expires in minutes.",
            keywords: ["dictation", "dictate", "microphone", "mic", "voice", "speech", "transcribe", "transcription", "deepgram", "key", "api key", "credential"],
            icon: KeyRoundIcon,
          },
          {
            /** WHAT SOMEBODY TYPES AFTER A NAME COMES BACK WRONG (#581) —
             *  "glossary", "vocabulary", "keyterms", "custom words". The row is
             *  the only place any of those can be fixed, and none of them is a
             *  word the two rows above use. */
            title: "Vocabulary",
            hint: "Words the recogniser has no reason to expect, one per line. Your conversations, projects and branches are already sent; this is the rest.",
            keywords: [
              "dictation",
              "vocabulary",
              "glossary",
              "keyterm",
              "keyterms",
              "terms",
              "custom words",
              "jargon",
              "names",
              "spelling",
              "accuracy",
              "wrong word",
            ],
            icon: BookMarkedIcon,
          },
          /**
           * "HOW IT WORKS" IS GONE (#643), and the live demo below is what
           * replaced it. It was a ~300-character paragraph on a row with no
           * control, explaining in prose that words appear as they are heard and
           * are rewritten in place until they settle — which the Live transcript
           * row now SHOWS. The index entry goes with the row: a result that
           * scrolled to a row nobody renders is the decay this file's test
           * exists to catch.
           */
        ],
      },
      /**
       * PICK, TEST, WATCH (#643) — a second group on the same pane, indexed
       * because each of the three is a question somebody arrives with rather
       * than a control they go looking for. "Wrong microphone", "is it even
       * hearing me", "I want to see it working" are three different searches and
       * three different rows.
       *
       * THE KEYWORDS DELIBERATELY DO NOT FIGHT THE PROVIDER ROW for the bare
       * word "microphone". That row is the one somebody with no mic button at
       * all has to land on — it is the switch that turns the feature on — and it
       * is declared above these, so a tie on rank keeps it first (see
       * `searchSettings`: ties hold registry order).
       */
      {
        title: "Microphone",
        rows: [
          {
            title: "Input",
            hint: "Which microphone dictation records from. Kept in this browser alone, so a phone or another Mac keeps its own.",
            keywords: ["input", "device", "which microphone", "choose microphone", "headset", "airpods", "usb", "interface", "built-in", "default input", "wrong microphone"],
            icon: MicIcon,
          },
          {
            title: "Level",
            hint: "Whether the microphone is being heard at all, read straight off the input without transcribing — so it works with no key and no connection.",
            keywords: ["level", "meter", "volume", "test microphone", "not hearing", "no audio", "silent", "muted", "dead", "check"],
            icon: AudioLinesIcon,
          },
          {
            title: "Live transcript",
            hint: "A real transcription in the pane, discarded rather than sent — to see the words arrive and be rewritten in place before they settle.",
            keywords: ["demo", "preview", "try", "live", "test transcription", "interim", "rewritten", "see it working"],
            icon: TypeIcon,
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
         * FIRST ON THE PANE AND FIRST HERE. The keywords are the words a person
         * uses when they are not looking for a feature but auditing one —
         * "prompt", "system prompt", "what do you inject", "preamble" — because
         * that is what brings anybody to this group. "Telar" itself is a
         * keyword: it is the only group in Settings whose subject is the app's
         * own voice.
         */
        title: "Telar orientation",
        rows: [
          {
            title: "Tell agents they are inside Telar",
            hint: "One paragraph per turn saying what Telar's words mean — the browser, a session, the panel, the rail, Looks.",
            keywords: [
              "orientation",
              "preamble",
              "system prompt",
              "prompt",
              "context",
              "inject",
              "briefing",
              "instructions",
              "telar",
            ],
            icon: SparklesIcon,
          },
          {
            title: "Show the text",
            hint: "The exact paragraph this engine injects, read from the engine itself.",
            keywords: ["preamble", "prompt", "text", "reveal", "audit", "what does it say"],
            icon: SparklesIcon,
          },
          {
            title: "Install the telar skill",
            hint: "A SKILL.md in each provider's skills directory with the detail: the panel, assignment and settling, browser tabs.",
            keywords: ["skill", "SKILL.md", "claude", "codex", "opencode", "docs", "reference", "telar"],
            icon: SparklesIcon,
          },
        ],
      },
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
  /**
   * STORAGE — what Telar deletes on its own, and where things live. What a
   * person types here is a symptom ("disk full", "space"), so the cleanup rows
   * carry those words.
   */
  {
    id: "storage",
    label: "Storage",
    icon: HardDriveIcon,
    groups: [
      {
        title: "Worktrees",
        rows: [
          {
            title: "Delete inactive worktrees",
            hint: "Releases the worktree of a session inactive this many days; its branch and conversation are kept.",
            keywords: ["cleanup", "clean up", "disk", "space", "free", "full", "reclaim", "checkout", "idle", "old", "days"],
            icon: ClockIcon,
          },
          {
            title: "Delete unchanged worktrees",
            hint: "Releases the worktree of an idle session whose branch has no commits beyond the default branch.",
            keywords: ["cleanup", "clean up", "disk", "space", "reclaim", "checkout", "unchanged", "empty", "branch"],
            icon: GitBranchIcon,
          },
          {
            title: "Delete worktrees of archived sessions",
            hint: "Otherwise archiving keeps the worktree.",
            keywords: ["cleanup", "clean up", "disk", "space", "reclaim", "checkout", "archive"],
            icon: ArchiveIcon,
          },
          {
            /**
             * TWO ROWS CALLED "Location", ON ONE PANE, AND DELIBERATELY. One
             * moves the reproducible worktrees; the other moves everything,
             * including the history that nothing reproduces. The group tells
             * them apart and is half the anchor.
             */
            title: "Location",
            hint: "Where new worktrees are made, and how to put them on another drive without moving your history.",
            keywords: ["worktree", "checkout", "external", "drive", "move", "space", "disk", "relocate"],
            icon: FolderGitIcon,
          },
        ],
      },
      {
        title: "Logs",
        rows: [
          {
            title: "Delete old logs",
            hint: "Rotated logs only.",
            keywords: ["cleanup", "clean up", "disk", "space", "logs", "rotate", "days"],
            icon: ScrollTextIcon,
          },
        ],
      },
      {
        title: "Store",
        rows: [
          {
            title: "Location",
            hint: "Where Telar keeps everything, and how to move it to another drive.",
            keywords: ["move", "external", "volume", "drive", "relocate", "where", "path", "ssd"],
            icon: HardDriveIcon,
          },
        ],
      },
    ],
  },
];

/** Built once at module load — the registry is a constant, and re-indexing it
 *  per keystroke would be work with no possible different answer. */
export const SETTINGS_SEARCH_INDEX = indexSettings(SETTINGS_SEARCH_PAGES);
