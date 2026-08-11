import Link from "next/link";
import "./vnext.css";

export default function VNextLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="vnext-shell">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4 sm:px-6">
        <Link href="/vnext" className="font-heading text-base font-semibold tracking-tight">
          telar <span className="text-primary">vNext</span>
        </Link>
        <nav aria-label="vNext navigation" className="flex items-center gap-1 text-sm">
          <Link href="/vnext" className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            Projects
          </Link>
          <Link href="/vnext#sessions" className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            Sessions
          </Link>
          <Link href="/vnext/settings" className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            Settings
          </Link>
        </nav>
      </header>
      {children}
    </div>
  );
}
