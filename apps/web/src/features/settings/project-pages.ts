import {
  ArchiveIcon,
  BellIcon,
  BlocksIcon,
  ClockIcon,
  BoxesIcon,
  CopyIcon,
  DownloadIcon,
  FlaskConicalIcon,
  FolderGitIcon,
  FolderKanbanIcon,
  GaugeIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HardDriveIcon,
  ImageIcon,
  InfoIcon,
  LockIcon,
  MonitorIcon,
  NetworkIcon,
  PackageIcon,
  ScrollTextIcon,
  SmartphoneIcon,
  SparklesIcon,
  TerminalIcon,
  VariableIcon,
  Volume2Icon,
} from "lucide-react";
import type { SettingsPageSpec } from "./search";

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
    title: "Dependencies",
    hint: "Whether a new worktree installs its dependencies, shares the checkout's, or goes without.",
    keywords: ["node_modules", "venv", "install", "share", "symlink", "disk"],
    icon: BoxesIcon,
  },
  {
    title: "Artifacts",
    hint: "Output a worktree can regenerate, with the command that rebuilds it.",
    keywords: ["build output", "regenerate", "cache", "generated"],
    icon: PackageIcon,
  },
];

export const PROJECT_PAGES: SettingsPageSpec[] = [
  {
    id: "projects",
    label: "Projects",
    icon: FolderKanbanIcon,
    groups: [
      {
        rows: [
          {
            navigateOnly: true,
            title: "Mac",
            hint: "Projects are registered per Mac. A paired one's registry is read from that Mac.",
            keywords: ["host", "paired", "remote", "other mac", "machine"],
            icon: MonitorIcon,
          },
          {
            navigateOnly: true,
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
        title: "New worktrees",
        rows: WORKTREE_PREPARATION_ROWS,
      },
      {
        title: "Danger",
        rows: [
          {
            title: "Worktree preparation",
            hint: "How a new worktree is prepared for this project: inherit, off, or its own.",
            keywords: ["setup", "prepare", "inherit", "worktree"],
            icon: TerminalIcon,
          },
          {
            title: "Repo file",
            hint: "Preparation read from a file committed in the repository.",
            keywords: ["config file", "committed", "telar.json", "repo"],
            icon: FolderGitIcon,
          },
          {
            title: "Remove project from Telar",
            hint: "Put the registration away. Nothing on disk is touched, and it can be restored.",
            keywords: ["unregister", "delete", "forget", "put away"],
            icon: FolderKanbanIcon,
          },
        ],
      },
      {
        title: "Removed from Telar",
        rows: [
          {
            title: "Restore this project",
            hint: "Puts a removed project back in the rail. Nothing on disk was touched when it went.",
            keywords: ["undo", "restore", "removed", "unarchive"],
            icon: FolderKanbanIcon,
          },
        ],
      },
      {
        title: "LaTeX",
        rows: [
          {
            title: "LaTeX for this project",
            hint: "Compile this project's documents and give its sessions the LaTeX tools.",
            keywords: ["latex", "tex", "enable", "plugin"],
            icon: BlocksIcon,
          },
          {
            title: "Default document",
            hint: "The file a compile builds when nothing else is named.",
            keywords: ["main file", "main.tex", "document", "entry"],
            icon: ScrollTextIcon,
          },
        ],
      },
      {
        title: "Data science",
        rows: [
          {
            title: "Data science for this project",
            hint: "Give this project's sessions a Python kernel and notebooks.",
            keywords: ["python", "jupyter", "notebook", "kernel", "enable", "plugin"],
            icon: BlocksIcon,
          },
        ],
      },
      {
        title: "Python tools",
        rows: [
          {
            title: "uv",
            hint: "The Python manager Telar installs interpreters and packages with.",
            keywords: ["python", "install", "package manager"],
            icon: PackageIcon,
          },
          {
            title: "conda",
            hint: "Environments made with conda, used when a project already has one.",
            keywords: ["anaconda", "miniconda", "environment"],
            icon: PackageIcon,
          },
          {
            title: "Python",
            hint: "Interpreters installed on this Mac, and one more to install.",
            keywords: ["interpreter", "version", "install python"],
            icon: FlaskConicalIcon,
          },
        ],
      },
      {
        title: "Environment",
        rows: [
          {
            title: "Install packages",
            hint: "Add packages to the environment this project runs in.",
            keywords: ["pip", "package", "install", "dependencies"],
            icon: PackageIcon,
          },
          {
            title: "The project's own dependencies",
            hint: "Install what the project's own requirements file lists.",
            keywords: ["requirements", "pyproject", "dependencies", "sync"],
            icon: PackageIcon,
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
            navigateOnly: true,
            title: "Push notifications",
            hint: "Whether this Mac's alerts reach your phone.",
            keywords: ["notifications", "apns", "alerts", "push", "relay", "phone", "not working", "test notification"],
            icon: BellIcon,
          },
          {
            title: "Notify on",
            hint: "Which device each alert goes to.",
            keywords: ["duplicate", "twice", "desktop notifications", "banner", "iphone", "mac", "idle", "away"],
            icon: BellIcon,
          },
          {
            title: "Notification sounds",
            hint: "The sound this Mac's alerts play.",
            keywords: ["sound", "chime", "audio", "mute", "silent", "hilo", "armonico", "felt"],
            icon: Volume2Icon,
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
            title: "Location",
            hint: "Where new worktrees are made; the summary below moves the ones already made.",
            keywords: ["worktree", "checkout", "external", "drive", "move", "space", "disk", "relocate", "worktree folder", "how many", "size"],
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
          {
            title: "Turn journal retention",
            hint: "A journal retention window set before this page existed, and the button that turns it off.",
            keywords: ["retention", "journal", "export", "retire", "idle"],
            icon: ArchiveIcon,
          },
        ],
      },
      {
        title: "Store",
        rows: [
          {
            title: "Location",
            hint: "Where Telar keeps everything.",
            keywords: ["external", "volume", "drive", "where", "path", "ssd"],
            icon: HardDriveIcon,
          },
          {
            title: "Safe copy",
            hint: "History, settings and notes copied to a new folder. Checkouts and environments are re-made.",
            keywords: ["backup", "copy", "export", "move store"],
            icon: CopyIcon,
          },
          {
            title: "Previous store",
            hint: "The copy left behind after the store moved, and the button that removes it.",
            keywords: ["old store", "cleanup", "free space", "retired"],
            icon: HardDriveIcon,
          },
        ],
      },
    ],
  },
  {
    id: "about",
    label: "This build",
    icon: InfoIcon,
    groups: [
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
    ],
  },
  {
    id: "updates",
    label: "Updates",
    icon: DownloadIcon,
    groups: [
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
];
