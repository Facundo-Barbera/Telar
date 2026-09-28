import { agentToolsClient } from "../agent-tools/client";
import { appearanceClient } from "../appearance/client";
import { browserClient } from "../browser/client";
import { computerUseClient } from "../computer-use/client";
import { dictationClient } from "../dictation/client";
import { filesClient } from "../files/client";
import { gitClient } from "../git/client";
import { githubClient } from "../github/client";
import { notesClient } from "../notes/client";
import { pluginsClient } from "../plugins/client";
import { projectsClient } from "../projects/client";
import { promptsClient } from "../prompts/client";
import { providersClient } from "../providers/client";
import { schedulesClient } from "../schedules/client";
import { settingsClient } from "../settings/client";
import { storageClient } from "../storage/client";
import { terminalClient } from "../terminal/client";
import { usageClient } from "../usage/client";
import { worktreesClient } from "../worktrees/client";
import type { EngineTransport } from "./transport";

type Methods<T> = { [K in keyof T]: OmitThisParameter<T[K]> };

export const domainClients = [agentToolsClient, appearanceClient, browserClient, computerUseClient, dictationClient, filesClient, gitClient, githubClient, notesClient, pluginsClient, projectsClient, promptsClient, providersClient, schedulesClient, settingsClient, storageClient, terminalClient, usageClient, worktreesClient];

export type EngineDomainMethods = Methods<typeof agentToolsClient> &
  Methods<typeof appearanceClient> &
  Methods<typeof browserClient> &
  Methods<typeof computerUseClient> &
  Methods<typeof dictationClient> &
  Methods<typeof filesClient> &
  Methods<typeof gitClient> &
  Methods<typeof githubClient> &
  Methods<typeof notesClient> &
  Methods<typeof pluginsClient> &
  Methods<typeof projectsClient> &
  Methods<typeof promptsClient> &
  Methods<typeof providersClient> &
  Methods<typeof schedulesClient> &
  Methods<typeof settingsClient> &
  Methods<typeof storageClient> &
  Methods<typeof terminalClient> &
  Methods<typeof usageClient> &
  Methods<typeof worktreesClient>;

export function domainMethods(transport: EngineTransport): EngineDomainMethods {
  const bound: Record<string, unknown> = {};
  for (const client of domainClients) {
    for (const [name, method] of Object.entries(client)) bound[name] = (method as (this: EngineTransport, ...args: unknown[]) => unknown).bind(transport);
  }
  return bound as EngineDomainMethods;
}
