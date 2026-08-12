import {
  accountHealth,
  getDefaultAccountName,
  isAccountAvailableForSessions,
  isMainAccount,
  listAccounts,
} from "@telar/core/accounts";
import { readAccountIdentity } from "@telar/core/account-identity";
import { readClaudeRuntimeEnv } from "@telar/core/claude-runtime";
import { signInCommand } from "@telar/core/detect";

// One server-side source for the account envelope used by the API, Settings,
// and the persistent sidebar. Keeping this as local-file work means those
// surfaces can render immediately instead of mounting and then competing for
// /api/accounts during a route compile.
export function readAccountsEnvelope() {
  const nativeClaudeRuntime = readClaudeRuntimeEnv();
  const accounts = listAccounts().map((account) => {
    const provider = account.provider ?? "claude";
    const configuredBaseUrl = account.env?.some(
      (value) => value.name === "ANTHROPIC_BASE_URL" && Boolean(value.value),
    );
    const inheritsNativeClaudeRuntime =
      provider === "claude" &&
      !account.configDir &&
      (account.authMode ?? "subscription") === "subscription";

    return {
      ...account,
      // Sensitive values never cross the server boundary. An empty value plus
      // valueRedacted tells the settings form to preserve the stored secret.
      env: account.env?.map((value) =>
        value.sensitive
          ? { ...value, value: "", valueRedacted: true }
          : { ...value, valueRedacted: false },
      ),
      health: accountHealth(account),
      isMain: isMainAccount(account),
      identity: readAccountIdentity(account),
      signInHint: signInCommand(account),
      runtimeRouted: Boolean(
        provider === "claude" &&
          (configuredBaseUrl ||
            (inheritsNativeClaudeRuntime && nativeClaudeRuntime.ANTHROPIC_BASE_URL)),
      ),
      available: isAccountAvailableForSessions(account),
    };
  });

  return { accounts, default: getDefaultAccountName() };
}

export type AccountsServerEnvelope = ReturnType<typeof readAccountsEnvelope>;
