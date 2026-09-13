/**
 * TECTONIC THAT TELAR OWNS — so a project opened on a Mac with no TeX on it
 * compiles, instead of showing a settings page and a shrug.
 *
 * Every other distribution in `toolchain.ts` is FOUND: MacTeX where the
 * installer left it, TinyTeX where the vendor script put it, Homebrew's
 * tectonic on PATH. This one is FETCHED, into a directory under the engine's
 * own state root, and is therefore the only TeX install whose existence Telar
 * can promise on a machine it has never seen before. Tectonic is the right
 * program for that promise and TeX Live is not: one self-contained binary, no
 * sudo, no 4 GB of packages, and it downloads what a document actually uses on
 * first compile.
 *
 * ── WHAT IS PINNED, AND WHY IT IS PINNED HERE ───────────────────────────────
 * The version AND the SHA-256 of each platform's archive are constants in this
 * file. Not fetched from a manifest, not read out of a `SHA256SUMS` asset
 * beside the tarball: a digest that travels with the download proves only that
 * the bytes arrived intact, which TLS already did. A digest committed to this
 * repository is the thing that makes a swapped release asset fail closed.
 *
 * The cost is stated plainly: bumping Tectonic means editing two constants
 * together, and a release whose digest is not in the table cannot be installed.
 * That is the intended trade — an installer that would accept whatever it was
 * handed is not a security boundary, it is a download.
 *
 * ── THE THREE PROPERTIES INSTALLERS GET WRONG ───────────────────────────────
 *   IDEMPOTENT   a binary already at the version's path is the answer; nothing
 *                is downloaded, and calling install twice is not an error.
 *   RESUMABLE    the download lands in a per-attempt scratch directory and is
 *                RENAMED into place only after the digest matched. A crash
 *                mid-download therefore leaves no half-written binary that a
 *                later run would treat as installed — the next attempt starts
 *                clean and sweeps the scratch it finds.
 *   SERIALISED   one install at a time, per process. Two settings panes both
 *                pressing Install share one promise rather than racing into the
 *                same directory.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ToolInfo } from "../ds/toolchain";

/**
 * The Tectonic release Telar manages. BUMPING THIS MEANS BUMPING THE DIGESTS
 * BELOW in the same edit — see the file header for why they are not fetched.
 */
export const MANAGED_TECTONIC_VERSION = "0.17.0";

/** What the settings pane calls it, and the one place that string is written. */
export const MANAGED_TECTONIC_LABEL = "Telar (managed)";

export type ManagedRelease = {
  /** The Rust target triple naming the archive. */
  target: string;
  url: string;
  /** Lowercase hex SHA-256 of the `.tar.gz`, committed to this repository. */
  sha256: string;
};

/**
 * One entry per `${process.platform}-${process.arch}` we can serve.
 *
 * LINUX USES THE MUSL BUILDS deliberately: a glibc-linked binary fetched onto
 * an older distribution fails at exec time with a symbol-version error, which
 * reads to a user as "Telar's LaTeX is broken" rather than as a libc mismatch.
 * The static build runs wherever the kernel does.
 *
 * WINDOWS IS ABSENT, and that is a statement rather than an oversight: the
 * release ships a `.zip`, the extraction path here is tar, and nothing else in
 * this engine runs on Windows yet. `managedRelease` answers `undefined` and the
 * pane says the platform is unsupported instead of half-installing.
 */
export const MANAGED_TECTONIC_RELEASES: Record<string, ManagedRelease> = {
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    url: `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${MANAGED_TECTONIC_VERSION}/tectonic-${MANAGED_TECTONIC_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667",
  },
  "darwin-x64": {
    target: "x86_64-apple-darwin",
    url: `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${MANAGED_TECTONIC_VERSION}/tectonic-${MANAGED_TECTONIC_VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80",
  },
  "linux-x64": {
    target: "x86_64-unknown-linux-musl",
    url: `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${MANAGED_TECTONIC_VERSION}/tectonic-${MANAGED_TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7",
  },
  "linux-arm64": {
    target: "aarch64-unknown-linux-musl",
    url: `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${MANAGED_TECTONIC_VERSION}/tectonic-${MANAGED_TECTONIC_VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    sha256: "b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8",
  },
};

/** The release for a host, or nothing when we do not serve that platform. */
export function managedRelease(platform: string = process.platform, arch: string = process.arch): ManagedRelease | undefined {
  return MANAGED_TECTONIC_RELEASES[`${platform}-${arch}`];
}

/**
 * Where a version lives. VERSIONED, so a future bump installs beside the old
 * one rather than over a binary a compile may be running right now, and so the
 * directory's existence is itself the "which version is installed" answer.
 */
export function managedTectonicDir(engineRoot: string, version: string = MANAGED_TECTONIC_VERSION): string {
  return path.join(engineRoot, "tools", "tectonic", version);
}

export function managedTectonicBinary(engineRoot: string, version: string = MANAGED_TECTONIC_VERSION): string {
  return path.join(managedTectonicDir(engineRoot, version), "tectonic");
}

/** The installed binary, or nothing. Cheap enough to call on every resolve. */
export function findManagedTectonic(engineRoot: string, version: string = MANAGED_TECTONIC_VERSION): ToolInfo | undefined {
  const file = managedTectonicBinary(engineRoot, version);
  try {
    if (!fs.statSync(file).isFile()) return undefined;
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    return undefined;
  }
  return { path: file, version };
}

/** What the pane renders, and what `GET /v2/latex/managed` answers. */
export type ManagedTectonicStatus = {
  version: string;
  /** Whether this platform has a release in the table at all. */
  supported: boolean;
  installed: boolean;
  /** Present once installed. */
  path?: string;
  /** An install is running right now — the pane shows progress, not a button. */
  installing: boolean;
  /** Why the last attempt did not land. Cleared when a later one starts. */
  error?: string;
};

export type ManagedTectonicDeps = {
  /** The engine's state root — `<TELAR_HOME>/engine`. */
  root: string;
  /** Overridable so tests never touch the network. */
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  platform?: string;
  arch?: string;
  /**
   * The release to install, overriding the pinned table.
   *
   * FOR TESTS, AND SAID OUT LOUD BECAUSE IT IS THE ONE HOLE IN THE DIGEST
   * ARGUMENT. Nothing in the engine passes it: the daemon constructs this with
   * a root and nothing else, so the only digest a user's machine can ever
   * verify against is the constant in the table above. A test needs to install
   * a fixture whose digest cannot be in that table, and the alternative —
   * mutating the shared table and restoring it — leaves a window where a
   * concurrent test would verify against the wrong constant.
   */
  release?: ManagedRelease;
  /** Overridable so a test can prove extraction without spawning tar. */
  extract?: (archive: string, into: string) => Promise<void>;
};

/** How long the whole download may take before it is abandoned. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * THE MANAGED INSTALL, as an object rather than a function, because the
 * single-flight promise and the last error are state that has to outlive one
 * HTTP request — two panes polling `status()` must see the same install.
 */
export class ManagedTectonic {
  private inFlight?: Promise<ManagedTectonicStatus>;
  private lastError?: string;

  constructor(private readonly deps: ManagedTectonicDeps) {}

  get version(): string {
    return MANAGED_TECTONIC_VERSION;
  }

  release(): ManagedRelease | undefined {
    return this.deps.release ?? managedRelease(this.deps.platform ?? process.platform, this.deps.arch ?? process.arch);
  }

  /** The installed binary, or nothing — the fact `resolveLatex` falls back on. */
  found(): ToolInfo | undefined {
    return findManagedTectonic(this.deps.root, MANAGED_TECTONIC_VERSION);
  }

  status(): ManagedTectonicStatus {
    const found = this.found();
    return {
      version: MANAGED_TECTONIC_VERSION,
      supported: this.release() !== undefined,
      installed: found !== undefined,
      ...(found ? { path: found.path } : {}),
      installing: this.inFlight !== undefined,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /**
   * Fetch, verify, extract, publish — or answer immediately when it is already
   * there. Concurrent callers share one attempt.
   */
  install(): Promise<ManagedTectonicStatus> {
    const found = this.found();
    if (found) return Promise.resolve(this.status());
    if (this.inFlight) return this.inFlight;
    this.lastError = undefined;
    const attempt = this.run()
      .then(() => {
        this.inFlight = undefined;
        return this.status();
      })
      .catch((error: unknown) => {
        this.inFlight = undefined;
        this.lastError = error instanceof Error ? error.message : String(error);
        return this.status();
      });
    this.inFlight = attempt;
    return attempt;
  }

  private async run(): Promise<void> {
    const release = this.release();
    if (!release) {
      throw new Error(`Telar has no managed Tectonic for ${this.deps.platform ?? process.platform}-${this.deps.arch ?? process.arch}`);
    }
    const target = managedTectonicDir(this.deps.root, MANAGED_TECTONIC_VERSION);
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });

    // SWEEP FIRST. A scratch directory from an attempt that was killed mid-copy
    // is dead weight, and leaving it would let attempts accumulate a gigabyte of
    // half-downloads in a directory nobody looks at.
    for (const name of readdir(parent)) {
      if (name.startsWith(".install-")) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    }

    const scratch = fs.mkdtempSync(path.join(parent, ".install-"));
    try {
      const bytes = await this.download(release.url);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== release.sha256) {
        // NAMED IN THE MESSAGE, both of them. "Checksum mismatch" sends a person
        // to a forum; the two digests send them to the release page.
        throw new Error(
          `the Tectonic ${MANAGED_TECTONIC_VERSION} download does not match its expected checksum ` +
            `(expected ${release.sha256}, got ${digest}) — nothing was installed`,
        );
      }
      const archive = path.join(scratch, "tectonic.tar.gz");
      fs.writeFileSync(archive, bytes);
      await (this.deps.extract ?? extractTarGz)(archive, scratch);

      const binary = path.join(scratch, "tectonic");
      if (!fs.existsSync(binary)) throw new Error("the Tectonic archive did not contain a tectonic binary");
      fs.chmodSync(binary, 0o755);
      fs.rmSync(archive, { force: true });

      // THE PUBLISH IS THE RENAME, and it is the last thing that happens. Until
      // it does, `found()` answers undefined and nothing can resolve onto a
      // binary that is still being written.
      try {
        fs.renameSync(scratch, target);
      } catch (error) {
        // Lost the race to a concurrent engine on the same TELAR_HOME. Its copy
        // passed the same digest check, so the right move is to use it.
        if (!findManagedTectonic(this.deps.root, MANAGED_TECTONIC_VERSION)) throw error;
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    } catch (error) {
      fs.rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  }

  private async download(url: string): Promise<Buffer> {
    const fetcher =
      this.deps.fetch ??
      (async (target: string) => fetch(target, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" }));
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`could not download Tectonic ${MANAGED_TECTONIC_VERSION}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * `tar -xzf`, as a subprocess.
 *
 * BSD tar on macOS and GNU tar on Linux both read a gzipped tar and both ship
 * with the OS, so this needs no dependency — and writing a tar reader by hand
 * to save one spawn would mean owning symlink and path-traversal handling for
 * an archive we already verify by digest.
 */
async function extractTarGz(archive: string, into: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`could not unpack the Tectonic archive: ${stderr.trim() || `tar exited ${code}`}`));
    });
  });
}
