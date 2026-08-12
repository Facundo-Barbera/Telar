import "../globals.css";
import {
  AppSidebar,
  type AppSidebarInitialData,
} from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { DockProvider } from "@/components/dock/dock-provider";
import { DockMount } from "@/components/dock/dock-mount";
import { LoomNotifications } from "@/components/common/loom-notifications";
import { UltraDockSignal } from "@/components/common/ultra-dock-signal";
import { DesktopBrowserHost } from "@/components/desktop-browser-host";
import { APP_SIDEBAR_STORAGE_KEY } from "@/lib/sidebar-width";
import { AccountsProvider } from "@/lib/use-accounts";
import {
  listAppShellChats,
  listAppShellLooms,
  listAppShellProjects,
  readAppShellAccounts,
} from "@/lib/app-shell-data";

export const dynamic = "force-dynamic";

export default function LegacyLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The persistent product shell remains exactly on legacy routes. Keeping
  // these reads below the route-group boundary prevents a vNext request from
  // participating in legacy projects, chats, Looms, or account state.
  const accountEnvelope = readAppShellAccounts();
  const initialSidebarData: AppSidebarInitialData = {
    // eslint-disable-next-line react-hooks/purity -- server seed shared by SSR and first client render.
    renderedAt: Date.now(),
    projects: listAppShellProjects(),
    chats: listAppShellChats(),
    looms: listAppShellLooms(),
  };

  return (
    <>
      <DesktopBrowserHost />
      <AccountsProvider initial={accountEnvelope}>
        <LoomNotifications />
        <DockProvider>
          {/* This signal must stay inside DockProvider because it uses useDock(). */}
          <UltraDockSignal />
          <SidebarProvider storageKey={APP_SIDEBAR_STORAGE_KEY}>
            <AppSidebar initialData={initialSidebarData} />
            <SidebarInset className="flex h-dvh flex-col">{children}</SidebarInset>
          </SidebarProvider>
          <DockMount />
        </DockProvider>
      </AccountsProvider>
    </>
  );
}
