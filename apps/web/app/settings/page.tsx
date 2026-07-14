import { GeneralSettings } from "@/components/settings/accounts-settings";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="h-dvh">
      <GeneralSettings />
    </div>
  );
}
