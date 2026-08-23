import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { engineClient, engineErrorResponse, requestObject, optionalString } from "@/lib/engine/engine-server";

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

    const prompt = [
      "Sos el weaver de Telar: convertís una intención en un plan de threads paralelos.",
      conversation
        ? `Esta conversación es el ORIGEN del loom — el objetivo sale de acá, no lo inventes:\n"""\n${conversation}\n"""`
        : `Objetivo del humano para este proyecto:\n"""${objective}"""`,
      "Explorá el repo lo justo (README, docs, estructura) para descomponer bien.",
      "Descomponé en 2 a 5 threads paralelos e independientes (cada uno correrá como agente en su propio worktree, en una rama loom/<loom>/<thread>). Amplio antes que profundo; agrupá por causa raíz compartida.",
      "Para cada thread: `title`; `slug` (kebab-case corto, nombra el TRABAJO, no la maquinaria); `brief` accionable (contexto + qué hacer, en el idioma del repo); `contract` legible: qué tiene que ser demostrablemente cierto para aceptar, verificable por alguien que no lo escribió.",
      tiers.length > 0
        ? `Y \`tier\`: el tier de verificación ejecutable que respalda el contrato. Tiers definidos en el contrato de entorno de este proyecto: ${tiers.join(", ")}. Elegí el más barato que realmente pruebe el contrato. Si NINGUNO lo prueba, poné null y decilo en el contract — un contrato sin tier es visible, no inventado.`
        : "Este proyecto no define tiers de verificación (sin contrato de entorno). Poné `tier: null` en cada thread y hacé el contract igual de concreto.",
      'Respondé SOLO con JSON válido, sin markdown: {"title": "...", "objective": "una frase con el objetivo destilado", "threads": [{"title": "...", "slug": "...", "brief": "...", "contract": "...", "tier": "..." | null}]}',
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
    const threads = proposal.threads.map((t) => ({
      ...t,
      // A tier the contract does not define would fail at verify time with a
      // confusing error; refuse it here where the fix is obvious.
      tier: t.tier && tiers.includes(t.tier) ? t.tier : null,
    }));
    return Response.json({
      projectId,
      objective: proposal.objective ?? objective ?? "",
      title: proposal.title,
      threads,
      tiers,
      ...(sessionId ? { originSessionId: sessionId } : {}),
    });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
