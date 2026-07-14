// Login driver: the app DRIVES the provider CLI login for an account instead of
// handing the user a command to copy-paste. Both shipping providers are
// pipe-drivable (verified by spawn+immediate-kill probes against throwaway
// config dirs — no real login was ever completed):
//
//   codex  → `codex login --device-auth` prints a verification URL plus a
//            one-time device code, then POLLS and self-completes: it writes
//            auth.json and exits 0 on success. One-way drive, no stdin. This is
//            the cleanest path and is what SHIPS for codex.
//
//   claude → `claude auth login --claudeai` prints an OAuth URL, opens the
//            user's browser, then WAITS on stdin for the authorization code the
//            callback page shows ("Paste code here if prompted >"). It does not
//            require a TTY (it ran fine under piped stdio), so we drive it too:
//            surface the URL, take the pasted code from the UI, write it to the
//            child's stdin. This is what SHIPS for claude.
//
// Neither provider hard-requires a TTY, so the Terminal.app osascript fallback
// (implemented in the API route) is only an escape hatch, never the primary
// path. If a provider ever did require a raw TTY, spawnProviderLogin would
// surface a spawn/exit failure and the UI would offer that fallback.
//
// SAFETY: this module never reads a credential file's contents and never logs
// beyond the CLI's own stdout/stderr. Callers must refuse to start when the
// account is already healthy, and must cancel() on client disconnect / timeout.
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accountHealth, type AccountHealth } from "./accounts";
import { accountEnv } from "./engine";
import { providerOf } from "./providers";
import type { AccountProfile, ProviderId } from "./schemas";

// A single streamed step of a login. `line` is the raw (ANSI-stripped) CLI
// output for the live log; the semantic events are derived from it:
//   url      – a verification/OAuth URL the user should open.
//   code     – a device code the user must enter at that URL (codex).
//   needCode – the CLI is blocked waiting for the user to paste a code back
//              (claude); the UI must collect it and call submitCode().
//   done     – the child exited 0; carries a fresh accountHealth re-check.
//   failed   – the child exited non-zero, errored, was cancelled, or timed out.
export type LoginEvent =
  | { type: "line"; text: string }
  | { type: "url"; url: string }
  | { type: "code"; code: string }
  | { type: "needCode"; prompt: string }
  | { type: "done"; health: AccountHealth }
  | { type: "failed"; error: string; health: AccountHealth };

export interface LoginSession {
  // Consume once. Ends after a terminal (done|failed) event.
  events: AsyncIterableIterator<LoginEvent>;
  // Feed a pasted authorization code to a CLI waiting on stdin (claude).
  submitCode(code: string): void;
  // Kill the child (client disconnect / user cancel / timeout).
  cancel(reason?: string): void;
}

export interface SpawnLoginOptions {
  timeoutMs?: number;
  // Seams for hermetic tests — never touch a real provider CLI in a test.
  spawn?: typeof nodeSpawn;
  healthCheck?: (a: AccountProfile) => AccountHealth;
  command?: { cmd: string; args: string[] };
  env?: Record<string, string | undefined>;
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

const URL_RE = /https?:\/\/[^\s'"<>)\]]+/;
// Device codes are short, uppercase, hyphenated (e.g. 6NQL-48VCU). Constrained
// so a normal URL/word never matches: exactly one hyphen, 4 then 4-8 chars.
const DEVICE_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/;

// Pure line classifier — the semantic event a CLI line implies, if any. A line
// that carries a URL is a `url` event; a code prompt is `needCode`; a bare
// device code (on a line with no URL) is `code`. Returns null for plain output.
export function classifyLoginLine(raw: string): LoginEvent | null {
  const line = stripAnsi(raw);
  const url = line.match(URL_RE);
  if (url) return { type: "url", url: url[0] };
  if (/paste|enter the code|authorization code/i.test(line) && /code/i.test(line))
    return { type: "needCode", prompt: line.trim() };
  const code = line.match(DEVICE_CODE_RE);
  if (code) return { type: "code", code: code[0] };
  return null;
}

// Argv that starts a drivable login for this account's provider. Reuses the
// provider descriptor's loginArgs and appends the flag that makes the flow
// pipe-drivable and non-interactive-friendly.
const EXTRA_LOGIN_FLAGS: Record<ProviderId, string[]> = {
  claude: ["--claudeai"], // subscription flow, prints URL + waits for pasted code
  codex: ["--device-auth"], // device-code flow, prints URL + code, self-polls
};

export function loginCommand(account: AccountProfile): { cmd: string; args: string[] } {
  const provider: ProviderId = account.provider ?? "claude";
  const desc = providerOf(provider);
  return { cmd: provider, args: [...desc.loginArgs, ...EXTRA_LOGIN_FLAGS[provider]] };
}

// A minimal pushable async queue: producers push(); a single consumer awaits
// next(). end() closes the stream after already-queued items drain.
function makeQueue<T>() {
  const items: T[] = [];
  const waiters: Array<(r: IteratorResult<T>) => void> = [];
  let closed = false;
  return {
    push(v: T) {
      if (closed) return;
      const w = waiters.shift();
      if (w) w({ value: v, done: false });
      else items.push(v);
    },
    end() {
      closed = true;
      let w: ((r: IteratorResult<T>) => void) | undefined;
      while ((w = waiters.shift())) w({ value: undefined as never, done: true });
    },
    iterator(): AsyncIterableIterator<T> {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<IteratorResult<T>> {
          if (items.length) return Promise.resolve({ value: items.shift() as T, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// Spawn and drive a provider login. Returns immediately with a streaming
// session; the caller iterates `events` and is responsible for cancel() on
// disconnect. The child inherits accountEnv(account) so it writes into THIS
// account's config dir (CLAUDE_CONFIG_DIR / CODEX_HOME) and no other.
export function spawnProviderLogin(
  account: AccountProfile,
  opts: SpawnLoginOptions = {},
): LoginSession {
  const spawn = opts.spawn ?? nodeSpawn;
  const health = opts.healthCheck ?? accountHealth;
  const { cmd, args } = opts.command ?? loginCommand(account);
  const env = opts.env ?? { ...accountEnv(account), NO_COLOR: "1" };
  const queue = makeQueue<LoginEvent>();

  let settled = false;
  let cancelReason: string | null = null;
  let child: ChildProcess;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (evt: LoginEvent) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    queue.push(evt);
    queue.end();
  };

  try {
    child = spawn(cmd, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    finish({ type: "failed", error: `Could not start ${cmd}: ${msg(e)}`, health: health(account) });
    return {
      events: queue.iterator(),
      submitCode() {},
      cancel() {},
    };
  }

  // Line-buffer both streams; emit the raw line plus any semantic event.
  const onChunk = (buf: Buffer) => {
    for (const raw of splitLines(buf.toString())) {
      if (!raw) continue;
      const text = stripAnsi(raw);
      queue.push({ type: "line", text });
      const evt = classifyLoginLine(raw);
      if (evt) queue.push(evt);
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  child.on("error", (e) => {
    finish({ type: "failed", error: `Could not start ${cmd}: ${msg(e)}`, health: health(account) });
  });

  child.on("exit", (code) => {
    // A fresh, read-only health re-check is the honest completion signal for
    // file-cred providers (codex flips never-logged-in → ok). Claude keeps
    // creds in the Keychain, so its health may stay "unknown" even on success —
    // the UI treats exit 0 (a `done` event) as the authoritative signal.
    const h = health(account);
    if (cancelReason) finish({ type: "failed", error: cancelReason, health: h });
    else if (code === 0) finish({ type: "done", health: h });
    else finish({ type: "failed", error: `login exited with code ${code ?? "unknown"}`, health: h });
  });

  const kill = (reason: string) => {
    if (settled || cancelReason) return;
    cancelReason = reason;
    try {
      child.kill("SIGTERM");
    } catch {}
    // Escalate if it ignores SIGTERM; the exit handler settles the session.
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 1500).unref?.();
  };

  timer = setTimeout(() => kill("login timed out"), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  return {
    events: queue.iterator(),
    submitCode(code: string) {
      if (settled) return;
      try {
        child.stdin?.write(code.trim() + "\n");
      } catch {}
    },
    cancel(reason = "login cancelled") {
      kill(reason);
    },
  };
}

function splitLines(s: string): string[] {
  return s.split(/\r?\n/);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
