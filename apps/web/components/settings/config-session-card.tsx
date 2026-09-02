"use client";

/**
 * THE WAY IN TO A CONFIG SESSION.
 *
 * What stood here was a bespoke designer: its own transcript, its own
 * composer, its own one-shot call to the engine's textgen. It could not search
 * the web, could not see a picture and could not run a command — and a Telar
 * session does all three. So this is a door rather than a chat: it points a
 * NORMAL session at Telar's own settings and gets out of the way.
 *
 * The manual tools next door did not go anywhere. Picking a colour by hand is
 * faster than asking for it, and this pane keeps being the place to do that.
 */

import { useEffect, useState } from "react";
import { MessageSquarePlusIcon, SparklesIcon } from "lucide-react";
import { configBrief, configStateRoot, ensureConfigProject } from "@/lib/config-session";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";

export function ConfigSessionCard() {
  const [stateRoot, setStateRoot] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string>();

  useEffect(() => {
    let live = true;
    void configStateRoot().then((root) => live && setStateRoot(root));
    return () => {
      live = false;
    };
  }, []);

  const open = async () => {
    if (!stateRoot) return;
    setBusy(true);
    setTrouble(undefined);
    try {
      const projectId = await ensureConfigProject(stateRoot);
      // The brief rides as the first draft rather than being sent: the person
      // should see what their agent is about to be told, and edit it.
      const draft = encodeURIComponent(configBrief(stateRoot));
      window.location.href = `/?project=${encodeURIComponent(projectId)}&draft=${draft}`;
    } catch (cause) {
      setTrouble(cause instanceof Error ? cause.message : "That session could not be started.");
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHeader icon={<SparklesIcon />} label="Configure with an agent" />
      <PanelBody className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <div className="space-y-1">
          <p className="text-sm font-medium">Ask a session to do it</p>
          <p className="mx-auto max-w-md text-xs text-muted-foreground">
            A normal Telar session, pointed at this instance&rsquo;s settings. It can search the web, fetch a picture and write a
            theme straight into the folder this pane reads.
          </p>
        </div>
        {stateRoot && <code className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">{stateRoot}/appearance</code>}
        <Button size="sm" disabled={!stateRoot || busy} onClick={() => void open()}>
          <MessageSquarePlusIcon /> {busy ? "Starting…" : "Start a config session"}
        </Button>
        {/* The one state worth a sentence: no engine means no session, and the
            pane's manual tools still work, so this is information rather than
            an error. */}
        {!stateRoot && <p className="text-xs text-muted-foreground">Needs a running engine.</p>}
        {trouble && <p className="text-xs text-warning">{trouble}</p>}
      </PanelBody>
    </Panel>
  );
}
