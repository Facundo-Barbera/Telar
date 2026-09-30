"use client";

import { useEffect, useId, useRef, useState } from "react";
import { mermaid } from "@streamdown/mermaid";
import type { Artifact } from "@telar/engine-client";
import { attachmentUrl } from "@/features/plugins";
import { hostFetcher, LOCAL_HOST_ID } from "@/platform/engine/host-client";
import { MessageResponse } from "@/ui/message";
import { cn } from "@/ui/utils";
import { ARTIFACT_SANDBOX, artifactDocument, clampFrameHeight, type ArtifactHeight } from "../artifacts";

const MERMAID = { mermaid } as const;

type Loaded = { attachmentId: string; text?: string; failed?: boolean };

function useArtifactText(hostId: string, sessionId: string, attachmentId: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ attachmentId });
  useEffect(() => {
    const controller = new AbortController();
    hostFetcher(hostId)(attachmentUrl(sessionId, attachmentId), { signal: controller.signal })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((text) => setLoaded({ attachmentId, text }))
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ attachmentId, failed: true });
      });
    return () => controller.abort();
  }, [hostId, sessionId, attachmentId]);
  return loaded.attachmentId === attachmentId ? loaded : { attachmentId };
}

/** Html and svg run in an opaque-origin frame: it cannot reach the cockpit, its cookies or the network. */
function SandboxFrame({ kind, content, title, fill }: { kind: "html" | "svg"; content: string; title: string; fill: boolean }) {
  const frame = useId();
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    if (fill) return;
    const listen = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow) return;
      const data = event.data as Partial<ArtifactHeight> | null;
      if (data?.artifactFrame !== frame) return;
      const next = clampFrameHeight(data.height);
      if (next !== undefined) setHeight(next);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [fill, frame]);
  return (
    <iframe
      ref={ref}
      title={title}
      sandbox={ARTIFACT_SANDBOX}
      srcDoc={artifactDocument(kind, content, frame)}
      referrerPolicy="no-referrer"
      className={cn("block w-full border-0 bg-white", fill ? "h-full" : "")}
      style={fill ? undefined : { height: height ?? 160 }}
    />
  );
}

export function ArtifactView({ hostId = LOCAL_HOST_ID, sessionId, artifact, fill = false }: { hostId?: string; sessionId: string; artifact: Artifact; fill?: boolean }) {
  const { text, failed } = useArtifactText(hostId, sessionId, artifact.attachmentId);
  if (failed) return <p className="px-3 py-2 text-xs text-muted-foreground">This artifact could not be loaded.</p>;
  if (text === undefined) return <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>;
  if (artifact.kind === "html" || artifact.kind === "svg") return <SandboxFrame kind={artifact.kind} content={text} title={artifact.title} fill={fill} />;
  if (artifact.kind === "mermaid") return <MessageResponse className="px-3 py-2" plugins={MERMAID}>{`\`\`\`mermaid\n${text}\n\`\`\``}</MessageResponse>;
  return <MessageResponse className="px-3 py-2">{text}</MessageResponse>;
}
