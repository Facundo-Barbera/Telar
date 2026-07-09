import { PageHeader } from "@/components/common/page-header";
import { AccountsSettings } from "@/components/settings/accounts-settings";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="flex h-dvh flex-col">
      <PageHeader title="Settings" description="Accounts, providers, and plan limits." />
      <div className="flex-1 overflow-y-auto">
        <AccountsSettings />
      </div>
    </div>
  );
}
