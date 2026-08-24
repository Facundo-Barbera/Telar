import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { engineClient, engineErrorResponse, requestObject, optionalString } from "@/lib/engine/engine-server";
import { appendEvent, newLoom, slugify, writeSpec } from "@/lib/looms/store";
import { initialPhases, loadMethod } from "@/lib/looms/methods";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const exec = promisify(execFile);

/** The scheduler CLI — the weaver reads the env contract through it. */
const ENV_CLI = join(process.cwd(), "..", "..", "packages", "env", "src", "cli.ts");

interface ProposalThread {
  title: string;
  slug: string;
  brief: string;
  contract: string;
  tier: string | null;
}

/** Which verification tiers the project's env contract actually defines. */
async function projectTiers(projectRoot: string): Promise<string[]> {
  try {
    const { stdout } = await exec("bun", [ENV_CLI, "context"], { cwd: projectRoot, timeout: 30_000 });
    const context = JSON.parse(stdout) as { contract?: { env?: { tiers?: Record<string, unknown> } } | null };
    return Object.keys(context.contract?.env?.tiers ?? {});
  } catch {
    return [];
  }
}

/**
 * The weaver — the agent that turns a conversation (or a bare objective) into
 * a loom proposal (docs/loom-model-v1.md).
 *
 * Two entrances:
 *   { sessionId }              — SPIN: the origin conversation is the input.
 *   { projectId, objective }   — the degenerate case, no origin.
 *
 * It reads the project (read-only tools) and returns threads, each with a
 * brief, a human-readable CONTRACT, and a TIER binding the contract to the
 * project's env contract — prose alone does not verify anything. The proposal
 * is exactly that: nothing is created here. The human approves it on /looms
 * and only then do sessions spawn. Runs through the claude CLI so this app
 * needs no SDK dependency and the weaver can never outlive the request.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const sessionId = optionalString(body.sessionId, "sessionId");
    let projectId = optionalString(body.projectId, "projectId");
    let objective = optionalString(body.objective, "objective");
    const client = await engineClient();

    let conversation = "";
    if (sessionId) {
      const snapshot = await client.session(sessionId);
      projectId = snapshot.session.projectId;
      const turns = snapshot.turns.slice(-8);
      conversation = turns
        .flatMap((turn) => [
          `HUMANO: ${turn.input.slice(0, 800)}`,
          ...(turn.resultText ? [`AGENTE: ${turn.resultText.slice(0, 1200)}`] : []),
        ])
        .join("\n\n");
      objective = objective ?? snapshot.session.title;
    }
    if (!projectId || (!objective && !conversation)) {
      return Response.json(
        { error: { code: "invalid_request", message: "pass sessionId (spin) or projectId + objective" } },
        { status: 400 },
      );
    }
    const { projects } = await client.listProjects();
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      return Response.json({ error: { code: "not_found", message: `no project ${projectId}` } }, { status: 404 });
    }
    const tiers = await projectTiers(project.root);

    // Machine prompt in English; the WORK-FACING text (briefs, contracts,
    // titles) follows the project's language — language is content.
    const prompt = [
      "You are Telar's weaver: you turn an intention into a plan of parallel threads.",
      conversation
        ? `This conversation is the loom's ORIGIN — the objective comes from here, do not invent one:\n"""\n${conversation}\n"""`
        : `The human's objective for this project:\n"""${objective}"""`,
      "Explore the repo just enough (README, docs, structure) to decompose well.",
      "Decompose into 2 to 5 parallel, independent threads (each will run as an agent in its own worktree, on a loom/<loom>/<thread> branch). Broad before deep; group by shared root cause.",
      "For each thread: `title`; `slug` (short kebab-case, names the WORK, not the machinery); an actionable `brief` (context + what to do); a legible `contract`: what must be demonstrably true to accept, verifiable by someone who did not write it. Write titles, briefs and contracts in the PROJECT'S OWN LANGUAGE (the language of its README, issues and conversation).",
      tiers.length > 0
        ? `And \`tier\`: the executable verification tier that backs the contract. Tiers defined in this project's environment contract: ${tiers.join(", ")}. Pick the cheapest one that actually proves the contract. If NONE proves it, set null and say so in the contract — a tierless contract is visible, never invented.`
        : "This project defines no verification tiers (no environment contract). Set `tier: null` on every thread and make the contract just as concrete.",
      'Reply ONLY with valid JSON, no markdown: {"title": "...", "objective": "one sentence distilling the objective", "threads": [{"title": "...", "slug": "...", "brief": "...", "contract": "...", "tier": "..." | null}]}',
    ].join("\n\n");

    const { stdout } = await exec(
      "claude",
      ["-p", prompt, "--output-format", "json", "--model", "sonnet", "--max-turns", "25", "--allowedTools", "Read,Glob,Grep"],
      { cwd: project.root, timeout: 280_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    if (envelope.is_error || !envelope.result) {
      return Response.json({ error: { code: "weaver_failed", message: envelope.result ?? "no result" } }, { status: 502 });
    }
    const match = envelope.result.match(/\{[\s\S]*\}/);
    if (!match) {
      return Response.json({ error: { code: "weaver_unparseable", message: envelope.result.slice(0, 400) } }, { status: 502 });
    }
    const proposal = JSON.parse(match[0]) as { title: string; objective?: string; threads: ProposalThread[] };
    if (!Array.isArray(proposal.threads) || proposal.threads.length === 0) {
      return Response.json({ error: { code: "weaver_empty", message: "the weaver proposed no threads" } }, { status: 502 });
    }
    const usedSlugs = new Set<string>();
    const threads = proposal.threads.map((t) => {
      let slug = slugify(t.slug || t.title);
      while (usedSlugs.has(slug)) slug = `${slug}-2`;
      usedSlugs.add(slug);
      return {
        slug,
        title: t.title,
        brief: t.brief,
        ...(t.contract ? { contract: t.contract } : {}),
        // A tier the contract does not define would fail at verify time with a
        // confusing error; refuse it here where the fix is obvious.
        ...(t.tier && tiers.includes(t.tier) ? { tier: t.tier } : {}),
      };
    });

    /**
     * THE PROPOSAL IS A LOOM NOW — a draft one, parked at the execute gate.
     * It used to live only in React state, where a page refresh silently ate
     * the weaver's work. As a draft loom it survives navigation, shows in the
     * rail, and its spec document exists on disk from the first moment: the
     * conductor's memory starts here.
     */
    const finalObjective = proposal.objective ?? objective ?? "";
    const loom = newLoom({
      title: proposal.title,
      objective: finalObjective,
      projectId,
      method: "weave",
      phases: initialPhases(loadMethod("weave")),
      threads,
      ...(sessionId ? { originSessionId: sessionId } : {}),
    });
    writeSpec(
      loom.id,
      [
        `# ${loom.title}`,
        `\nObjective: ${finalObjective}`,
        sessionId ? `Origin: session ${sessionId}` : "Origin: bare objective (programmatic)",
        `Method: weave · Project: ${project.name}`,
        `\n## Threads`,
        ...threads.map((t) =>
          [
            `\n### ${t.title} (\`${t.slug}\`)`,
            t.brief,
            t.contract ? `\n**Contract:** ${t.contract}` : "",
            `**Tier:** ${t.tier ?? "none — contract is prose-only"}`,
          ].join("\n"),
        ),
      ].join("\n"),
    );
    appendEvent(loom.id, { actor: "weaver", kind: "proposal", detail: `proposed ${threads.length} threads (${threads.map((t) => t.slug).join(", ")})` });
    return Response.json({ loomId: loom.id }, { status: 201 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
