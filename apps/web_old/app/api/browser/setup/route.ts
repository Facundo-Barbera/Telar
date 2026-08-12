import { installControlledBrowser } from "@/lib/server/browser-runtime";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const message = await installControlledBrowser();
    return Response.json({ ok: true, message });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
