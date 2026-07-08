import {
  createProject,
  listProjects,
  registerProject,
  type ProjectManifest,
} from "@telar/core";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ projects: listProjects() });
}

// Register an existing telar repo, or scaffold a fresh telar.yaml when create=true.
export async function POST(req: Request) {
  let body: {
    root?: string;
    create?: boolean;
    manifest?: Partial<ProjectManifest>;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { root, create, manifest } = body;
  if (typeof root !== "string" || root.trim() === "") {
    return Response.json({ error: "A repo `root` path is required." }, { status: 400 });
  }

  try {
    const result = create ? createProject(root, manifest) : registerProject(root);
    return Response.json({ manifest: result });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
