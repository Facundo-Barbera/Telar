import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { engineClient, engineErrorResponse, requestObject, requiredString } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const exec = promisify(execFile);

/**
 * The weaver — the agent that turns an objective into a loom proposal.
 *
 * It reads the project (read-only tools) and returns 2–5 threads, each with a
 * brief and a VERIFICATION CONTRACT: what must be demonstrably true for the
 * thread to count as done. The proposal is exactly that — a proposal. Nothing
 * is created here; the human approves it on the /looms page and only then do
 * sessions spawn. Runs through the claude CLI so this app needs no SDK
 * dependency and the weaver can never outlive the request.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const projectId = requiredString(body.projectId, "projectId");
    const objective = requiredString(body.objective, "objective");
    const client = await engineClient();
    const { projects } = await client.listProjects();
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      return Response.json({ error: { code: "not_found", message: `no project ${projectId}` } }, { status: 404 });
    }

    const prompt = [
      `Sos el weaver de Telar. Objetivo del humano para este proyecto:\n"""${objective}"""`,
      "Explorá el repo lo justo (README, docs, estructura) para descomponer bien.",
      "Descomponé el objetivo en 2 a 5 threads paralelos e independientes (cada uno correrá como agente en su propio worktree). Amplio antes que profundo; agrupá por causa raíz compartida.",
      "Para cada thread: un brief accionable (contexto + qué hacer, en el idioma del repo) y un CONTRATO de verificación: qué tiene que ser demostrablemente cierto para aceptar el trabajo, verificable por alguien que no lo escribió.",
      'Respondé SOLO con JSON válido, sin markdown: {"title": "...", "threads": [{"title": "...", "brief": "...", "contract": "..."}]}',
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
    const proposal = JSON.parse(match[0]) as { title: string; threads: Array<{ title: string; brief: string; contract: string }> };
    if (!Array.isArray(proposal.threads) || proposal.threads.length === 0) {
      return Response.json({ error: { code: "weaver_empty", message: "the weaver proposed no threads" } }, { status: 502 });
    }
    return Response.json({ projectId, objective, ...proposal });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
