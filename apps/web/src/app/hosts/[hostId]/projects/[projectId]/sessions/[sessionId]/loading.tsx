import { SessionSkeleton } from "@/components/session-skeleton";

/** The frame a conversation lands in — see `components/session-skeleton.tsx`
 *  for why this file is a latency fix rather than a decoration (#407). */
export default function Loading() {
  return <SessionSkeleton />;
}
