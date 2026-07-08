import { readPlanUsage, usageSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    plan: readPlanUsage(), // real subscription windows, per account
    ledger: usageSummary(), // telar-measured API-equivalent $, secondary
  });
}
