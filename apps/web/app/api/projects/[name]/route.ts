import { getProject, unregisterProject, writeManifest, ProjectManifest } from "@telar/core";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ACCOUNTS } from "@/lib/accounts";

export const dynamic = "force-dynamic";

// Edit a repo's manifest in place. name/root are immutable identity; account
// must resolve to a real profile. The merged object is re-validated before it
// hits disk, so a bad partial can never corrupt telar.yaml.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  let entry;
  let manifest;
  try {
    ({ entry, manifest } = getProject(name));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }

  const body = await req.json().catch(() => ({}));

  if ("name" in body && body.name !== manifest.name) {
    return Response.json({ error: "name is immutable." }, { status: 400 });
  }
  if ("root" in body && body.root !== manifest.root) {
    return Response.json({ error: "root is immutable." }, { status: 400 });
  }
  if (body.account != null && !(body.account in ACCOUNTS)) {
    return Response.json(
      { error: `Unknown account "${body.account}".` },
      { status: 400 },
    );
  }

  // `manifest` (from getProject/loadManifest) has already been through
  // ProjectManifest.safeParse().data, which silently drops any field not in
  // the schema. Re-read the file ourselves so fields we don't know about
  // (and anything a newer Telar version might add) survive the round trip
  // instead of being deleted on every save. We also snapshot the raw text so
  // we can detect a concurrent write below.
  const manifestPath = path.join(entry.root, "telar.yaml");
  let rawText: string;
  let rawManifest: Record<string, unknown>;
  try {
    rawText = fs.readFileSync(manifestPath, "utf8");
    rawManifest = (YAML.parse(rawText) ?? {}) as Record<string, unknown>;
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }

  const rawGuardrails =
    (rawManifest.guardrails as Record<string, unknown> | undefined) ?? {};

  const merged = {
    ...rawManifest,
    ...(body.account != null ? { account: body.account } : {}),
    ...(body.baseBranch != null ? { baseBranch: body.baseBranch } : {}),
    ...(body.adapter != null ? { adapter: body.adapter } : {}),
    ...(body.gates != null ? { gates: body.gates } : {}),
    ...(body.guardrails != null
      ? { guardrails: { ...rawGuardrails, ...body.guardrails } }
      : {}),
  };

  // Validate the merged result — this checks only the fields the schema
  // knows about; unrecognized keys in `merged` are left alone (zod's default
  // object mode ignores, rather than rejects, unknown keys).
  const parsed = ProjectManifest.safeParse(merged);
  if (!parsed.success) {
    return Response.json(
      { error: z.prettifyError(parsed.error) },
      { status: 400 },
    );
  }

  // Optimistic concurrency: if the file on disk changed since we read it
  // (another PATCH landed in between), refuse to overwrite it with a merge
  // built from our now-stale snapshot — the caller should re-fetch and retry
  // rather than silently clobber the other write.
  let currentText: string;
  try {
    currentText = fs.readFileSync(manifestPath, "utf8");
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }
  if (currentText !== rawText) {
    return Response.json(
      {
        error:
          "telar.yaml changed on disk since it was loaded — reload the project and try again.",
      },
      { status: 409 },
    );
  }

  // Write `merged` (raw file + validated overrides), not `parsed.data`, so
  // unrecognized fields survive instead of being stripped by the schema.
  writeManifest(entry.root, merged as ProjectManifest);
  return Response.json({ manifest: merged });
}

// Forget a repo — drops the registry entry, leaves the repo (and its telar.yaml) untouched.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  return Response.json({ ok: unregisterProject(name) });
}
