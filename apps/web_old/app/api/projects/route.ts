import {
  listProjects,
  registerOrCreateProject,
} from "@telar/core/manifest";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ projects: listProjects() });
}

// Register a repo, preserving its telar.yaml or creating one when absent.
export async function POST(req: Request) {
  let body: {
    root?: string;
    manifest?: { name?: unknown };
    addToGitignore?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { root, manifest, addToGitignore } = body;
  if (typeof root !== "string" || root.trim() === "") {
    return Response.json(
      { error: "A repo `root` path is required." },
      { status: 400 },
    );
  }
  if (
    manifest?.name !== undefined &&
    (typeof manifest.name !== "string" || manifest.name.trim() === "")
  ) {
    return Response.json(
      { error: "Project name must be a non-empty string when provided." },
      { status: 400 },
    );
  }

  try {
    const result = registerOrCreateProject(
      root,
      typeof manifest?.name === "string"
        ? { name: manifest.name.trim() }
        : undefined,
      {
        addToGitignore: addToGitignore === true,
      },
    );
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
