import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { DockProvider } from "@/components/dock/dock-provider";
import { Dock } from "@/components/dock/dock";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/settings/theme-provider";
import { LoomNotifications } from "@/components/common/loom-notifications";
import { UltraDockSignal } from "@/components/common/ultra-dock-signal";

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
        <LoomNotifications />
        <DockProvider>
          {/* Story 4.2 / AC7 — INSIDE the provider, unlike LoomNotifications
              above, because it calls useDock(). It renders nothing; it makes a
              session's dock bubble show a live Ultra run FROM ANYWHERE,
              including a session the user never docked. */}
          <UltraDockSignal />
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset className="flex h-dvh flex-col">{children}</SidebarInset>
          </SidebarProvider>
          {/* The mini-dock rides above every route — portaled to <body>. */}
          <Dock />
        </DockProvider>
      </body>
    </html>
  );
}
