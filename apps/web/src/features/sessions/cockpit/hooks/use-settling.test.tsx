import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { Session } from "@telar/engine-client";
import { installTestDom, mount } from "@/test/dom";
import { useSettling } from "./use-settling";

installTestDom();

const session = { id: "session_1", updatedAt: 1, settledOverride: "settled", state: "active" } as unknown as Session;

function stubFetch(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/inbox")) return Response.json({ inbox: { autoSettleAfterHours: null } });
    return Response.json({ session: { ...session, settledOverride: null } });
  }) as typeof fetch;
  return urls;
}

async function unsettleOn(hostId: string): Promise<string[]> {
  const urls = stubFetch();
  let settling: ReturnType<typeof useSettling> | undefined;
  function Probe() {
    settling = useSettling(hostId, "session_1", { session, setSession: () => {}, setError: () => {} } as never);
    return null;
  }
  await mount(<Probe />);
  await act(async () => {
    await settling!.unsettle();
  });
  return urls.filter((url) => url.includes("/sessions/session_1"));
}

describe("unsettling from the cockpit", () => {
  test("a session on another Mac is patched through that Mac", async () => {
    const urls = await unsettleOn("mac-mini");
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toContain("/api/hosts/mac-mini/sessions/session_1");
  });

  test("a local session is patched locally", async () => {
    const urls = await unsettleOn("local");
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).not.toContain("/api/hosts/");
  });
});
