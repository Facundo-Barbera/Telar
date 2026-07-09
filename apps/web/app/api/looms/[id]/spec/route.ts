import {
  bundleVersion,
  CONTRACT_FILE,
  getLoom,
  listBundleFiles,
  PROVENANCE_FILE,
  readBundleFile,
  readContract,
  readProvenance,
} from "@telar/core";

const INTERNAL_BUNDLE_FILES = new Set([CONTRACT_FILE, PROVENANCE_FILE, "objective.md"]);

export const dynamic = "force-dynamic";

// Bundle metadata only (docs/loom-model.md §2) — the file list + the parsed
// Verification Contract + provenance + objective text. Never inlines
// arbitrary file contents (the bundle can hold binaries); fetch a single
// file via /api/looms/[id]/spec/[...path] instead.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getLoom(id)) {
    return Response.json({ error: "Loom not found." }, { status: 404 });
  }

  const { contract, errors: contractErrors } = readContract(id);
  const { provenance } = readProvenance(id);
  const objective = readBundleFile(id, "objective.md");

  return Response.json({
    version: bundleVersion(id),
    files: listBundleFiles(id).filter((f) => !INTERNAL_BUNDLE_FILES.has(f)),
    contract,
    contractErrors,
    provenance,
    objective,
  });
}
