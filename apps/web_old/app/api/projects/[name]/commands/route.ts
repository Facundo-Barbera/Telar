import { getProject } from "@telar/core";
import { listProjectCommands } from "@/lib/commands";

export const dynamic = "force-dynamic";

// Lists the project's custom slash commands, scanned from
// <projectRoot>/.claude/commands/**/*.md — see lib/commands.ts for the scan
// (name derivation + description parsing) and its security notes.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  let root: string;
  try {
    root = getProject(name).manifest.root;
  } catch {
    return Response.json(
      { error: `Unknown project "${name}".` },
      { status: 404 },
    );
  }

  return Response.json({ commands: listProjectCommands(root) });
}
