// Provider seam: the per-provider knobs that differ between Claude and Codex.
// Everything provider-specific about auth/config wiring lives here so the rest
// of the engine stays provider-neutral. This file was auth/config only — which
// SDK actually drives a turn is still layered on top of this in the web app —
// but it now ALSO publishes what each provider's harness can actually do (see
// CAPABILITIES below).
//
// CAPABILITIES. AD-11 reads: "a profile declares requiredCapabilities; the
// provider port publishes what it supports; an unmet requirement is a hard
// error before the stream opens." THIS is the provider port. The capability
// list lives on the same descriptor as the auth/config knobs for one reason:
// a second provider seam is exactly the failure AD-9/AD-20 exist to prevent.
// A surface that had to ask one module "which config dir?" and a different
// module "does this provider run hooks?" would have two places to forget to
// update when a third provider lands.
//
// Every member of ProviderCapability is MEASURED against apps/web/app/api/chat/
// route.ts, never invented: each names a real divergence between the Codex fork
// (the `provider === "codex"` branch, which calls runCodexTurn) and the Claude
// branch (which calls the Agent SDK's query()). The comments below cite the
// symbol that proves each one. If that fork moves, re-measure and this list
// changes with it — a capability nobody can point at is a 400 waiting to
// happen to a session that works.
import type { AuthMode, ProviderId } from "./schemas";

// What a provider's harness can actually be asked to do. A profile that needs
// one of these declares it (session-profile.ts's requiredCapabilities); a
// provider that does not publish it fails the session BEFORE the stream opens
// rather than silently dropping the thing that was asked for. AD-11: "No silent
// degradation, ever."
export type ProviderCapability =
  // The harness accepts in-process//configured MCP servers. Claude: query()'s
  // `mcpServers` option. Codex: runCodexTurn takes NO mcpServers argument at
  // all — brownfield.md, "runCodexTurn has no MCP plumbing." This is AD-11's
  // own binding example (OW CAP-1/CAP-12, "the Codex MCP gap").
  | "mcp-servers"
  // The harness runs a PreToolUse hook. Claude: query()'s
  // `hooks: { PreToolUse: [{ hooks: [preToolUseGuardrail] }] }`. Codex:
  // runCodexTurn takes no `hooks` argument; the route's own comment on that
  // branch says "No hooks/permissionMode (those are Claude SDK concepts)."
  // NOTE this capability is about the HARNESS, not about the moat: the moat's
  // wiring lives outside every profile and no profile field can reach it
  // (AD-10). A profile may require that hooks EXIST; it can never register one.
  | "pre-tool-use-hooks"
  // The harness accepts per-turn tool allow/deny lists. Claude: query()'s
  // `allowedTools` / `disallowedTools`. Codex: neither argument exists on
  // runCodexTurn — access there is governed by `sandbox` + `approvalPolicy`.
  | "tool-allow-deny-lists"
  // The harness loads the repo's own settings tiers. Claude: query()'s
  // `settingSources: ["project", "local"]`. Codex: no settingSources argument.
  | "setting-sources"
  // The harness can APPEND to its system prompt. Claude: query()'s
  // `systemPrompt: { type: "preset", preset: "claude_code", append: … }`.
  // Codex: runCodexTurn takes no systemPrompt argument, so an appended
  // paragraph is silently dropped — which is precisely what makes a planner or
  // steerer session on a Codex account a non-session today.
  | "system-prompt-append"
  // Published by BOTH, deliberately. Codex genuinely has interactive approval:
  // the fork's `onCodexApproval` reuses the SAME createPending/resolvePending
  // machinery and the same permission-card SSE contract as the Claude branch's
  // canUseTool. Naming it as a divergence would be a FALSE divergence, and a
  // false divergence is worse than a missing capability — it 400s a session
  // that works today.
  | "interactive-approval";

// Every value the union can take, in one place, so a test can enumerate the
// whole capability space (the ADMISSION_CLASSES idiom, admission.ts). A
// behavioral test alone would pass on a union that merely happens not to
// publish a capability today.
export const PROVIDER_CAPABILITIES: readonly ProviderCapability[] = [
  "mcp-servers",
  "pre-tool-use-hooks",
  "tool-allow-deny-lists",
  "setting-sources",
  "system-prompt-append",
  "interactive-approval",
] as const;

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  // Env var that relocates this provider's whole config/credential dir.
  // Claude: CLAUDE_CONFIG_DIR (creds in the macOS Keychain, keyed per dir).
  // Codex:  CODEX_HOME (creds in auth.json inside the dir — file-based, portable).
  configDirEnv: string;
  // Which env var carries the credential for each non-subscription auth mode.
  tokenEnvByMode: Partial<Record<AuthMode, string>>;
  // THE ENV VARS AN ACCOUNT OWNS: the ones that decide WHERE this provider's
  // requests go and WHO they go as. accountEnv DELETES every one of them before
  // building the subprocess env, so an ambient value inherited from whatever
  // shell launched the Telar server can never decide either question.
  //
  // This is the same rule configDirEnv already has, generalized. The config-dir
  // guard exists because an inherited CLAUDE_CONFIG_DIR silently put `personal`
  // on the work login; an inherited ANTHROPIC_BASE_URL silently puts EVERY
  // account behind a local proxy, and an inherited ANTHROPIC_API_KEY silently
  // moves a subscription account onto metered API billing. Same failure, same
  // fix: the account declares, the environment does not.
  //
  // An account that WANTS one of these sets it explicitly (AccountProfile.env),
  // which accountEnv applies after the deletion — so declaring still works and
  // only inheriting stops.
  //
  // KNOWN GAP, stated rather than papered over: CLAUDE_CODE_USE_BEDROCK and
  // CLAUDE_CODE_USE_VERTEX also reroute a session, and are NOT listed. Telar has
  // no way to express a Bedrock/Vertex account today, so deleting them would
  // remove the only way to use one rather than protect anybody. When an account
  // can name that routing, they belong here.
  ownedEnv: readonly string[];
  // Where a proxy-routed account's endpoint and bearer token go for this
  // provider. Both names MUST also appear in ownedEnv above — otherwise an
  // ambient value could survive on an account that never opted in, which is the
  // whole hole ownedEnv closes. The invariant suite pins that.
  proxyEnv: { readonly baseUrl: string; readonly token: string };
  // Argv (after the binary) that starts an interactive login for this provider.
  loginArgs: string[];
  // Default config-dir location (home-relative), used to detect existing logins.
  defaultConfigDir: string;
  // What this provider's harness can be asked to do (AD-11). REQUIRED, not
  // optional: an absent list would read as "publishes nothing" and 400 every
  // session, while `?? []` would read as "publishes nothing" silently — both
  // are worse than a compile error the moment a third provider is added.
  // Safe to require because PROVIDERS below is this interface's only
  // construction site (grepped: providerOf's five callers are all read-only).
  capabilities: readonly ProviderCapability[];
}

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  claude: {
    id: "claude",
    label: "Claude",
    configDirEnv: "CLAUDE_CONFIG_DIR",
    tokenEnvByMode: {
      "oauth-token": "CLAUDE_CODE_OAUTH_TOKEN", // `claude setup-token`, subscription-billed
      "api-key": "ANTHROPIC_API_KEY", // Console key, API-billed
    },
    // Endpoint + identity. BASE_URL redirects every request (a local proxy such
    // as CLIProxyAPI, a router, a relay); the three credential vars each
    // override the Keychain subscription login with a different identity —
    // CLAUDE_CODE_OAUTH_TOKEN silently, since it is still subscription-billed
    // and so produces no billing signal that anything was substituted.
    ownedEnv: [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ],
    // ANTHROPIC_AUTH_TOKEN, not ANTHROPIC_API_KEY: the proxy's key is a bearer
    // token for a local server, and API_KEY additionally flips Claude Code onto
    // metered-API semantics, which is not what a proxied subscription is.
    proxyEnv: { baseUrl: "ANTHROPIC_BASE_URL", token: "ANTHROPIC_AUTH_TOKEN" },
    loginArgs: ["auth", "login"],
    defaultConfigDir: ".claude",
    // The Agent SDK's query() takes every one of these. Measured against the
    // route's options object: systemPrompt.append, settingSources,
    // allowedTools/disallowedTools, mcpServers, hooks.PreToolUse, plus
    // canUseTool's interactive permission card.
    capabilities: PROVIDER_CAPABILITIES,
  },
  codex: {
    id: "codex",
    label: "Codex",
    configDirEnv: "CODEX_HOME",
    tokenEnvByMode: {
      "api-key": "OPENAI_API_KEY", // Codex has no subscription setup-token analogue
    },
    // Same two questions, Codex's spelling of them.
    ownedEnv: ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
    proxyEnv: { baseUrl: "OPENAI_BASE_URL", token: "OPENAI_API_KEY" },
    loginArgs: ["login"],
    defaultConfigDir: ".codex",
    // Measured from runCodexTurn's argument list, which is exactly
    // {prompt, cwd, env, model, reasoningEffort?, sandbox, resume, signal,
    // approvalPolicy, onApproval} — no mcpServers, no hooks, no
    // allowedTools/disallowedTools, no settingSources, no systemPrompt. What
    // it DOES have is the approval card, via onApproval; that is why
    // "interactive-approval" appears here and the other five do not.
    capabilities: ["interactive-approval"],
  },
};

export function providerOf(id?: ProviderId): ProviderDescriptor {
  return PROVIDERS[id ?? "claude"];
}

// Everything a provider publishes. Routed through providerOf rather than
// re-reading PROVIDERS, so the undefined-means-claude default lives in exactly
// one place and cannot drift between the two accessors.
export function providerCapabilities(id?: ProviderId): readonly ProviderCapability[] {
  return providerOf(id).capabilities;
}

// Does this provider publish this capability? Pure; no I/O, no clock. The
// question a profile's requiredCapabilities asks, one capability at a time.
export function providerPublishes(id: ProviderId | undefined, cap: ProviderCapability): boolean {
  return providerCapabilities(id).includes(cap);
}
