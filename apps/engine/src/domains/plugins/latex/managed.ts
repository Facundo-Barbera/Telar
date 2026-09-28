import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ToolInfo } from "../data-science/toolchain";

export const MANAGED_TECTONIC_VERSION = "0.17.0";

export type ManagedRelease = {
  target: string;
  url: string;
  sha256: string;
};

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

export function managedRelease(platform: string = process.platform, arch: string = process.arch): ManagedRelease | undefined {
  return MANAGED_TECTONIC_RELEASES[`${platform}-${arch}`];
}

function managedTectonicDir(engineRoot: string, version: string = MANAGED_TECTONIC_VERSION): string {
  return path.join(engineRoot, "tools", "tectonic", version);
}

export function managedTectonicBinary(engineRoot: string, version: string = MANAGED_TECTONIC_VERSION): string {
  return path.join(managedTectonicDir(engineRoot, version), "tectonic");
}

function findManagedTectonic(engineRoot: string, version: string = MANAGED_TECTONIC_VERSION): ToolInfo | undefined {
  const file = managedTectonicBinary(engineRoot, version);
  try {
    if (!fs.statSync(file).isFile()) return undefined;
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    return undefined;
  }
  return { path: file, version };
}

export type ManagedTectonicStatus = {
  version: string;
  supported: boolean;
  installed: boolean;
  path?: string;
  installing: boolean;
  error?: string;
};

export type ManagedTectonicDeps = {
  root: string;
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  platform?: string;
  arch?: string;
  release?: ManagedRelease;
  extract?: (archive: string, into: string) => Promise<void>;
};

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

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

    for (const name of readdir(parent)) {
      if (name.startsWith(".install-")) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    }

    const scratch = fs.mkdtempSync(path.join(parent, ".install-"));
    try {
      const bytes = await this.download(release.url);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== release.sha256) {
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

      try {
        fs.renameSync(scratch, target);
      } catch (error) {
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
