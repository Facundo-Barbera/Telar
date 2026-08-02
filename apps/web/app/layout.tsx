import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import {
  AppSidebar,
  type AppSidebarInitialData,
} from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { DockProvider } from "@/components/dock/dock-provider";
import { Dock } from "@/components/dock/dock";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/settings/theme-provider";
import { LoomNotifications } from "@/components/common/loom-notifications";
import { UltraDockSignal } from "@/components/common/ultra-dock-signal";
import { APP_SIDEBAR_STORAGE_KEY } from "@/lib/sidebar-width";
import { readAccountsEnvelope } from "@/lib/accounts-server";
import { listLooms } from "@telar/core/looms";
import { listProjects } from "@telar/core/manifest";
import { listChats } from "@/lib/store";
import { AccountsProvider } from "@/lib/use-accounts";

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
  const accountEnvelope = readAccountsEnvelope();
  const initialSidebarData: AppSidebarInitialData = {
    projects: listProjects().filter((project) => project.manifest !== null),
    chats: listChats(undefined, { archived: "include" }).filter(
      (chat) => chat.role !== "steerer" && chat.role !== "escalation" && Boolean(chat.project),
    ),
    looms: listLooms().filter((loom) => !loom.draft && !loom.parentLoomId),
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
        <AccountsProvider initial={accountEnvelope}>
          <LoomNotifications />
          <DockProvider>
            {/* Story 4.2 / AC7 — INSIDE the provider, unlike LoomNotifications
                above, because it calls useDock(). It renders nothing; it makes a
                session's dock bubble show a live Ultra run FROM ANYWHERE,
                including a session the user never docked. */}
            <UltraDockSignal />
            <SidebarProvider storageKey={APP_SIDEBAR_STORAGE_KEY}>
              <SidebarTrigger
                aria-label="Toggle main sidebar"
                title="Toggle main sidebar"
                className="fixed left-2 top-2 z-[60] border border-border/60 bg-background/90 shadow-sm backdrop-blur-sm"
              />
              <AppSidebar initialData={initialSidebarData} />
              <SidebarInset className="flex h-dvh flex-col">{children}</SidebarInset>
            </SidebarProvider>
            {/* The mini-dock rides above every route — portaled to <body>. */}
            <Dock />
          </DockProvider>
        </AccountsProvider>
      </body>
    </html>
  );
}
