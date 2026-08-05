import {
  getAccount,
  getProxyKey,
  readProxyConfig,
  setUpstreamPrefix,
  upsertAccount,
  type ProviderId,
} from "@telar/core";

export const dynamic = "force-dynamic";

// ADOPT AN UPSTREAM AS A TELAR ACCOUNT.
//
// The gateway pools its credentials by default — a routed account gets whichever
// login the routing strategy picks. Adopting turns one of those logins into a
// named, selectable Telar account by PINNING it:
//
//   1. set a `prefix` on the credential (the one write Telar makes to the
//      gateway, user-initiated and never part of a refresh), after which the
//      gateway also registers that credential's models as `<prefix>/<model>`
//   2. create a Telar account carrying `proxy: { prefix }`, so every turn it
//      runs resolves to that upstream and no other
//
// The account name is the STABLE KEY (manifests and the ledger reference it), so
// it is validated the same way the accounts API validates it, and an existing
// account of that name is refused rather than silently repointed at a different
// login.
const NAME_RE = /^[a-zA-Z0-9._-]+$/;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const { upstream, accountName, prefix, provider, displayName, accentColor } = (body ?? {}) as {
    upstream?: unknown;
    accountName?: unknown;
    prefix?: unknown;
    provider?: unknown;
    displayName?: unknown;
    accentColor?: unknown;
  };

  if (typeof upstream !== "string" || !upstream.trim())
    return Response.json({ error: "Which upstream credential?" }, { status: 400 });
  if (typeof accountName !== "string" || !NAME_RE.test(accountName.trim()))
    return Response.json(
      { error: "Account name may only contain letters, numbers, dot, dash, or underscore." },
      { status: 400 },
    );
  const name = accountName.trim();
  // The prefix defaults to the account name — one fewer thing to invent, and it
  // keeps the two readable together in the model picker (`work/claude-opus-4-6`).
  const pin = (typeof prefix === "string" && prefix.trim()) || name;
  if (!NAME_RE.test(pin))
    return Response.json({ error: "Prefix may only contain letters, numbers, dot, dash, or underscore." }, { status: 400 });

  if (getAccount(name))
    return Response.json(
      { error: `"${name}" already exists. Pick another name, or remove it first.` },
      { status: 400 },
    );

  const cfg = readProxyConfig();
  if (!cfg.enabled)
    return Response.json({ error: "The CLIProxyAPI gateway is switched off." }, { status: 400 });

  // Pin on the gateway FIRST. If this fails there is nothing to undo — an
  // account created against an unpinned upstream would look pinned in Telar
  // while silently taking the pool's choice, which is the one outcome worth
  // preventing here.
  const pinned = await setUpstreamPrefix(cfg.url, getProxyKey("management"), upstream.trim(), pin);
  if (!pinned.ok) return Response.json({ error: pinned.error }, { status: 400 });

  try {
    const account = upsertAccount({
      name,
      // Narrowing, not a fork: `provider` arrives as untrusted JSON and has to
      // land on the union before an account is written with it. Both arms do
      // the same thing with the result.
      provider: (provider === "codex" ? "codex" : "claude") as ProviderId,
      authMode: "subscription",
      proxy: { prefix: pin },
      ...(typeof displayName === "string" && displayName.trim()
        ? { displayName: displayName.trim() }
        : {}),
      ...(typeof accentColor === "string" && accentColor.trim()
        ? { accentColor: accentColor.trim() }
        : {}),
    });
    return Response.json({ account, prefix: pin });
  } catch (e) {
    // The upstream is pinned but the account was refused (an adoption rule).
    // Say both halves, so the state on the gateway is never a silent surprise.
    return Response.json(
      {
        error: `${e instanceof Error ? e.message : String(e)} (the upstream was pinned as "${pin}" — re-run with a different name, or clear the prefix in the gateway.)`,
      },
      { status: 400 },
    );
  }
}
