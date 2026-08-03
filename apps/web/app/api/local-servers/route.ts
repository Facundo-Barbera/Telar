import { discoverLocalServers } from "@/lib/server/local-server-discovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Read-only machine-local discovery. The server scanner returns a deliberately
// narrow projection: process label, listening port, and localhost URL.
export async function GET() {
  return Response.json(
    { servers: await discoverLocalServers() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
