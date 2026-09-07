/**
 * TeX logs into structured diagnostics — the thing that makes `latex_compile`
 * worth an agent's while. TeX logs are unstructured prose; this parser reads
 * the reliable channels first (`-file-line-error` lines, tectonic's own
 * `error:` framing) and falls back to the classic `! …` blocks. AN UNPARSED
 * ERROR STILL SURFACES: anything that looks like an error but matches no rule
 * lands in the `other` bucket with its raw block, never on the floor.
 */
import path from "node:path";

export type LatexDiagnosticCode =
  | "missing-package"
  | "missing-file"
  | "undefined-control-sequence"
  | "undefined-reference"
  | "citation-undefined"
  | "overfull"
  | "other";

export type LatexDiagnostic = {
  severity: "error" | "warning";
  file?: string;
  line?: number;
  message: string;
  code?: LatexDiagnosticCode;
  detail?: string;
  suggestion?: string;
};

const MAX_DIAGNOSTICS = 100;
const MAX_DETAIL = 600;

type ParseOptions = { workspace?: string; kind?: "texlive" | "tectonic" };

/** `(./chapters/intro.tex` opens a file in the log; `)` closes one. */
const OPEN_FILE = /\((\.?\.?\/[^\s()]+|[A-Za-z]:[^\s()]+)/g;

function relativise(file: string, workspace?: string): string {
  const cleaned = file.replace(/^\.\//, "");
  if (!workspace || !path.isAbsolute(cleaned)) return cleaned;
  const relative = path.relative(workspace, cleaned);
  return relative.startsWith("..") ? cleaned : relative;
}

/** The `.sty`/`.cls` basename is the LIKELY tlmgr name — often but not always. */
function packageSuggestion(missing: string, kind?: "texlive" | "tectonic"): string | undefined {
  if (kind === "tectonic") return "Tectonic downloads packages automatically — check the name, or compile again while online.";
  const base = missing.replace(/\.(sty|cls)$/i, "");
  return `Likely \`latex_install\` with add: ["${base}"] — the tlmgr package is usually, not always, named after the file.`;
}

/**
 * Join a warning block: TeX wraps prose onto continuation lines until a blank
 * line. `max_print_line=1000` in the compile env keeps most messages on one
 * line; this handles the ones that wrap anyway.
 */
function joinBlock(lines: string[], start: number): { text: string; end: number } {
  let text = lines[start] ?? "";
  let end = start;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || /^[!(]/.test(line) || /^(LaTeX|Package|Class|Overfull|Underfull)/.test(line)) break;
    text += ` ${line.trim()}`;
    end = i;
  }
  return { text: text.replace(/\s+/g, " ").trim(), end };
}

export function parseLatexLog(log: string, options: ParseOptions = {}): LatexDiagnostic[] {
  const { workspace, kind } = options;
  const lines = log.split(/\r?\n/);
  const diagnostics: LatexDiagnostic[] = [];
  /** Parenthesis stack, the fallback attribution when file-line-error is absent. */
  const fileStack: string[] = [];

  const push = (diagnostic: LatexDiagnostic) => {
    if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    const key = `${diagnostic.severity}:${diagnostic.file ?? ""}:${diagnostic.line ?? ""}:${diagnostic.message}`;
    if (diagnostics.some((d) => `${d.severity}:${d.file ?? ""}:${d.line ?? ""}:${d.message}` === key)) return;
    diagnostics.push(diagnostic);
  };

  const currentFile = () => (fileStack.length ? relativise(fileStack[fileStack.length - 1]!, workspace) : undefined);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    // Track which file the log is inside, cheaply and best-effort.
    for (const match of line.matchAll(OPEN_FILE)) if (/\.(tex|sty|cls|bib|def|cfg|ltx)$/i.test(match[1]!)) fileStack.push(match[1]!);
    if (fileStack.length) {
      const closes = (line.match(/\)/g) ?? []).length;
      const opens = (line.match(/\(/g) ?? []).length;
      for (let c = closes - opens; c > 0 && fileStack.length; c -= 1) fileStack.pop();
    }

    // ── the reliable channel: -file-line-error ─────────────────────────────
    const fle = /^(.+?\.\w{2,4}):(\d+): (.+)$/.exec(line);
    if (fle && !line.startsWith("l.")) {
      const message = fle[3]!.trim();
      const block = joinBlock(lines, i);
      push({
        severity: "error",
        file: relativise(fle[1]!, workspace),
        line: Number.parseInt(fle[2]!, 10),
        message,
        code: message.includes("Undefined control sequence") ? "undefined-control-sequence" : "other",
        detail: block.text.slice(0, MAX_DETAIL),
      });
      continue;
    }

    // ── missing file / package ─────────────────────────────────────────────
    const missing = /^! LaTeX Error: File [`']([^']+)' not found/.exec(line);
    if (missing) {
      const name = missing[1]!;
      const isPackage = /\.(sty|cls)$/i.test(name);
      push({
        severity: "error",
        ...(currentFile() ? { file: currentFile() } : {}),
        message: `File ${name} not found`,
        code: isPackage ? "missing-package" : "missing-file",
        ...(isPackage ? { suggestion: packageSuggestion(name, kind) ?? "" } : {}),
      });
      continue;
    }

    // ── the classic channel: "! <message>", context "l.<n> …" follows ──────
    if (line.startsWith("! ")) {
      const message = line.slice(2).trim();
      let lineNumber: number | undefined;
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
        const context = /^l\.(\d+)/.exec(lines[j] ?? "");
        if (context) {
          lineNumber = Number.parseInt(context[1]!, 10);
          break;
        }
      }
      push({
        severity: "error",
        ...(currentFile() ? { file: currentFile() } : {}),
        ...(lineNumber !== undefined ? { line: lineNumber } : {}),
        message,
        code: message.includes("Undefined control sequence") ? "undefined-control-sequence" : "other",
        detail: lines.slice(i, Math.min(i + 4, lines.length)).join("\n").slice(0, MAX_DETAIL),
      });
      continue;
    }

    // ── tectonic's own framing ─────────────────────────────────────────────
    const tectonic = /^(error|warning): (.+)$/.exec(line);
    if (tectonic) {
      push({
        severity: tectonic[1] === "error" ? "error" : "warning",
        message: tectonic[2]!.trim(),
        code: "other",
      });
      continue;
    }

    // ── warnings ───────────────────────────────────────────────────────────
    const warning = /^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.+)$/.exec(line);
    if (warning) {
      const block = joinBlock(lines, i);
      i = block.end;
      const text = block.text.replace(/^(?:LaTeX|Package \S+|Class \S+) Warning:\s*/, "");
      const onLine = /on input line (\d+)/.exec(text);
      const code: LatexDiagnosticCode | undefined = /Citation [`'].+' .*undefined/.test(text)
        ? "citation-undefined"
        : /Reference [`'].+' .*undefined|There were undefined references/.test(text)
          ? "undefined-reference"
          : undefined;
      push({
        severity: "warning",
        ...(currentFile() ? { file: currentFile() } : {}),
        ...(onLine ? { line: Number.parseInt(onLine[1]!, 10) } : {}),
        message: text,
        ...(code ? { code, ...(code === "undefined-reference" || code === "citation-undefined" ? { suggestion: "Compile again — references settle on the second pass; if it persists, the label is genuinely missing." } : {}) } : {}),
      });
      continue;
    }

    const overfull = /^Overfull \\[hv]box \(([^)]+)\) in paragraph at lines (\d+)--(\d+)/.exec(line);
    if (overfull) {
      push({
        severity: "warning",
        ...(currentFile() ? { file: currentFile() } : {}),
        line: Number.parseInt(overfull[2]!, 10),
        message: `Overfull box (${overfull[1]}) at lines ${overfull[2]}–${overfull[3]}`,
        code: "overfull",
      });
    }
  }

  return diagnostics;
}

/** One sentence for the journal event — the first error, or nothing. */
export function firstErrorSentence(diagnostics: LatexDiagnostic[]): string | undefined {
  const first = diagnostics.find((d) => d.severity === "error");
  if (!first) return undefined;
  const where = first.file ? ` (${first.file}${first.line ? `:${first.line}` : ""})` : "";
  return `${first.message}${where}`.slice(0, 200);
}
