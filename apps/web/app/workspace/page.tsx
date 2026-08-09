import Link from "next/link";
import { MessageSquareIcon } from "lucide-react";
import { resolveEnabledAccount } from "@telar/core/accounts";
import { getChat, listChats } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { WorkspaceTabs } from "@/components/workspace/chips";
import { MasterChat } from "@/components/workspace/master-chat";

// The transcript is read from the store at request time, same as the project
// session page and the queue route.
export const dynamic = "force-dynamic";

// THE MASTER'S FRONT DOOR (story 5.7, SPEC CAP-3) — AND IT IS THE DESTINATION
// ROOT, not a child of it.
//
// ui-contract.md "Shell" is one sentence and it decides this file's path:
// "Workspace is one top-level destination with two tabs — Chat (front door) and
// Queue (the drawer behind it). The queue does not pretend to be its own
// destination." The queue held `/workspace` through story 5.3 because it was
// the only tab that existed; shipping chat as `/workspace/chat` would have left
// the global nav landing on the drawer with the front door nested UNDER it,
// which is the stated relationship inverted. So the queue moved down a segment
// (app/workspace/queue/page.tsx) and this is the root. Item deep links —
// `/workspace/<id>` — are what the story protected, and they are untouched.
//
// ONE ROUTE, NO ID IN IT — the difference between this page and
// /projects/[name]/sessions/[id]. A project session is one of many and is
// addressed; the master is ONE conversation the human returns to, so the route
// is its identity and the session id is an implementation detail resolved here
// (the same shape the escalation and steerer surfaces use). A reload therefore
// lands on the master, not on "a master session that was open once".
//
// RESUMED BY ROLE, NOT BY A POINTER. Nothing stores "the current master chat":
// the master row is simply the newest non-archived chat whose persisted
// `Chat.role` is "master" (listChats sorts by updatedAt desc, and story 5.6 is
// what put that role on the row). No second source of truth to drift, and an
// archived master correctly starts a fresh one rather than resurrecting itself.
export default async function WorkspacePage() {
  const resumed = listChats(undefined, { archived: "exclude" }).find((c) => c.role === "master");
  const chat = resumed ? getChat(resumed.id) : undefined;

  // THE RESUMED ACCOUNT IS RE-VALIDATED, NOT TRUSTED (5.7's review). A master
  // keeps its own account because its harness transcript lives under that
  // account's config dir — but an account can be disabled or removed between
  // two sit-downs, and `chat.account` taken on faith produces a composer whose
  // every Enter 400s at the route's account gate, reported only as a red line
  // in the transcript with nothing offered. `resolveEnabledAccount(preferred)`
  // answers the exact question ("is this one still usable, and if not what
  // is?"), except that it returns undefined for a name that has left the
  // registry entirely — hence the second call, which is the first-ever
  // master's path too.
  const account = (resolveEnabledAccount(chat?.account) ?? resolveEnabledAccount())?.name;
  if (!account) {
    return (
      // THE DESTINATION KEEPS ITS SHELL IN EVERY STATE. Without the header this
      // one branch would drop the tabs, and the only way to the queue from a
      // workspace with no enabled account would be the global sidebar — a
      // destination that stops being two-tabbed when something is wrong.
      <div className="flex h-dvh flex-col">
        <PageHeader leading={<WorkspaceTabs active="chat" />} title="Workspace" />
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState
            icon={MessageSquareIcon}
            title="No enabled account"
            description="Enable an account in Settings before talking to the workspace."
            action={
              <Button
                variant="outline"
                size="sm"
                render={<Link href="/settings?section=providers" />}
              >
                Open provider settings
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  // A MASTER WHOSE ACCOUNT MOVED RESUMES AS HISTORY, NOT AS A SESSION. The
  // harness session id is meaningless under a different account's config dir,
  // so resuming it would fail on the first turn; the persisted transcript is
  // still true and still seeds, and the next turn simply starts a fresh harness
  // session that the store then re-anchors by role.
  const resumable = account === chat?.account;

  return (
    <MasterChat
      // Keyed on the resumed session so navigating in after the store has
      // gained a master chat re-seeds the adapter's state from it.
      key={chat?.id ?? "new"}
      account={account}
      {...(resumable && chat?.model ? { model: chat.model } : {})}
      {...(resumable && chat?.id ? { initialSessionId: chat.id } : {})}
      initialMessages={chat?.messages}
    />
  );
}
