"use client";

// Concern 4 — REAL global settings. The live app's "settings" is only the
// accounts/usage page; here we propose the actual settings a loom operator
// needs: default agent config (Auto Mode DEFAULT ON, model, effort), appearance,
// notifications, with accounts + usage demoted to their own tabs. Sectioned
// side-nav, no long scroll (concern 5).
import { useState } from "react";
import {
  SparklesIcon,
  PaletteIcon,
  BellIcon,
  KeyRoundIcon,
  GaugeIcon,
  StarIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
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
  ToggleRow,
  Segmented,
  type SettingsSection,
} from "./shell";

const SECTIONS: SettingsSection[] = [
  { id: "agent", label: "Agent defaults", icon: SparklesIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "notifications", label: "Notifications", icon: BellIcon },
  { id: "accounts", label: "Accounts", icon: KeyRoundIcon, count: 3 },
  { id: "usage", label: "Usage", icon: GaugeIcon },
];

const ACCENTS = [
  { name: "violet", cls: "bg-violet-500" },
  { name: "blue", cls: "bg-blue-500" },
  { name: "emerald", cls: "bg-emerald-500" },
  { name: "amber", cls: "bg-amber-500" },
  { name: "rose", cls: "bg-rose-500" },
];

const ACCOUNTS = [
  { name: "personal", provider: "claude", tier: "Max 20x", def: true, five: 42, week: 61 },
  { name: "work", provider: "claude", tier: "Team", def: false, five: 18, week: 34 },
  { name: "codex", provider: "codex", tier: "Plus", def: false, five: 7, week: 12 },
];

function meterBar(pct: number) {
  return pct >= 90
    ? "[&>[data-slot=progress-indicator]]:bg-destructive"
    : pct >= 70
      ? "[&>[data-slot=progress-indicator]]:bg-amber-500"
      : "";
}

export function GeneralSettingsDemo() {
  const [active, setActive] = useState("agent");
  const [dirty, setDirty] = useState(false);
  const touch = () => setDirty(true);

  // Agent defaults
  const [autoMode, setAutoMode] = useState(true);
  const [model, setModel] = useState("claude-opus-4-8");
  const [effort, setEffort] = useState<"minimal" | "low" | "medium" | "high">("high");
  const [parallel, setParallel] = useState("4");
  const [defaultAcct, setDefaultAcct] = useState("personal");

  // Appearance
  const [theme, setTheme] = useState<"system" | "light" | "dark">("dark");
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [accent, setAccent] = useState("violet");
  const [mono, setMono] = useState(false);

  // Notifications
  const [desktop, setDesktop] = useState(true);
  const [sound, setSound] = useState(false);
  const [nCharter, setNCharter] = useState(true);
  const [nDeadend, setNDeadend] = useState(true);
  const [nReady, setNReady] = useState(true);
  const [nGate, setNGate] = useState(false);

  const set = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    touch();
  };

  return (
    <SettingsShell
      title="Settings"
      subtitle="Defaults for every session & loom"
      sections={SECTIONS}
      active={active}
      onSelect={setActive}
      dirty={dirty}
    >
      {active === "agent" && (
        <>
          <SettingsGroup
            title="Auto Mode"
            description="Autonomous build-and-verify. On by default for every new agent — the loom doctrine's happy path."
          >
            <ToggleRow
              label="Auto Mode on by default"
              hint="New sessions and looms start autonomous. Individual runs can still be paused."
              icon={ShieldCheckIcon}
              checked={autoMode}
              onCheckedChange={set(setAutoMode)}
            />
          </SettingsGroup>

          <SettingsGroup title="Model & reasoning">
            <Row
              label="Default model"
              hint="Applied to the orchestrator and every thread unless a project overrides it."
              control={
                <Select value={model} onValueChange={(v) => v && set(setModel)(String(v))}>
                  <SelectTrigger className="h-8 w-52 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude-fable-5">Claude Fable 5</SelectItem>
                    <SelectItem value="claude-opus-4-8">Claude Opus 4.8</SelectItem>
                    <SelectItem value="claude-sonnet-5">Claude Sonnet 5</SelectItem>
                    <SelectItem value="claude-haiku-4-5">Claude Haiku 4.5</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <Row
              label="Reasoning effort"
              hint="Higher effort spends more thinking budget per turn."
              control={
                <Segmented
                  value={effort}
                  onChange={set(setEffort)}
                  options={[
                    { value: "minimal", label: "Min" },
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Med" },
                    { value: "high", label: "High" },
                  ]}
                />
              }
            />
            <Row
              label="Max parallel threads"
              hint="How many threads a loom may weave at once."
              control={
                <Select value={parallel} onValueChange={(v) => v && set(setParallel)(String(v))}>
                  <SelectTrigger className="h-8 w-20 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["2", "3", "4", "6", "8"].map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
          </SettingsGroup>

          <SettingsGroup title="Account">
            <Row
              label="Default account"
              hint="Which login new sessions bill to when a project doesn't pin one."
              control={
                <Select
                  value={defaultAcct}
                  onValueChange={(v) => v && set(setDefaultAcct)(String(v))}
                >
                  <SelectTrigger className="h-8 w-40 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNTS.map((a) => (
                      <SelectItem key={a.name} value={a.name}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
          </SettingsGroup>
        </>
      )}

      {active === "appearance" && (
        <SettingsGroup>
          <Row
            label="Theme"
            hint="The shell ships dark; light is token-ready for a future toggle."
            control={
              <Segmented
                value={theme}
                onChange={set(setTheme)}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            }
          />
          <Row
            label="Density"
            hint="Compact tightens rows across dashboards, lists and this panel."
            control={
              <Segmented
                value={density}
                onChange={set(setDensity)}
                options={[
                  { value: "comfortable", label: "Comfortable" },
                  { value: "compact", label: "Compact" },
                ]}
              />
            }
          />
          <Row
            label="Accent"
            hint="Tints primary actions and active states."
            control={
              <div className="flex items-center gap-1.5">
                {ACCENTS.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    aria-label={a.name}
                    onClick={() => set(setAccent)(a.name)}
                    className={`size-5 rounded-full ${a.cls} ring-offset-2 ring-offset-background transition-all ${
                      accent === a.name ? "ring-2 ring-foreground" : "hover:scale-110"
                    }`}
                  />
                ))}
              </div>
            }
          />
          <ToggleRow
            label="Monospace message body"
            hint="Render assistant prose in the mono font."
            checked={mono}
            onCheckedChange={set(setMono)}
          />
        </SettingsGroup>
      )}

      {active === "notifications" && (
        <>
          <SettingsGroup title="Channels">
            <ToggleRow
              label="Desktop notifications"
              hint="System-level alerts when Telar is in the background."
              checked={desktop}
              onCheckedChange={set(setDesktop)}
            />
            <ToggleRow
              label="Sound"
              hint="A soft chime on the events below."
              checked={sound}
              onCheckedChange={set(setSound)}
            />
          </SettingsGroup>
          <SettingsGroup
            title="Notify me when"
            description="The three human touch-points plus failures — everything else stays silent."
          >
            <ToggleRow
              label="A loom needs its charter"
              checked={nCharter}
              onCheckedChange={set(setNCharter)}
            />
            <ToggleRow
              label="A thread hits a dead-end question"
              checked={nDeadend}
              onCheckedChange={set(setNDeadend)}
            />
            <ToggleRow
              label="A loom is ready to accept"
              hint="ready → done is always yours to press."
              checked={nReady}
              onCheckedChange={set(setNReady)}
            />
            <ToggleRow
              label="A gate fails verification"
              checked={nGate}
              onCheckedChange={set(setNGate)}
            />
          </SettingsGroup>
        </>
      )}

      {active === "accounts" && (
        <SettingsGroup
          title="Provider logins"
          description="Relocated here from the old top-level page. Tokens stay on disk, never in the registry."
        >
          {ACCOUNTS.map((a) => (
            <Row
              key={a.name}
              label={
                <span className="flex items-center gap-2">
                  <span className="font-mono">{a.name}</span>
                  <Badge variant="secondary" className="text-[10px] uppercase">
                    {a.provider}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {a.tier}
                  </Badge>
                  {a.def && (
                    <Badge className="gap-1 text-[10px]">
                      <StarIcon className="size-3" /> default
                    </Badge>
                  )}
                </span>
              }
              hint={`5-hour ${a.five}% · weekly ${a.week}%`}
            />
          ))}
        </SettingsGroup>
      )}

      {active === "usage" && (
        <SettingsGroup
          title="Plan limits"
          description="One tab instead of the whole settings page. Live utilization per account."
        >
          {ACCOUNTS.map((a) => (
            <div key={a.name} className="space-y-2 px-4 py-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono">{a.name}</span>
                <Badge variant="outline" className="text-[10px]">
                  {a.tier}
                </Badge>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">5-hour</span>
                  <span className="font-mono">{a.five}%</span>
                </div>
                <Progress value={a.five} className={`h-1.5 ${meterBar(a.five)}`} />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Weekly</span>
                  <span className="font-mono">{a.week}%</span>
                </div>
                <Progress value={a.week} className={`h-1.5 ${meterBar(a.week)}`} />
              </div>
            </div>
          ))}
        </SettingsGroup>
      )}
    </SettingsShell>
  );
}
