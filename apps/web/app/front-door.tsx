"use client";

/**
 * THE FRONT DOOR DECIDES IN THE BROWSER NOW (#407).
 *
 * It used to be a `force-dynamic` server component that awaited
 * `listProjects()`, then `liveSessions()`, and only then answered with a
 * redirect. Everything about that was serial and none of it could paint: the
 * desktop window opened, asked Next, which asked the engine twice, and the first
 * pixel of the app waited on both — on the owner's store, seconds of nothing
 * before a canvas the app could have shown immediately.
 *
 * THE DECISION IS THE SAME (`composerProject`). What changed is where it is
 * made, and that it does not have to be made at all in the common case: the last
 * visit left a note saying which projects exist and which one it was in, so the
 * first frame can redirect and the reads that follow only correct the note.
 *
 * THE READS STILL HAPPEN, because a note is not evidence. They run in PARALLEL
 * — the server did them one after the other — and they are what answers a first
 * launch, a cleared store, or a note that named a project since removed.
 *
 * THE TWO SCREENS THAT ARE NOT A REDIRECT are unchanged: no projects, or no
 * engine. Both are `FirstRun`, and both are polled while shown — adding a
 * project from that screen must carry you onward, and the engine coming back
 * must too, neither of which is a render this component can be told about.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FirstRun } from "@/components/first-run";
import { canvasHrefFor, composerProject, noteDestination, readFrontDoorNote, writeFrontDoorNote } from "@/lib/composer-project";
import { createEngineApi } from "@/lib/engine/client";
import { installNavigationMarks, startNavigation } from "@/lib/perf-marks";

/** How often to re-ask while the door is standing open with nothing to show.
 *  Only ever runs on a screen that is otherwise completely idle. */
const RETRY_MS = 2_000;

type Door =
  /** Before anything is known. Paints nothing — a flash of "Add a project"
   *  under someone with fourteen of them is a worse lie than a blank frame. */
  | { state: "deciding" }
  | { state: "empty" }
  | { state: "unreachable" };

export function FrontDoor() {
  const router = useRouter();
  const [door, setDoor] = useState<Door>({ state: "deciding" });
  /** A redirect is issued once. `router.replace` does not unmount this
   *  component synchronously, so without this the poll below would fire it
   *  again on every tick while the new route loads. */
  const left = useRef(false);

  useEffect(() => {
    installNavigationMarks();
    let cancelled = false;

    const go = (href: string) => {
      if (cancelled || left.current) return;
      left.current = true;
      // The launch is a navigation too, and the one whose timing people feel
      // most — it is the whole of "opening Telar".
      startNavigation(href, "route");
      router.replace(href);
    };

    // THE NOTE FIRST, and before any await: this is the frame the redirect
    // should happen on.
    const remembered = noteDestination(readFrontDoorNote());
    if (remembered) go(remembered);

    const api = createEngineApi();
    const decide = async () => {
      const [registry, live] = await Promise.all([
        api.projects().then((value) => value, () => undefined),
        // Only to rank; its own project list carries no `createdAt`, so it
        // cannot answer the cold case on its own.
        //
        // ALL OF THEM (#457): the route's default is the unsettled rows, which
        // is right for a rail and wrong for a ranking — a machine whose work has
        // all been shelved would rank on nothing and open the wrong project.
        // One read at the front door, not a poll, so the whole list is cheap
        // here in a way it is not on the rail.
        api.liveSessions({ all: true }).then((value) => value, () => undefined),
      ]);
      if (cancelled) return;
      if (!registry) {
        // The engine is not answering. A redirect would land the reader on a
        // canvas that cannot explain itself; this screen can.
        if (!left.current) setDoor({ state: "unreachable" });
        return;
      }
      const { projects } = registry;
      if (projects.length === 0) {
        writeFrontDoorNote([], undefined);
        if (!left.current) setDoor({ state: "empty" });
        return;
      }
      const chosen = projects.length === 1 ? projects[0]!.id : composerProject(projects, live?.sessions ?? []);
      writeFrontDoorNote(projects, chosen);
      go(canvasHrefFor(chosen));
    };

    void decide();
    // Nothing to poll once we are on our way out.
    const timer = window.setInterval(() => {
      if (left.current) return;
      void decide();
    }, RETRY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [router]);

  if (door.state === "deciding") return <div className="h-full" aria-busy="true" />;
  return <FirstRun unreachable={door.state === "unreachable"} />;
}
