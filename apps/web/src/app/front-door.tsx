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
 * THE READS ANSWER THE LAUNCHES THE NOTE CANNOT: a first launch, a cleared
 * store, or a note naming a project since removed. They run in PARALLEL — the
 * server did them one after the other.
 *
 * AND ONLY THOSE (#490). A note that redirected leaves nothing for them to
 * decide, so they are not made: the correction a stale note needs comes from the
 * cockpit the redirect opened, not from a second read racing it. What they cost
 * on that path was a 101.6 KB list nobody looked at, issued after the redirect
 * and contending with the opening it had just triggered.
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
      const [registry, activity] = await Promise.all([
        api.projects().then((value) => value, () => undefined),
        /**
         * ONE INTEGER PER PROJECT, NOT ONE ROW PER SESSION (#490).
         *
         * This used to be `liveSessions({ all: true })`, and the argument for
         * the whole list was sound as far as it went: the route's default is the
         * unsettled rows, which is right for a rail and wrong for a ranking, so
         * a machine whose work had all been shelved would have ranked on nothing
         * and opened the wrong project. What it missed is that the ranking never
         * wanted rows. `composerProject` folds them into a single `updatedAt`
         * per project and this screen renders none of them — 101.6 KB and 21.8
         * ms on the owner's store, 291 sessions, for roughly twenty numbers.
         *
         * `projectActivity` IS THAT FOLD, done in the engine off its session
         * index. Same population as the list it replaces — active sessions, so an
         * archived-only project still scores nothing and falls through to
         * most-recently-registered — and the same answer for every input.
         *
         * Its own project list still carries no `createdAt`, which is why
         * `api.projects()` is beside it rather than replaced by it.
         */
        api.projectActivity().then((value) => value, () => undefined),
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
      const chosen = projects.length === 1 ? projects[0]!.id : composerProject(projects, activity?.projects ?? []);
      writeFrontDoorNote(projects, chosen);
      go(canvasHrefFor(chosen));
    };

    /**
     * AND NOT AT ALL IF THE NOTE ALREADY ANSWERED (#490).
     *
     * `go(remembered)` above runs before any await and sets `left.current`, so
     * on the common launch the redirect has ALREADY happened by the time this
     * line is reached. Everything `decide()` could still do from there is
     * nothing: the two screens it can set are both guarded on `!left.current`,
     * and the note it would rewrite is rewritten by the cockpit this redirect
     * just opened — `session-cockpit.tsx` writes it from the registry read it
     * makes anyway, which is the mechanism a stale note has always been
     * corrected by.
     *
     * What the read was still costing is real: it went out AFTER the redirect
     * and then competed for the two-slot read gate (`lib/engine/client.ts`,
     * `READ_BUDGET`) against the opening reads of the route it had just sent the
     * reader to — the contention `client.ts` describes.
     *
     * THE SAME REASONING AS THE RETRY BELOW, deliberately: that timer has always
     * held it ("nothing to poll once we are on our way out"), and this is the
     * first tick of it, which simply never asked.
     */
    if (!left.current) void decide();
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
