import { redirect } from "next/navigation";

/**
 * THE PROJECTS TABLE IS GONE; THIS IS THE DOOR CLOSING BEHIND IT.
 *
 * A REDIRECT RATHER THAN A DELETED ROUTE, and the difference is the entire
 * point of removing the screen. Deleting the file leaves a 404 — which is
 * honest, and is still a page you can be stuck on: a reload, a restored window,
 * a bookmark or a stale history entry all put you back on a dead end, which is
 * exactly the complaint that retired the table ("the app reloads and I land on
 * this page"). Every one of those now arrives at a composer instead.
 *
 * It costs four lines and it can be deleted the day nothing in anyone's history
 * says `/projects` — which is to say, never, so it stays.
 */
export const dynamic = "force-dynamic";

export default function RetiredProjectsPage() {
  redirect("/");
}
