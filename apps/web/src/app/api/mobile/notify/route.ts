import { engineForward } from "@/lib/engine/forward";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return engineForward(request, "/v2/push/notify-on");
}

export function PUT(request: Request) {
  return engineForward(request, "/v2/push/notify-on");
}
