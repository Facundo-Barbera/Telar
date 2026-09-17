/**
 * PROVISIONING THE PUSH RELAY, from Settings (#579) — a local structural type
 * and an accessor, like `desktop-app.ts`, because in a browser tab the bridge
 * is never there.
 *
 * THE WRITE IS THE SHELL'S AND NOT THE SERVER'S. The cockpit's server reads
 * this Keychain item on every push and must never be able to write one: it
 * answers requests from every paired phone, and a route that can mint the
 * credential every push rides on is a much larger thing to get right than one
 * that can only spend it.
 *
 * OPTIONAL, like `workspace.openFile`: a shell packaged before this exists does
 * not carry it, and the pane says so rather than offering a button nothing
 * answers.
 */
type DesktopPush = {
  /** `{ ok: true }`, or a sentence about what to do. Never echoes what was
   *  pasted — see apps/desktop/push-relay.js. */
  provisionRelay?: (config: { url: string; token: string }) => Promise<{ ok: boolean; error?: string }>;
};

export function desktopPush(): DesktopPush | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { telarDesktop?: { push?: DesktopPush } }).telarDesktop?.push;
}
