"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  InboxIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { GalleryComponentEntry } from "@/lib/gallery-fixtures";
import { GALLERY_FIXTURES, SHOWCASE, setActiveScene } from "@/lib/gallery-fixtures";

// Real production components — rendered in isolation with fixture props. Nothing
// here is a fork; every module is the exact one production imports.
import { LoomCard } from "@/components/looms/loom-card";
import { StateBadge } from "@/components/common/state-badge";
import { ProjectCard, ProjectErrorCard } from "@/components/projects/project-card";
import { ThreadTree } from "@/components/looms/thread-tree";
import { AttemptCard } from "@/components/looms/attempt-card";
import { DecisionLog } from "@/components/looms/decision-log";
import { VerifierReportCard } from "@/components/looms/verifier-report-card";
import { CharterPanel } from "@/components/looms/charter-panel";
import { AcceptancePanel, DoneConfirmation } from "@/components/looms/acceptance-panel";
import {
  BlockedEscalation,
  ParkExplanation,
  BlockedAnswerForm,
} from "@/components/looms/blocked-escalation";
import { DiscussEscalation } from "@/components/looms/discuss-escalation";
import { SpecBundle } from "@/components/looms/spec-bundle";
import { AgentTabsStrip, type AgentTab } from "@/components/session/agent-tabs";
import { ToolStepRow, type ToolPart } from "@/components/session/tool-step";
import { StatusBadge } from "@/components/looms/status";
import { HealthDot } from "@/components/settings/mcp-health";
import { UsagePill } from "@/components/session/usage-pill";
import { ProviderIcon } from "@/components/session/provider-icon";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { RegisterProjectDialog } from "@/components/projects/register-dialog";

// The 5 GALLERY-SEAM exports (module-private otherwise, named by the product owner
// for isolated design review). See the // GALLERY-SEAM comments in god-view.tsx.
import {
  GateRunRow,
  CriticFindingRow,
  CriticVerdictRow,
  PlanGraph,
  OperatorCard,
} from "@/components/looms/god-view";
// The permission-card seam — permission Parts are live-stream-only, so this is
// the one firmly-required prop-level seam. See the // GALLERY-SEAM in session-view.tsx.
import { PermissionCard } from "@/components/session/session-view";

// ui/ primitives for the compact primitives sheet.
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// Layout primitives — a labeled variant grid. Every showcase entry renders its
// variants through <Variant label> cells so the reviewer sees the variant name.
// ---------------------------------------------------------------------------
function Variant({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </p>
      <div className="rounded-lg border border-dashed border-border/70 bg-muted/10 p-3">
        {children}
      </div>
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

// A tiny controlled wrapper for ToolStepRow (needs open/onToggle state).
function ToolStepDemo({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(true);
  return (
    <ToolStepRow
      part={part}
      running={part.output === undefined && !part.isError}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    />
  );
}

// A gallery loom id that resolves to benign for any self-fetch (POST accept /
// answer_blocked / spec) — reuse the first showcase loom's project-scoped id.
const DEMO_LOOM_ID = SHOWCASE.loomStates[0]?.id ?? "gallery__demo";

// Inline UI-only prop shapes not covered by SHOWCASE (pure display types, no zod
// schema, so lane G builds them here rather than in the fixture data bundle).
const AGENT_TABS: AgentTab[] = [
  { id: "reviewer", label: "reviewer", status: "running" },
  { id: "test-runner", label: "test-runner", status: "done" },
  { id: "scout", label: "scout", status: "error" },
];

const TOOL_PARTS: Record<string, ToolPart> = {
  read: { type: "tool", name: "Read", input: { file_path: "src/index.ts" }, output: "…file contents…" },
  edit: {
    type: "tool",
    name: "Edit",
    input: { file_path: "src/app.ts", old_string: "foo", new_string: "bar" },
    output: "1 edit applied",
  },
  bash: { type: "tool", name: "Bash", input: { command: "bun test" }, output: "42 pass, 0 fail" },
  task: {
    type: "tool",
    name: "Task",
    input: { description: "review the diff" },
    agent: { type: "general", description: "review the diff", name: "reviewer" },
    taskStatus: "completed",
  },
  todo: {
    type: "tool",
    name: "TodoWrite",
    input: {
      todos: [
        { content: "Read the spec", status: "completed" },
        { content: "Implement the resolver", status: "in_progress" },
        { content: "Write tests", status: "pending" },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
export function ComponentStage({ entry }: { entry: GalleryComponentEntry }) {
  // Some components self-fetch collection endpoints (register-dialog → useAccounts
  // + /api/browse; register form → POST /api/projects). Publish the entry's scene
  // (or null for the no-fetch components) synchronously at render — never cleared
  // on unmount; the next stage's render wins. See AppViewStage for the rationale.
  setActiveScene(entry.scene ?? null);
  useEffect(() => {
    setActiveScene(entry.scene ?? null);
  }, [entry.scene]);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6">
      <Body component={entry.component} />
    </div>
  );
}

function Body({ component }: { component: GalleryComponentEntry["component"] }) {
  switch (component) {
    case "loom-card": {
      const failed = SHOWCASE.loomStates.find((l) => l.state === "failed" || l.state === "blocked");
      const running = SHOWCASE.loomStates.find((l) => l.state === "running") ?? SHOWCASE.loomStates[0];
      return (
        <Grid>
          <Variant label="row — list, across states" wide>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {SHOWCASE.loomStates.map((l) => (
                <LoomCard key={l.id} loom={l} layout="row" showError />
              ))}
            </div>
          </Variant>
          <Variant label="tile — live clock">
            {running && <LoomCard loom={running} layout="tile" now={Date.now()} />}
          </Variant>
          <Variant label="needs-attention row — error snippet">
            {failed && <LoomCard loom={failed} layout="row" showError />}
          </Variant>
        </Grid>
      );
    }

    case "state-badge":
      return (
        <div className="flex flex-wrap gap-2">
          {SHOWCASE.loomStates.map((l) => (
            <div key={l.id} className="flex flex-col items-center gap-1">
              <StateBadge state={l.state} />
              <span className="font-mono text-[10px] text-muted-foreground/60">{l.state}</span>
            </div>
          ))}
        </div>
      );

    case "project-card":
      return (
        <Grid>
          <Variant label="healthy — ProjectCard">
            {SHOWCASE.projectEntry.manifest && (
              <ProjectCard
                entry={SHOWCASE.projectEntry.entry}
                manifest={SHOWCASE.projectEntry.manifest}
                onChanged={() => {}}
              />
            )}
          </Variant>
          <Variant label="manifest error — ProjectErrorCard">
            <ProjectErrorCard
              entry={SHOWCASE.manifestErrorEntry.entry}
              error={SHOWCASE.manifestErrorEntry.error ?? "invalid telar.yaml"}
              onChanged={() => {}}
            />
          </Variant>
        </Grid>
      );

    case "thread-tree":
      return (
        <Variant label="decomposition + children in mixed states (+ orphan row)" wide>
          <ThreadTree
            decomposition={SHOWCASE.threadTree.decomposition}
            children={SHOWCASE.threadTree.children}
            weaveId={DEMO_LOOM_ID}
          />
        </Variant>
      );

    case "attempt-card":
      return (
        <Grid>
          <Variant label="running">
            <AttemptCard attempt={SHOWCASE.attempts.running} loomId={DEMO_LOOM_ID} />
          </Variant>
          <Variant label="passed verdict">
            <AttemptCard attempt={SHOWCASE.attempts.passed} loomId={DEMO_LOOM_ID} />
          </Variant>
          <Variant label="failed with blocker" wide>
            <AttemptCard attempt={SHOWCASE.attempts.failed} loomId={DEMO_LOOM_ID} />
          </Variant>
        </Grid>
      );

    case "decision-log":
      return (
        <Variant label="plan / ok / fail / block / observe timeline" wide>
          <DecisionLog events={SHOWCASE.decisionFeed} />
        </Variant>
      );

    case "verifier-report": {
      // Evidence images self-fetch /api/looms/<id>/evidence/<path> — served only
      // for a fixture bundle carrying .evidence. Borrow one so the image resolves.
      const evId = GALLERY_FIXTURES.find((f) => f.evidence && Object.keys(f.evidence).length)?.id ?? DEMO_LOOM_ID;
      return (
        <Grid>
          <Variant label="pass — with evidence image">
            <VerifierReportCard loomId={evId} report={SHOWCASE.verifierReport.pass} />
          </Variant>
          <Variant label="fail — design findings">
            <VerifierReportCard loomId={evId} report={SHOWCASE.verifierReport.fail} />
          </Variant>
        </Grid>
      );
    }

    case "gate-row":
      return (
        <div className="space-y-2">
          <Variant label="green — pass" wide>
            <GateRunRow gate={SHOWCASE.gate.pass} />
          </Variant>
          <Variant label="red — fail" wide>
            <GateRunRow gate={SHOWCASE.gate.fail} />
          </Variant>
          <Variant label="running" wide>
            <GateRunRow gate={SHOWCASE.gate.running} />
          </Variant>
          <Variant label="timed out" wide>
            <GateRunRow gate={SHOWCASE.gate.timedOut} />
          </Variant>
        </div>
      );

    case "critic-cards":
      return (
        <div className="space-y-3">
          <Variant label="verdict — clean pass" wide>
            <CriticVerdictRow loomId={DEMO_LOOM_ID} critic={SHOWCASE.critics.pass} />
          </Variant>
          <Variant label="verdict — blocking findings" wide>
            <CriticVerdictRow loomId={DEMO_LOOM_ID} critic={SHOWCASE.critics.blocking} />
          </Variant>
          <Variant label="verdict — advisory" wide>
            <CriticVerdictRow loomId={DEMO_LOOM_ID} critic={SHOWCASE.critics.advisory} />
          </Variant>
          <Variant label="single finding row" wide>
            <CriticFindingRow loomId={DEMO_LOOM_ID} finding={SHOWCASE.critics.finding} />
          </Variant>
        </div>
      );

    case "plan-graph":
      return (
        <Variant label="nodes across pending / active / done / failed" wide>
          <PlanGraph plan={SHOWCASE.plan} />
        </Variant>
      );

    case "operator-card":
      return (
        <Grid>
          {(
            [
              ["running", SHOWCASE.operators.running],
              ["done", SHOWCASE.operators.done],
              ["failed", SHOWCASE.operators.failed],
              ["blocked", SHOWCASE.operators.blocked],
              ["fan-out", SHOWCASE.operators.fanOut],
            ] as const
          ).map(([label, op]) => (
            <Variant key={label} label={label}>
              {/* dep=undefined is a valid variant (product-owner note). */}
              <OperatorCard op={op} dep={undefined} onOpen={() => {}} />
            </Variant>
          ))}
        </Grid>
      );

    case "charter-panel":
      return (
        <Grid>
          <Variant label="full charter — decomposition / budget / scope" wide>
            <CharterPanel charter={SHOWCASE.charter} />
          </Variant>
          <Variant label="absent — no charter" wide>
            <CharterPanel charter={undefined} />
          </Variant>
        </Grid>
      );

    case "acceptance-panel": {
      const loom = SHOWCASE.loomStates.find((l) => l.state === "ready") ?? SHOWCASE.loomStates[0];
      return (
        <div className="space-y-3">
          <Variant label="directly acceptable (allowAccept=true)" wide>
            <AcceptancePanel loom={loom} allowAccept />
          </Variant>
          <Variant label="woven-gated (allowAccept=false)" wide>
            <AcceptancePanel loom={loom} allowAccept={false} />
          </Variant>
          <Variant label="DoneConfirmation" wide>
            <DoneConfirmation loom={loom} by="alex" />
          </Variant>
        </div>
      );
    }

    case "blocked-escalation": {
      const loom = SHOWCASE.loomStates.find((l) => l.state === "blocked") ?? SHOWCASE.loomStates[0];
      return (
        <div className="space-y-3">
          <Variant label="BlockedEscalation" wide>
            <BlockedEscalation loom={loom} />
          </Variant>
          <Variant label="ParkExplanation" wide>
            <ParkExplanation loom={loom} />
          </Variant>
          <Variant label="BlockedAnswerForm" wide>
            <BlockedAnswerForm loom={loom} />
          </Variant>
        </div>
      );
    }

    case "discuss-escalation": {
      const loom = SHOWCASE.loomStates.find((l) => l.state === "blocked") ?? SHOWCASE.loomStates[0];
      return (
        <Variant label="pre-discuss surface (loom self-fetch)" wide>
          <DiscussEscalation loom={loom} />
        </Variant>
      );
    }

    case "permission-card":
      return (
        <div className="space-y-3">
          <Variant label="pending — narrow / broad rule options" wide>
            <PermissionCard part={SHOWCASE.permission.pending} onRespond={() => {}} />
          </Variant>
          <Variant label="allowed" wide>
            <PermissionCard part={SHOWCASE.permission.allowed} onRespond={() => {}} />
          </Variant>
          <Variant label="denied" wide>
            <PermissionCard part={SHOWCASE.permission.denied} onRespond={() => {}} />
          </Variant>
        </div>
      );

    case "spec-bundle": {
      const specFixtures = GALLERY_FIXTURES.filter((f) => f.spec).slice(0, 3);
      return (
        <div className="space-y-3">
          {specFixtures.length === 0 && (
            <p className="text-sm text-muted-foreground">No fixture carries a spec bundle.</p>
          )}
          {specFixtures.map((f) => (
            <Variant key={f.id} label={f.label} wide>
              {/* SpecBundle self-fetches /api/looms/<id>/spec — served by the
                  existing loom-keyed interceptor for a fixture with .spec. */}
              <SpecBundle loomId={f.id} />
            </Variant>
          ))}
        </div>
      );
    }

    case "agent-tabs":
      return (
        <div className="space-y-3">
          <Variant label="main + subagents (running / done / error)" wide>
            <AgentTabsStrip tabs={AGENT_TABS} activeId="main" onSelect={() => {}} />
          </Variant>
          <Variant label="main needs attention" wide>
            <AgentTabsStrip
              tabs={AGENT_TABS}
              activeId="reviewer"
              onSelect={() => {}}
              mainNeedsAttention
            />
          </Variant>
        </div>
      );

    case "tool-step":
      return (
        <div className="space-y-2">
          {(["read", "edit", "bash", "task", "todo"] as const).map((k) => (
            <Variant key={k} label={k} wide>
              <ToolStepDemo part={TOOL_PARTS[k]} />
            </Variant>
          ))}
        </div>
      );

    case "status-sheet":
      return (
        <div className="space-y-4">
          <Variant label="ProviderIcon" wide>
            <div className="flex items-center gap-4">
              <ProviderIcon provider="claude" size={20} />
              <ProviderIcon provider="codex" size={20} />
            </div>
          </Variant>
          <Variant label="UsagePill" wide>
            <UsagePill snap={SHOWCASE.planSnapshot} />
          </Variant>
          <Variant label="StatusBadge" wide>
            <div className="flex flex-wrap gap-2">
              <StatusBadge kind="run" state="running" active label="building" />
              <StatusBadge kind="verify" state="verifying" active label="verifying" />
              <StatusBadge kind="done" state="done" active={false} label="done" />
              <StatusBadge kind="block" state="blocked" active={false} label="blocked" />
              <StatusBadge kind="wait" state="queued" active={false} label="queued" />
            </div>
          </Variant>
          <Variant label="HealthDot (mcp)" wide>
            <div className="flex flex-wrap items-center gap-4">
              <HealthDot transport="http" status={{ requiresOAuth: true, connected: true, health: "connected" }} />
              <HealthDot transport="http" status={{ requiresOAuth: true, connected: false, health: "needs-auth" }} />
              <HealthDot transport="http" status={{ requiresOAuth: false, connected: false, health: "error" }} />
              <HealthDot transport="stdio" />
            </div>
          </Variant>
        </div>
      );

    case "page-header":
      return (
        <div className="space-y-4">
          <Variant label="title only" wide>
            <PageHeader title="Projects" />
          </Variant>
          <Variant label="with description" wide>
            <PageHeader title="Settings" description="Accounts, providers, and plan limits." />
          </Variant>
          <Variant label="with actions" wide>
            <PageHeader
              title="Looms"
              actions={
                <Button size="sm">
                  <PlusIcon /> New loom
                </Button>
              }
            />
          </Variant>
          <Variant label="with leading back-link" wide>
            <PageHeader
              leading={
                <Button variant="ghost" size="icon-sm">
                  <ArrowLeftIcon />
                </Button>
              }
              title="finch"
              description="the finch semver library"
            />
          </Variant>
        </div>
      );

    case "empty-state":
      return (
        <div className="space-y-4">
          <Variant label="default" wide>
            <EmptyState icon={InboxIcon} title="Nothing here yet" description="No sessions in this project." />
          </Variant>
          <Variant label="error (destructive icon)" wide>
            <EmptyState
              icon={TriangleAlertIcon}
              iconClassName="text-destructive/60"
              title="Couldn't reach the registry"
              description="The registry is unreachable. Retry in a moment."
            />
          </Variant>
          <Variant label="with action button" wide>
            <EmptyState
              icon={InboxIcon}
              title="No projects registered"
              description="Register a repository to get started."
              action={
                <Button size="sm">
                  <PlusIcon /> Register a project
                </Button>
              }
            />
          </Variant>
        </div>
      );

    case "register-dialog":
      return (
        <Variant label="RegisterProjectDialog — browse + register form (scene-served)" wide>
          {/* useAccounts + POST /api/browse + POST /api/projects are answered by
              the entry's GalleryScene (accounts + browse + benignMutations). */}
          <RegisterProjectDialog onRegistered={() => {}} />
        </Variant>
      );

    case "primitives":
      return <PrimitivesSheet />;

    default:
      return null;
  }
}

// The compact ui/ primitives sheet — every base primitive with its variants.
function PrimitivesSheet() {
  return (
    <div className="space-y-6">
      <Variant label="Button — variants" wide>
        <div className="flex flex-wrap gap-2">
          {(["default", "outline", "secondary", "ghost", "destructive", "link"] as const).map((v) => (
            <Button key={v} variant={v}>
              {v}
            </Button>
          ))}
        </div>
      </Variant>
      <Variant label="Button — sizes" wide>
        <div className="flex flex-wrap items-center gap-2">
          {(["xs", "sm", "default", "lg"] as const).map((s) => (
            <Button key={s} size={s}>
              {s}
            </Button>
          ))}
        </div>
      </Variant>
      <Variant label="Badge — variants" wide>
        <div className="flex flex-wrap gap-2">
          {(["default", "secondary", "destructive", "outline", "ghost"] as const).map((v) => (
            <Badge key={v} variant={v}>
              {v}
            </Badge>
          ))}
        </div>
      </Variant>
      <Variant label="Input / Textarea" wide>
        <div className="space-y-2">
          <Input placeholder="Project name…" />
          <Textarea placeholder="Describe the change…" />
        </div>
      </Variant>
      <Variant label="Select" wide>
        <Select>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Pick an account" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="personal">personal</SelectItem>
            <SelectItem value="work">work</SelectItem>
          </SelectContent>
        </Select>
      </Variant>
      <Variant label="Dialog" wide>
        <Dialog>
          <DialogTrigger render={<Button variant="outline" />}>Open dialog</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dialog title</DialogTitle>
              <DialogDescription>A short description of the dialog.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline">Cancel</Button>
              <Button>Confirm</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Variant>
      <Variant label="Switch">
        <div className="flex items-center gap-3">
          <Switch defaultChecked />
          <Switch />
        </div>
      </Variant>
      <Variant label="Progress">
        <Progress value={62} />
      </Variant>
      <Variant label="Skeleton">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-28" />
        </div>
      </Variant>
      <Variant label="Spinner">
        <Spinner />
      </Variant>
      <Variant label="Alert — variants" wide>
        <div className="space-y-2">
          <Alert>
            <AlertTitle>Heads up</AlertTitle>
            <AlertDescription>A default informational alert.</AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <AlertTitle>Invalid manifest</AlertTitle>
            <AlertDescription>telar.yaml failed to parse.</AlertDescription>
          </Alert>
        </div>
      </Variant>
      <Variant label="Tabs" wide>
        <Tabs defaultValue="a">
          <TabsList>
            <TabsTrigger value="a">Overview</TabsTrigger>
            <TabsTrigger value="b">Details</TabsTrigger>
          </TabsList>
          <TabsContent value="a">Overview panel</TabsContent>
          <TabsContent value="b">Details panel</TabsContent>
        </Tabs>
      </Variant>
    </div>
  );
}
