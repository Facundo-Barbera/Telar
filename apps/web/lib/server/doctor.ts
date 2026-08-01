// SERVER ONLY. The machine-readiness doctor: a read-only sweep of everything a
// loom run needs on this box — the driver binaries, GitHub auth, every provider
// account's on-disk login, the Playwright browser the verifier drives, and
// which TELAR_HOME is active. Imported only by app/api/doctor/route.ts. Never
// import from a client component: it pulls in @telar/core and child_process.
//
// ABSOLUTE honesty rules baked in here: we never run a real login/OAuth flow,
// never read a credential file's CONTENTS, and never print a token. `gh auth
// status` output is parsed for the account name only; the token line is dropped.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listAccounts,
  accountHealth,
  getDefaultAccountName,
  signInCommand,
  telarDir,
  type AccountHealthStatus,
} from "@telar/core";

const execFileP = promisify(execFile);

// ---- report shape (mirrored type-only by the client) ----------------------
export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  // The concrete thing to run/do to turn this check green. Present only when
  // the check is not ok — a green row needs no remedy.
  remedy?: string;
  // A short factual value to show alongside the label (a version, a path).
  value?: string;
}

export interface DoctorSection {
  id: string;
  title: string;
  description: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  generatedAt: number;
  summary: { ok: number; warn: number; fail: number };
  sections: DoctorSection[];
}

// ---- binary probes --------------------------------------------------------
// The driver binaries a run shells out to, each with an install remedy. PATH
// comes from the server env (process.env) — execFile resolves the bare name
// against it, no shell, so nothing user-supplied is interpolated.
const BINARIES: { id: string; bin: string; label: string; remedy: string }[] = [
  { id: "bun", bin: "bun", label: "Bun", remedy: "curl -fsSL https://bun.sh/install | bash" },
  { id: "git", bin: "git", label: "Git", remedy: "xcode-select --install  (or: brew install git)" },
  { id: "gh", bin: "gh", label: "GitHub CLI", remedy: "brew install gh" },
  { id: "claude", bin: "claude", label: "Claude Code", remedy: "npm i -g @anthropic-ai/claude-code" },
  { id: "codex", bin: "codex", label: "Codex CLI", remedy: "npm i -g @openai/codex" },
];

// First non-empty output line, trimmed — every one of these prints its version
// on line one (`git version …`, `gh version …`, `2.1.209 (Claude Code)`, …).
function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

async function probeBinary(bin: string): Promise<{ present: boolean; version?: string }> {
  try {
    const { stdout, stderr } = await execFileP(bin, ["--version"], {
      timeout: 4000,
      env: process.env,
      maxBuffer: 1 << 20,
    });
    return { present: true, version: firstLine(stdout) || firstLine(stderr) || undefined };
  } catch {
    return { present: false };
  }
}

async function binaryChecks(): Promise<DoctorCheck[]> {
  const probes = await Promise.all(BINARIES.map((b) => probeBinary(b.bin)));
  return BINARIES.map((b, i) => {
    const p = probes[i];
    return p.present
      ? { id: b.id, label: b.label, status: "ok", detail: "Found on PATH.", value: p.version }
      : {
          id: b.id,
          label: b.label,
          status: "fail",
          detail: "Not found on the server PATH.",
          remedy: b.remedy,
        };
  });
}

// ---- gh auth (classified; token never surfaced) ---------------------------
async function ghAuthCheck(ghPresent: boolean): Promise<DoctorCheck> {
  const base = { id: "gh-auth", label: "GitHub auth" } as const;
  if (!ghPresent) {
    return {
      ...base,
      status: "fail",
      detail: "gh is not installed, so GitHub auth can't be checked.",
      remedy: "brew install gh",
    };
  }
  try {
    // `gh auth status` exits non-zero when not logged in; capture both streams.
    const { stdout, stderr } = await execFileP("gh", ["auth", "status"], {
      timeout: 5000,
      env: process.env,
      maxBuffer: 1 << 20,
    });
    const out = `${stdout}\n${stderr}`;
    // Pull the account name ONLY — never the token line. If gh's phrasing
    // shifts we degrade to "authenticated" rather than leaking anything.
    const who = out.match(/account\s+(\S+)/i)?.[1];
    return {
      ...base,
      status: "ok",
      detail: who ? `Authenticated as ${who}.` : "Authenticated.",
    };
  } catch (e) {
    const out = e instanceof Error && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "") : "";
    // A non-zero exit with a "not logged" hint is the not-authed case; any
    // other failure (unexpected) still reads as not-usable and needs login.
    const detail = /not logged/i.test(out)
      ? "No GitHub account is logged in."
      : "gh could not confirm a logged-in account.";
    return { ...base, status: "fail", detail, remedy: "gh auth login" };
  }
}

// ---- provider accounts (reuse core accountHealth + a sign-in remedy) ------
// The remedy is core's signInCommand — the same string the Accounts surface and
// the chat preflight hand over — because Telar tells the user how to sign in
// and never does it for them.
//
// accountHealth's four states → doctor severity. "unknown" is deliberately a
// warn, not a fail: a base/keychain login simply can't be proven from disk, so
// we say "can't verify" honestly instead of faking a green check or alarming.
const HEALTH_STATUS: Record<AccountHealthStatus, CheckStatus> = {
  ok: "ok",
  unknown: "warn",
  "missing-config-dir": "fail",
  "never-logged-in": "fail",
};

function accountChecks(): DoctorCheck[] {
  const def = getDefaultAccountName();
  return listAccounts().map((a) => {
    const health = accountHealth(a);
    const status = HEALTH_STATUS[health.status];
    const provider = a.provider ?? "claude";
    return {
      id: `account:${a.name}`,
      label: a.name === def ? `${a.name} (default)` : a.name,
      value: provider,
      status,
      detail: health.detail,
      // A remedy only when a login is genuinely absent — not for "unknown".
      remedy: status === "fail" ? signInCommand(a) : undefined,
    };
  });
}

// ---- playwright browser cache ---------------------------------------------
// The loom verifier drives a real Chromium via Playwright. Presence = a
// chromium-* directory under the shared browser cache; contents aren't read.
function playwrightCheck(): DoctorCheck {
  const cacheDir = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const base = { id: "playwright", label: "Playwright Chromium" } as const;
  let hasChromium = false;
  try {
    hasChromium = fs.readdirSync(cacheDir).some((n) => n.startsWith("chromium-"));
  } catch {
    hasChromium = false;
  }
  return hasChromium
    ? { ...base, status: "ok", detail: "Chromium is installed for the verifier.", value: cacheDir }
    : {
        ...base,
        status: "fail",
        detail: "No Chromium build found; the loom verifier can't drive a browser.",
        remedy: "bunx playwright install chromium",
      };
}

// ---- TELAR_HOME resolution ------------------------------------------------
// Which registry home is live: the real ~/.telar, the ~/.telar-dev sandbox the
// dev script points at, or a custom TELAR_HOME override. Always informational
// (ok) — but flags the dev sandbox so a machine setup isn't done against it.
function telarHomeCheck(): DoctorCheck {
  const active = telarDir();
  // TRIMMED, because `active` above is: telarDir() (manifest.ts) trims before
  // it resolves, so a whitespace-only TELAR_HOME resolves to the HOME DEFAULT
  // while the raw variable is still truthy. Read raw, this line labelled that
  // default "Custom (TELAR_HOME override)" — a doctor check contradicting the
  // very value printed beside it, in the one readout a human uses to confirm
  // which state root is live before doing something they cannot undo. Same
  // defect class as the logUsage guard that read the raw variable while the
  // write followed the trimmed one; a display must read the same value it
  // describes.
  const override = process.env.TELAR_HOME?.trim();
  const isDev = active.endsWith(".telar-dev");
  const exists = fs.existsSync(active);
  const kind = isDev
    ? "Dev sandbox (TELAR_HOME → …/.telar-dev)"
    : override
      ? "Custom (TELAR_HOME override)"
      : "Default (~/.telar)";
  return {
    id: "telar-home",
    label: "Active TELAR_HOME",
    value: active,
    status: isDev ? "warn" : "ok",
    detail: exists
      ? `${kind}.`
      : `${kind} — not created yet; it's written on first use.`,
    remedy: isDev
      ? "Running against the dev sandbox — unset TELAR_HOME to target the real ~/.telar."
      : undefined,
  };
}

// ---- assembly -------------------------------------------------------------
export async function runDoctor(): Promise<DoctorReport> {
  const bins = await binaryChecks();
  const ghPresent = bins.find((c) => c.id === "gh")?.status === "ok";
  const gh = await ghAuthCheck(ghPresent);

  const sections: DoctorSection[] = [
    {
      id: "binaries",
      title: "Command-line tools",
      description: "The driver binaries a loom shells out to, resolved on the server PATH.",
      checks: bins,
    },
    {
      id: "github",
      title: "GitHub",
      description: "Auth for branch/PR operations. Never displays the token.",
      checks: [gh],
    },
    {
      id: "accounts",
      title: "Provider accounts",
      description: "On-disk login liveness for every registered account.",
      checks: accountChecks(),
    },
    {
      id: "environment",
      title: "Environment",
      description: "The browser the verifier drives and the active registry home.",
      checks: [playwrightCheck(), telarHomeCheck()],
    },
  ];

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const s of sections) for (const c of s.checks) summary[c.status] += 1;

  return { generatedAt: Date.now(), summary, sections };
}
