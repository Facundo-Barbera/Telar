"use client";

// Concern 4 + 5 — Project settings as a sectioned side-nav over the project
// FACTS (gates/commands, servers, MCP, guardrails/env) + danger zone. Today
// this is ONE long scroll (General → Gates → Guardrails → URLs → MCP →
// Permissions → Danger all stacked in a max-w-3xl column); here each fact is a
// nav section so nothing is more than a click away.
import { useState } from "react";
import {
  SlidersHorizontalIcon,
  CheckCircle2Icon,
  ServerIcon,
  PlugIcon,
  ShieldIcon,
  TriangleAlertIcon,
  PlusIcon,
  XIcon,
  Trash2Icon,
  EyeIcon,
  EyeOffIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsShell,
  SettingsGroup,
  Row,
  type SettingsSection,
} from "./shell";

const SECTIONS: SettingsSection[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon, group: "Project" },
  { id: "gates", label: "Gates & commands", icon: CheckCircle2Icon, count: 3, group: "Project" },
  { id: "servers", label: "Servers", icon: ServerIcon, group: "Project" },
  { id: "mcp", label: "MCP", icon: PlugIcon, count: 2, group: "Integrations" },
  { id: "guardrails", label: "Guardrails & env", icon: ShieldIcon, group: "Integrations" },
  { id: "danger", label: "Danger zone", icon: TriangleAlertIcon, group: "Integrations" },
];

const MCP_SERVERS = [
  { name: "linear", status: "healthy" as const, tools: 11 },
  { name: "sentry", status: "degraded" as const, tools: 6 },
];

const ENV_VARS = [
  { key: "DATABASE_URL", value: "postgres://prod.internal:5432/telar" },
  { key: "STRIPE_SECRET_KEY", value: "sk_live_51H8xQz2eZvKYlo2C..." },
];

function HealthDot({ status }: { status: "healthy" | "degraded" | "down" }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full",
        status === "healthy" && "bg-emerald-500",
        status === "degraded" && "bg-amber-500",
        status === "down" && "bg-destructive",
      )}
    />
  );
}

export function ProjectSettingsDemo() {
  const [active, setActive] = useState("general");
  const [dirty, setDirty] = useState(false);
  const touch = () => setDirty(true);

  const [account, setAccount] = useState("personal");
  const [adapter, setAdapter] = useState("plain");
  const [baseBranch, setBaseBranch] = useState("main");

  const [gates, setGates] = useState([
    { name: "test", run: "bun test packages/core" },
    { name: "typecheck", run: "bunx tsc -p tsconfig.json --noEmit" },
    { name: "lint", run: "bunx eslint ." },
  ]);
  const [urls, setUrls] = useState({
    dev: "http://localhost:3131",
    preview: "https://preview.telar.dev",
    prod: "https://telar.dev",
  });
  const [paths, setPaths] = useState(["src/db/migrations/**", ".env*"]);
  const [tools, setTools] = useState(["Bash(rm:*)", "Bash(git push:*)"]);
  const [reveal, setReveal] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const patchGate = (i: number, k: "name" | "run", v: string) => {
    setGates((g) => g.map((row, idx) => (idx === i ? { ...row, [k]: v } : row)));
    touch();
  };

  return (
    <SettingsShell
      title="telar-web"
      subtitle={<span className="font-mono text-[11px]">~/Projects/telar-web</span>}
      sections={SECTIONS}
      active={active}
      onSelect={setActive}
      dirty={dirty}
    >
      {active === "general" && (
        <SettingsGroup description="Identity and where looms cut their work from.">
          <Row
            label="Account"
            hint="Default login for new sessions and looms in this project."
            control={
              <Select
                value={account}
                onValueChange={(v) => {
                  if (v) {
                    setAccount(String(v));
                    touch();
                  }
                }}
              >
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">personal</SelectItem>
                  <SelectItem value="work">work</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <Row
            label="Adapter"
            hint="Workflow flavor for looms."
            control={
              <Select
                value={adapter}
                onValueChange={(v) => {
                  if (v) {
                    setAdapter(String(v));
                    touch();
                  }
                }}
              >
                <SelectTrigger className="h-8 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="plain">plain</SelectItem>
                  <SelectItem value="bmad">bmad</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <Row
            label="Base branch"
            hint="Branch looms cut from and target."
            control={
              <Input
                value={baseBranch}
                onChange={(e) => {
                  setBaseBranch(e.target.value);
                  touch();
                }}
                className="h-8 w-40 font-mono text-xs"
                spellCheck={false}
              />
            }
          />
        </SettingsGroup>
      )}

      {active === "gates" && (
        <SettingsGroup
          title="Gates"
          description="Commands whose exit code decides whether a loom passes verification."
        >
          <div className="space-y-2 p-4">
            {gates.map((g, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={g.name}
                  onChange={(e) => patchGate(i, "name", e.target.value)}
                  className="h-8 w-28 shrink-0 text-xs"
                  spellCheck={false}
                  aria-label={`Gate ${i + 1} name`}
                />
                <Input
                  value={g.run}
                  onChange={(e) => patchGate(i, "run", e.target.value)}
                  className="h-8 flex-1 font-mono text-xs"
                  spellCheck={false}
                  aria-label={`Gate ${i + 1} command`}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    setGates((gs) => gs.filter((_, idx) => idx !== i));
                    touch();
                  }}
                  aria-label={`Remove gate ${i + 1}`}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setGates((gs) => [...gs, { name: "", run: "" }]);
                touch();
              }}
            >
              <PlusIcon /> Add gate
            </Button>
          </div>
        </SettingsGroup>
      )}

      {active === "servers" && (
        <SettingsGroup
          title="Deployment targets"
          description="URLs the Verifier can drive after a loom lands."
        >
          {(["dev", "preview", "prod"] as const).map((k) => (
            <Row
              key={k}
              label={k[0].toUpperCase() + k.slice(1)}
              control={
                <Input
                  value={urls[k]}
                  onChange={(e) => {
                    setUrls((u) => ({ ...u, [k]: e.target.value }));
                    touch();
                  }}
                  className="h-8 w-64 font-mono text-xs"
                  spellCheck={false}
                />
              }
            />
          ))}
        </SettingsGroup>
      )}

      {active === "mcp" && (
        <SettingsGroup
          title="MCP servers"
          description="Model Context Protocol integrations available to this project's agents."
        >
          {MCP_SERVERS.map((s) => (
            <Row
              key={s.name}
              label={
                <span className="flex items-center gap-2">
                  <HealthDot status={s.status} />
                  <span className="font-mono">{s.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {s.tools} tools
                  </Badge>
                </span>
              }
              hint={s.status === "degraded" ? "Auth token expiring soon" : "Connected"}
              control={
                <Button variant="ghost" size="sm">
                  Manage
                </Button>
              }
            />
          ))}
          <div className="p-4">
            <Button variant="outline" size="sm">
              <PlusIcon /> Add server
            </Button>
          </div>
        </SettingsGroup>
      )}

      {active === "guardrails" && (
        <>
          <SettingsGroup title="Protected paths" description="Files looms are fenced off from.">
            <div className="space-y-2 p-4">
              {paths.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={p}
                    onChange={(e) => {
                      setPaths((ps) => ps.map((v, idx) => (idx === i ? e.target.value : v)));
                      touch();
                    }}
                    className="h-8 flex-1 font-mono text-xs"
                    spellCheck={false}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      setPaths((ps) => ps.filter((_, idx) => idx !== i));
                      touch();
                    }}
                    aria-label={`Remove path ${i + 1}`}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPaths((ps) => [...ps, ""]);
                  touch();
                }}
              >
                <PlusIcon /> Add path
              </Button>
            </div>
          </SettingsGroup>

          <SettingsGroup title="Disallowed tools">
            <div className="flex flex-wrap gap-2 p-4">
              {tools.map((t, i) => (
                <Badge key={i} variant="secondary" className="gap-1 font-mono text-[11px]">
                  {t}
                  <button
                    type="button"
                    onClick={() => {
                      setTools((ts) => ts.filter((_, idx) => idx !== i));
                      touch();
                    }}
                    aria-label={`Remove ${t}`}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <XIcon className="size-3" />
                  </button>
                </Badge>
              ))}
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  setTools((ts) => [...ts, "Tool(pattern:*)"]);
                  touch();
                }}
              >
                <PlusIcon /> Add
              </Button>
            </div>
          </SettingsGroup>

          <SettingsGroup
            title="Environment"
            description="Injected into loom runs. Values are masked until revealed."
          >
            {ENV_VARS.map((v) => (
              <Row
                key={v.key}
                label={<span className="font-mono text-[13px]">{v.key}</span>}
                control={
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs text-muted-foreground">
                      {reveal === v.key ? v.value : "•".repeat(16)}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setReveal((r) => (r === v.key ? null : v.key))}
                      aria-label="Reveal value"
                    >
                      {reveal === v.key ? <EyeOffIcon /> : <EyeIcon />}
                    </Button>
                  </div>
                }
              />
            ))}
          </SettingsGroup>
        </>
      )}

      {active === "danger" && (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-destructive/25">
          <div className="border-b border-destructive/15 px-4 py-3">
            <h4 className="text-sm font-medium text-destructive">Danger zone</h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Unregistering removes this project from the loom. The repo and its telar.yaml stay on
              disk.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 bg-destructive/5 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">
                Unregister <code className="font-mono text-[13px]">telar-web</code>
              </div>
              <div className="text-xs text-muted-foreground">
                Drops the registry entry. Re-register any time.
              </div>
            </div>
            {confirmDelete ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm">
                  <Trash2Icon /> Confirm
                </Button>
              </div>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                className="shrink-0"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2Icon /> Unregister
              </Button>
            )}
          </div>
        </div>
      )}
    </SettingsShell>
  );
}
