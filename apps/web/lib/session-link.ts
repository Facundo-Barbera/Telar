/**
 * A SESSION'S ADDRESS AS SOMETHING YOU CAN PASTE.
 *
 * `sessionHref` is a path, and deliberately so — it is pure, it runs on the
 * server, and it cannot know which origin this app is being served from (a
 * loopback port in the desktop shell, a Tailscale name, somebody's LAN
 * address). A path is the right answer for a <Link> and the wrong one for a
 * message to a person: "/projects/p1/sessions/s1" is not a link.
 *
 * So the joining happens here, once, on the client — rather than twice, in the
 * two surfaces that offer "Copy link", which is exactly where the two would
 * drift into disagreeing about what a session's link is.
 *
 * ON THE SERVER IT IS THE PATH, UNCHANGED. Nothing calls this there today; a
 * thrown error would be the worse answer if something did.
 */
export function sessionLink(href: string): string {
  if (typeof window === "undefined") return href;
  try {
    return new URL(href, window.location.origin).toString();
  } catch {
    return href;
  }
}
