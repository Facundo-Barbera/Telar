import { removeAccount, setDefaultAccount } from "@telar/core";

export const dynamic = "force-dynamic";

// PATCH is the small-mutation lane: currently just "make this the default".
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const body = await req.json().catch(() => ({}));
  if (body.makeDefault === true) {
    try {
      setDefaultAccount(name);
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 404 },
      );
    }
  }
  return Response.json({ ok: true });
}

// Removes the registry entry and any stored token. The account's on-disk login
// (its config dir) is left untouched — that's the user's data, not ours.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  return Response.json({ ok: removeAccount(name) });
}
