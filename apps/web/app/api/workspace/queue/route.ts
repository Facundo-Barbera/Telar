import { getQueueView } from "@/lib/workspace-api";

// The store is read at request time, same as apps/web/app/api/looms/route.ts.
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getQueueView());
}
