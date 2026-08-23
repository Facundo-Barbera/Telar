import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { SessionCockpit } from "@/components/session-cockpit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getLoom } from "@/lib/looms/store";

/**
 * A THREAD'S TRANSCRIPT, INSIDE THE LOOM'S HOME.
 *
 * Loom sessions are not ordinary Telar sessions — they are detached, owned by
 * the loom, and subtracted from every ordinary surface. Opening one therefore
 * must not eject the reader into `/projects/...`: this route mounts the same
 * cockpit UNDER `/looms`, framed by a strip that names the loom, the thread's
 * contract, and the way back to the room — so the reader always knows they are
 * standing inside the loom, one level down, not in a different app.
 */
export const dynamic = "force-dynamic";

export default async function LoomThreadPage({ params }: { params: Promise<{ id: string; sessionId: string }> }) {
  const { id, sessionId } = await params;
  const loom = getLoom(id);
  if (!loom) notFound();
  const thread = loom.threads.find((t) => t.sessionId === sessionId);
  const isOrigin = loom.originSessionId === sessionId;
  if (!thread && !isOrigin) notFound();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-2 text-xs">
        <Button variant="ghost" size="xs" render={<Link href={`/looms/${loom.id}`} />}>
          <ArrowLeftIcon data-icon="inline-start" />
          {loom.title}
        </Button>
        <span className="text-border">/</span>
        <span className="shrink-0 font-medium text-foreground">{thread ? thread.title : "origin conversation"}</span>
        {thread?.tier ? (
          <Badge variant="outline" className="font-mono text-[10px] uppercase text-verify">
            {thread.tier}
          </Badge>
        ) : null}
        {thread?.contract ? (
          <span className="min-w-0 truncate text-muted-foreground" title={thread.contract}>
            <span className="text-verify">contract:</span> {thread.contract}
          </span>
        ) : isOrigin ? (
          <span className="min-w-0 truncate text-muted-foreground">the conversation this loom was spun from</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <SessionCockpit projectId={loom.projectId} sessionId={sessionId} />
      </div>
    </div>
  );
}
