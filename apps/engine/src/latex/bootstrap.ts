/**
 * Installing a TeX toolchain, as JobRunner steps. Homebrew when it is there
 * for Tectonic — it puts the binary where PATH already looks — else the
 * vendor's installer, downloaded to a fresh temp file and run from there;
 * nothing is piped from the network straight into a shell.
 *
 * TINYTEX IS ALWAYS THE VENDOR SCRIPT, deliberately: `brew install --cask
 * basictex/mactex` are sudo-prompting pkg installers, and a background job
 * has no terminal to answer the prompt. TinyTeX lands user-owned under
 * ~/Library/TinyTeX with a user-writable tlmgr — the property the package
 * manager story depends on.
 */
import os from "node:os";
import path from "node:path";
import type { JobStep } from "../ds/jobs";
import type { LatexToolchain } from "./toolchain";

export type LatexBootstrapRequest = { what: "tectonic" } | { what: "tinytex" };

export function planLatexBootstrap(request: LatexBootstrapRequest, toolchain: LatexToolchain): { steps: JobStep[]; expectBinary: string } {
  switch (request.what) {
    case "tectonic": {
      if (toolchain.tectonic) throw new Error(`Tectonic ${toolchain.tectonic.version} is already installed`);
      if (toolchain.brew) {
        return { steps: [{ title: "Installing Tectonic with Homebrew", file: toolchain.brew.path, args: ["install", "tectonic"] }], expectBinary: "tectonic" };
      }
      const script = path.join(os.tmpdir(), `telar-tectonic-install-${process.pid}.sh`);
      const target = path.join(os.homedir(), ".local", "bin");
      return {
        steps: [
          { title: "Downloading the Tectonic installer", file: "curl", args: ["-LsSf", "-o", script, "https://drop-sh.fullyjustified.net"] },
          // The script drops the binary in its cwd; the store mkdirs the target first.
          { title: `Installing Tectonic into ${target}`, file: "sh", args: [script], cwd: target },
        ],
        expectBinary: "tectonic",
      };
    }
    case "tinytex": {
      if (toolchain.texlive.some((dist) => dist.flavour === "tinytex")) throw new Error("TinyTeX is already installed");
      const script = path.join(os.tmpdir(), `telar-tinytex-install-${process.pid}.sh`);
      return {
        steps: [
          { title: "Downloading the TinyTeX installer", file: "curl", args: ["-LsSf", "-o", script, "https://yihui.org/tinytex/install-bin-unix.sh"] },
          { title: "Installing TinyTeX (about 150 MB)", file: "sh", args: [script] },
        ],
        expectBinary: "tlmgr",
      };
    }
  }
}
