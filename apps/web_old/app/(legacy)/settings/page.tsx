import {
  GeneralSettings,
  type SettingsInitialData,
} from "@/components/settings/accounts-settings";
import { readAccountsEnvelope } from "@/lib/accounts-server";
import { usageSummary } from "@/lib/store";
import { readProviderCache } from "@telar/core/detect";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const accounts = readAccountsEnvelope();
  const initialData: SettingsInitialData = {
    accounts: accounts.accounts,
    defaultAccount: accounts.default,
    usage: usageSummary(),
    providers: readProviderCache(),
  };
  return (
    <div className="h-dvh">
      <GeneralSettings initialData={initialData} />
    </div>
  );
}
