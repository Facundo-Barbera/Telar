import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import {
  AppSidebar,
  type AppSidebarInitialData,
} from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { DockProvider } from "@/components/dock/dock-provider";
import { DockMount } from "@/components/dock/dock-mount";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/settings/theme-provider";
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

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Telar",
  description: "Weave your agents — orchestration on the Claude Agent SDK",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // These are millisecond-scale local file reads. Seeding the persistent shell
  // here removes the old mount-time fan-out to five API routes; subsequent
  // mutations are still refreshed by the sidebar's scoped client events.
  const accountEnvelope = readAppShellAccounts();
  const initialSidebarData: AppSidebarInitialData = {
    renderedAt: Date.now(),
    projects: listAppShellProjects(),
    chats: listAppShellChats(),
    looms: listAppShellLooms(),
  };

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Sets the theme class on <html> before first paint so the appearance
            preference never flashes. Kept in sync with ThemeProvider / ui-prefs. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider />
        <DesktopBrowserHost />
        <AccountsProvider initial={accountEnvelope}>
          <LoomNotifications />
          <DockProvider>
            {/* Story 4.2 / AC7 — INSIDE the provider, unlike LoomNotifications
                above, because it calls useDock(). It renders nothing; it makes a
                session's dock bubble show a live Ultra run FROM ANYWHERE,
                including a session the user never docked. */}
            <UltraDockSignal />
            <SidebarProvider storageKey={APP_SIDEBAR_STORAGE_KEY}>
              <AppSidebar initialData={initialSidebarData} />
              <SidebarInset className="flex h-dvh flex-col">{children}</SidebarInset>
            </SidebarProvider>
            {/* The mini-dock rides above every route — portaled to <body>.
                Mounted through DockMount so its module graph (which reaches the
                transcript renderer) is fetched only once something is docked,
                rather than compiled into every route. */}
            <DockMount />
          </DockProvider>
        </AccountsProvider>
      </body>
    </html>
  );
}
