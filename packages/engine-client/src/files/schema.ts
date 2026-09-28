import { z } from "zod";
import { Timestamp } from "../protocol/common";
import { ProjectAvailability } from "../protocol/entities";

const WorkspaceListingSource = z.enum(["git", "walk"]);

export const WorkspaceListing = z.object({
  workspacePath: z.string().min(1),
  repository: z.boolean(),
  files: z.array(z.string().min(1)),
  source: WorkspaceListingSource,
  truncated: z.boolean(),
  readAt: Timestamp,
  availability: ProjectAvailability.optional(),
});
export type WorkspaceListing = z.infer<typeof WorkspaceListing>;

export const WorkspaceFile = z.object({
  path: z.string().min(1),
  text: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

const WorkspaceWriteRefusal = z.enum(["not_found", "binary", "too_large", "conflict"]);

export const WorkspaceWriteResult = z.union([
  z.object({ written: z.literal(true), file: WorkspaceFile }),
  z.object({ written: z.literal(false), refusal: WorkspaceWriteRefusal, sha256: z.string().min(1).optional() }),
]);
export type WorkspaceWriteResult = z.infer<typeof WorkspaceWriteResult>;

export type DirectoryEntry = {
  name: string;
  path: string;
  git: boolean;
  hidden: boolean;
};

export type DirectoryListing = {
  path: string;
  name: string;
  parent: string | null;
  home: string;
  roots: { name: string; path: string }[];
  dirs: DirectoryEntry[];
  truncated: boolean;
  missing?: string;
  gitPartial?: boolean;
};
