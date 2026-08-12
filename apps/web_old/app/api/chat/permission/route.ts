import { resolvePending, pendingRuleOptions, isOfferedRule } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// The session UI answers a pending canUseTool request from the chat stream.
export async function POST(req: Request) {
  let body: { id?: unknown; behavior?: unknown; always?: unknown; rule?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { id, behavior, always, rule } = body;
  if (typeof id !== "string" || (behavior !== "allow" && behavior !== "deny")) {
    return Response.json({ error: "id and behavior allow|deny required" }, { status: 400 });
  }
  // An explicit rule choice (the user picked a narrower/broader option off
  // the permission card) must be exactly one of the options remembered for
  // THIS pending request — ruleOptionsFor's output, captured at
  // createPending time. Never trust a client-supplied rule string directly:
  // that would let a compromised/buggy client silently widen what "always
  // allow" persists beyond what was actually shown to the user.
  let chosenRule: string | undefined;
  if (rule !== undefined) {
    if (typeof rule !== "string" || !isOfferedRule(pendingRuleOptions(id) ?? [], rule)) {
      return Response.json(
        { error: "rule is not one of the options offered for this request" },
        { status: 400 },
      );
    }
    chosenRule = rule;
  }
  const ok = resolvePending(id, {
    behavior,
    always: !!always,
    ...(chosenRule ? { rule: chosenRule } : {}),
  });
  return Response.json({ ok }); // ok:false = already resolved, timed out, or unknown
}
