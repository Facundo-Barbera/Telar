import type { GhResult, GhRunner } from "./gh";

export const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: "" });
export const failed = (stderr: string, status = 1): GhResult => ({ status, stdout: "", stderr });

export function runner(replies: Record<string, GhResult>): GhRunner {
  return async (_cwd, args) => replies[args[0] ?? ""] ?? failed("unexpected call");
}

export function verbRunner(replies: Record<string, GhResult | GhResult[]>, seen?: string[][]): GhRunner {
  const drawn = new Map<string, number>();
  return async (_cwd, args) => {
    seen?.push(args);
    const key = args.slice(0, 2).join(" ");
    const reply = replies[key];
    if (!reply) return failed(`unexpected call: ${key}`);
    if (!Array.isArray(reply)) return reply;
    const at = drawn.get(key) ?? 0;
    drawn.set(key, at + 1);
    return reply[Math.min(at, reply.length - 1)]!;
  };
}

export const iso = (day: number) => `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`;
