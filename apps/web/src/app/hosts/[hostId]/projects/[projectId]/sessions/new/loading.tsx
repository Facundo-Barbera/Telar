import { SessionSkeleton } from "@/components/session-skeleton";

/** The canvas has no transcript to draw, so its skeleton holds the composer's
 *  place and nothing else — see `components/session-skeleton.tsx` (#407). */
export default function Loading() {
  return <SessionSkeleton composer />;
}
