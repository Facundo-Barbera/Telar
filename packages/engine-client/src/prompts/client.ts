import type { EngineTransport } from "../platform/transport";
import type { PreparedPrompt, PreparedPromptAuthor } from "./schema";

const promptsPath = (projectId: string) => `/v2/projects/${encodeURIComponent(projectId)}/prompts`;
const promptPath = (projectId: string, promptId: string) => `${promptsPath(projectId)}/${encodeURIComponent(promptId)}`;

export const promptsClient = {
  projectPrompts(this: EngineTransport, projectId: string): Promise<{ prompts: PreparedPrompt[] }> {
    return this.request("GET", promptsPath(projectId));
  },

  /** `text` may not be blank. */
  createProjectPrompt(
    this: EngineTransport,
    projectId: string,
    input: { title: string; text: string; reason?: string; sessionId?: string; author?: PreparedPromptAuthor },
  ): Promise<{ prompt: PreparedPrompt }> {
    return this.request("POST", promptsPath(projectId), input);
  },

  updateProjectPrompt(
    this: EngineTransport,
    projectId: string,
    promptId: string,
    patch: { title?: string; text?: string; reason?: string },
  ): Promise<{ prompt: PreparedPrompt }> {
    return this.request("PATCH", promptPath(projectId, promptId), patch);
  },

  deleteProjectPrompt(this: EngineTransport, projectId: string, promptId: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", promptPath(projectId, promptId));
  },
};
