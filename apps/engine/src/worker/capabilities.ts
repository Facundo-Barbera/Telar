import type { WorkerClaim } from "@telar/engine-client";
import { pluginCall, pluginToolModules } from "../domains/plugins";
import { notesCapability } from "../domains/notes";
import { sessionsCapability, windowedReads } from "../domains/sessions";
import { promptsForComposer, type PromptsCapability } from "../domains/prompts";
import { createDisplayCapability } from "../domains/agent-tools";
import { clientRunCapability } from "../domains/terminal";
import type { SessionsCapability } from "../drivers";
import type { UsageDiagnosisCapability } from "../domains/usage";
import type { WorkerClient } from "./options";
import type { TurnHost } from "./host";

/** The prompt shelf. A draft reports itself so the cockpit hears now; a failed report is swallowed because the prompt landed. */
function promptsCapability(client: WorkerClient, projectId: string, sessionId: string, report: (observation: { kind: "prompt.drafted"; promptId: string; title: string; forSessionId?: string }) => Promise<unknown>): PromptsCapability {
  return {
    self: { projectId, sessionId },
    list: async () => promptsForComposer((await client.projectPrompts(projectId)).prompts, sessionId),
    create: async (input) => {
      const prompt = (await client.createProjectPrompt(projectId, { ...input, author: "session" })).prompt;
      await report({
        kind: "prompt.drafted",
        promptId: prompt.id,
        title: prompt.title,
        ...(prompt.sessionId ? { forSessionId: prompt.sessionId } : {}),
      }).catch(() => undefined);
      return prompt;
    },
    remove: async (promptId) => (await client.deleteProjectPrompt(projectId, promptId)).deleted,
  };
}

/** Each enabled plugin's capability by id; an id this binary does not bundle is looked for once, then absent. */
function pluginCapabilities(host: TurnHost, sessionId: string, enabled: string[] | undefined) {
  const unknown = (enabled ?? []).filter((id) => !host.pluginsLookedFor.has(id) && !pluginToolModules().some((module) => module.meta.id === id));
  if (unknown.length > 0) {
    for (const id of unknown) host.pluginsLookedFor.add(id);
    host.options.refreshPlugins?.();
  }
  return Object.fromEntries(
    pluginToolModules()
      .filter((module) => enabled?.includes(module.meta.id))
      .map((module) => [module.meta.id, module.capability(pluginCall(host.options.client, sessionId, module.meta.id))]),
  );
}

/** Everything the `telar` wall serves this turn, for the in-process server and the socket lease alike. */
export function telarCapabilities(host: TurnHost, claim: WorkerClaim, runId: string, claimToken: string) {
  const { client } = host.options;
  const { sessionId, projectId, projectRoot: cwd } = claim;
  if (claim.readOnly) return { usageDiagnosis: { call: async (tool, args) => (await client.usageDiagnosisTool(sessionId, tool, args)).text } satisfies UsageDiagnosisCapability };
  const report = (observations: Parameters<WorkerClient["reportObservations"]>[3]) => client.reportObservations(sessionId, runId, claimToken, observations);
  const shared = sessionsCapability(client, { sessionId, proof: () => host.liveClaims.get(sessionId) ?? { runId, claimToken } }, windowedReads(client));
  const sessions: SessionsCapability = {
    ...shared,
    send: async (id, input) => {
      const accepted = await shared.send(id, input);
      return { turn: accepted.turn, replayed: accepted.replayed };
    },
  };
  const notes = projectId
    ? notesCapability(client, {
        projectId,
        read: async (noteId) => {
          try {
            return { note: (await client.projectNote(projectId, noteId)).note, projectId };
          } catch {
            return null;
          }
        },
        updateFailureAsNull: true,
      })
    : undefined;
  const prompts = projectId ? promptsCapability(client, projectId, sessionId, (observation) => report([observation])) : undefined;
  const plugins = pluginCapabilities(host, sessionId, claim.plugins);
  const display =
    cwd === undefined
      ? undefined
      : createDisplayCapability({
          cwd,
          report: (observation) => report([observation]).then(() => undefined),
          upload: async (file) => (await client.uploadAttachment(sessionId, file)).attachment,
        });
  const run = projectId && cwd ? clientRunCapability(client, sessionId) : undefined;
  return {
    sessions,
    ...(notes ? { notes } : {}),
    ...(prompts ? { prompts } : {}),
    ...(display ? { display } : {}),
    ...(run ? { run } : {}),
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
  };
}
