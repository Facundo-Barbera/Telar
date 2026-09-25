import { isNotifyOn, readNotifyOn, writeNotifyOn } from "@/lib/mobile/desktop";

/**
 * "NOTIFY ON" — which device an alert goes to (lib/mobile/desktop.ts
 * `notifyRoute`). Read by the push worker on every pass, so a change here takes
 * effect on the next transition without restarting anything.
 *
 * Behind the same /api gate as every other setting: an observer may read it
 * and only a full-role caller may change it.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json({ notifyOn: readNotifyOn() });
}

export async function PUT(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { body = undefined; }
  const notifyOn = (body as { notifyOn?: unknown } | undefined)?.notifyOn;
  if (!isNotifyOn(notifyOn)) return Response.json({ error: { message: "notifyOn must be mac, iphone or both." } }, { status: 400 });
  try {
    writeNotifyOn(notifyOn);
  } catch {
    return Response.json({ error: { message: "Couldn't save the notification setting." } }, { status: 503 });
  }
  return Response.json({ notifyOn });
}
