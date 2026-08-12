import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ThemeControl } from "@/components/theme-control";

export const dynamic = "force-dynamic";

/** A read-only fact. Two of these live here because the cockpit deliberately
 *  does NOT manage credentials or provider configuration — saying so is more
 *  useful than offering a control that would lie. */
function Fact({ label, help, value }: { label: string; help: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <div className="shrink-0">{value}</div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 overflow-y-auto p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          This cockpit uses the local Claude Code setup already on this machine. It does not manage accounts, credentials or
          provider configuration.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Appearance</CardTitle>
          <CardDescription>Applied before first paint, so switching never flashes the other theme.</CardDescription>
        </CardHeader>
        <CardContent>
          <ThemeControl />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Dedicated engine state</CardTitle>
          <CardDescription>vNext runs against its own state root.</CardDescription>
        </CardHeader>
        <CardContent className="py-0">
          <Fact
            label="Launch command"
            help="Starts the local engine, its worker, and this app."
            value={<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">bun run dev:vnext</code>}
          />
          <Separator />
          <Fact
            label="State isolation"
            help="The vNext engine never reads or writes the normal Telar state root."
            value={<Badge variant="secondary">Protected</Badge>}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Provider availability</CardTitle>
          <CardDescription>Worker availability is shown on Projects; changes stay outside this cockpit.</CardDescription>
        </CardHeader>
        <CardContent className="py-0">
          <Fact
            label="Provider configuration"
            help="Sign in with Claude Code or Codex on this machine before starting a worker."
            value={<Badge variant="outline">External</Badge>}
          />
        </CardContent>
      </Card>
    </main>
  );
}
