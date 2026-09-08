import { notFound } from "next/navigation";
import { RecoveryCards } from "./cards";

/**
 * A DEVELOPMENT-ONLY GALLERY of the recovered-turn card, in each state a person
 * reaches it in — with and without a held backlog, mid-decision, and the two
 * shapes of continuation text.
 *
 * It renders the SAME `RecoveryActions` the cockpit renders, so what is looked
 * at here is what a recovered session shows. The reason it exists: the bug this
 * card fixes was never a logic error — the engine could already continue a
 * recovered conversation — it was that the button which did so was called
 * "Discard recovered run" and the one that replayed your prompt was listed
 * first. Hierarchy and wording are checked by looking at them.
 *
 * 404 in production: a gallery is not a product screen.
 */
export const dynamic = "force-static";

export default function RecoveryCardPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <RecoveryCards />;
}
