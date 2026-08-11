import Link from "next/link";

export const dynamic = "force-dynamic";

export default function VNextSettingsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6 md:p-10">
      <header>
        <p className="text-sm font-medium text-primary">Telar vNext</p>
        <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">Local runtime settings</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          vNext uses the local Claude Code setup already available on this machine. This cockpit does not manage accounts, credentials, or provider configuration.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="vnext-runtime-title">
        <h2 id="vnext-runtime-title" className="font-medium">Dedicated engine state</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Start the cockpit with <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">bun run dev:vnext</code>. It uses a dedicated absolute <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">TELAR_HOME</code> and never reads or writes the normal Telar state root.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-card p-5" aria-labelledby="vnext-claude-title">
        <h2 id="vnext-claude-title" className="font-medium">Claude Code availability</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Sign in with Claude Code on this machine before starting a worker. Engine availability and worker status remain visible from Projects; configuration changes stay outside this vNext cockpit for now.
        </p>
      </section>

      <div>
        <Link href="/vnext" className="text-sm text-primary hover:underline">← Back to projects</Link>
      </div>
    </main>
  );
}
