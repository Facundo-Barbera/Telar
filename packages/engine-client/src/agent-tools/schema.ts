import { z } from "zod";
import { Id, Timestamp } from "../protocol/common";

const McpOAuthOverrides = z.object({
  authorizationServer: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).optional(),
});

export const McpServerSpec = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    transport: z.literal("http"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: McpOAuthOverrides.optional(),
  }),
  z.object({
    transport: z.literal("sse"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: McpOAuthOverrides.optional(),
  }),
]);
export type McpServerSpec = z.infer<typeof McpServerSpec>;

export const McpOAuthStatus = z.object({
  serverId: Id,
  projectId: Id.optional(),
  requiresOAuth: z.boolean(),
  connected: z.boolean(),
  expiresAt: Timestamp.optional(),
  scope: z.string().optional(),
  issuer: z.string().optional(),
  health: z.enum(["connected", "needs-auth", "error", "unknown"]),
  message: z.string().min(1).optional(),
});
export type McpOAuthStatus = z.infer<typeof McpOAuthStatus>;

export const McpServer = z.object({
  id: Id,
  projectId: Id.optional(),
  label: z.string().min(1),
  enabled: z.boolean(),
  spec: McpServerSpec,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type McpServer = z.infer<typeof McpServer>;

export const ArtifactKind = z.enum(["html", "svg", "markdown", "mermaid"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const ArtifactId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const MAX_ARTIFACT_BYTES = 512 * 1024;

/** One version of something an agent drew inline; the content is the attachment's bytes. */
export const Artifact = z.object({
  id: ArtifactId,
  kind: ArtifactKind,
  title: z.string().min(1).max(200),
  attachmentId: Id,
  version: z.number().int().positive(),
});
export type Artifact = z.infer<typeof Artifact>;

export function resolveMcpServers(servers: readonly McpServer[], projectId: string | undefined): McpServer[] {
  const scoped = servers.filter((server) => server.projectId === projectId);
  const shadowed = new Set(scoped.map((server) => server.id));
  const global = servers.filter((server) => server.projectId === undefined && !shadowed.has(server.id));
  return [...global, ...scoped];
}
