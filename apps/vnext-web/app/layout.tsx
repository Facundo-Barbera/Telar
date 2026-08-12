import "./globals.css";
import { VNextAppShell } from "@/components/vnext-app-shell";

export const metadata = {
  title: "Telar",
  description: "Engine-owned local project sessions",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <VNextAppShell>{children}</VNextAppShell>
      </body>
    </html>
  );
}
