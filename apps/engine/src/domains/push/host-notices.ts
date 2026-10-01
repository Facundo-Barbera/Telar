import type { LiveSessionsAnswer, NotificationSounds, NotifyOn } from "@telar/engine-client";
import { desktopAttached, desktopNotices, desktopPresence, desktopStream, emptyDesktopState, notifyRoute, presentNow, type Channel, type DesktopState, type Presence } from "./desktop";
import { readNotifyOn, readSounds } from "./prefs";
import { soundFor } from "./push";
import { signals } from "./worker";

export type PairedHost = { id: string; baseUrl: string; deviceToken: string };
export type HostWatch = { states: Map<string, DesktopState>; etags: Map<string, string> };

const HOST_POLL_MS = 10_000;
const HOST_TIMEOUT_MS = 10_000;

export const hostPath = (hostId: string, path: string): string =>
  path.startsWith("/projects/") ? `/hosts/${encodeURIComponent(hostId)}${path}` : "/";

export function showsHere(notifyOn: NotifyOn, here: Presence | undefined, hostInUse: boolean, path: string, now: number): boolean {
  return !hostInUse && notifyRoute(notifyOn, here, path, now).desktop;
}

type PollOptions = { fetcher?: typeof fetch; channel?: Channel; notifyOn?: NotifyOn; sounds?: NotificationSounds; here?: Presence; now?: number };

async function exchangePresence(host: PairedHost, active: boolean, fetcher: typeof fetch): Promise<boolean> {
  try {
    const answer = await fetcher(`${host.baseUrl}/api/mobile/presence`, {
      method: "PUT",
      headers: { authorization: `Bearer ${host.deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ active }),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    return answer.ok && ((await answer.json()) as { hostInUse?: unknown }).hostInUse === true;
  } catch {
    return false;
  }
}

export async function pollHost(host: PairedHost, watch: HostWatch, options: PollOptions = {}): Promise<void> {
  const { fetcher = fetch, channel = desktopStream, notifyOn = readNotifyOn(), sounds = readSounds(), here = desktopPresence(), now = Date.now() } = options;
  const hostInUse = await exchangePresence(host, notifyOn !== "iphone" && presentNow(here, now), fetcher);
  const etag = watch.etags.get(host.id);
  const live = await fetcher(`${host.baseUrl}/api/sessions/live?all=1`, {
    headers: { authorization: `Bearer ${host.deviceToken}`, ...(etag === undefined ? {} : { "if-none-match": etag }) },
    signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
  });
  if (!live.ok) return;
  const answer = (await live.json()) as LiveSessionsAnswer;
  const nextTag = live.headers.get("etag");
  if (nextTag) watch.etags.set(host.id, nextTag);
  const { notices, state } = desktopNotices(watch.states.get(host.id) ?? emptyDesktopState(), signals(answer.sessions, answer.assignments, answer.projects, now), undefined);
  watch.states.set(host.id, state);
  for (const notice of notices) {
    const path = hostPath(host.id, notice.path);
    if (!showsHere(notifyOn, here, hostInUse, path, now)) continue;
    const sound = soundFor(sounds, notice.kind);
    channel.send({ ...notice, path, ...(sound ? { sound } : {}) });
  }
}

export function watchHosts(hosts: () => PairedHost[], fetcher: typeof fetch = fetch): () => void {
  const watch: HostWatch = { states: new Map(), etags: new Map() };
  let running = false;
  const tick = async () => {
    if (running || !desktopAttached()) return;
    running = true;
    try {
      await Promise.all(hosts().map((host) => pollHost(host, watch, { fetcher }).catch(() => {})));
    } catch {
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), HOST_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
