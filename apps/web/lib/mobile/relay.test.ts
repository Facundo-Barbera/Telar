// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { parseRelayConfig, relayConfig, relayDelivery } from "./relay";
import type { PushRecord } from "./push";
test("tests never read a real Mac's Keychain; malformed relay endpoints are refused", () => {

  expect(relayConfig()).toBeUndefined();
  const token = "a".repeat(64);
  expect(parseRelayConfig({ url: "https://relay.example", token })).toEqual({ url: "https://relay.example", token });
  for (const url of ["http://relay.example", "https://user:pass@relay.example", "https://relay.example/path", "https://relay.example?token=oops"]) expect(parseRelayConfig({url,token})).toBeUndefined();
});
test("relay registers the paired destination before sending and preserves provider expiry", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${input}`);
      return Response.json(init?.method === "POST" ? { status:410 } : {});
    }) as typeof fetch;
    const record = {deviceId:"phone",token:"a".repeat(64),topic:"com.telar.mobile",sandbox:false,activities:[]} as unknown as PushRecord;
    const delivery = {token:record.token,topic:record.topic,sandbox:false,kind:"alert" as const,collapseId:"a".repeat(64),payload:{aps:{alert:"Test"}}};
    expect(await relayDelivery({url:"https://relay.example",token:"b".repeat(64)},record,delivery)).toBe(410);
    expect(calls).toEqual(["PUT https://relay.example/v1/devices/phone","POST https://relay.example/v1/devices/phone/push"]);
    expect(await relayDelivery({url:"https://relay.example",token:"b".repeat(64)},{...record,sandbox:true},delivery)).toBe(400);
    expect(calls).toHaveLength(2);
  } finally {globalThis.fetch=original;}
});
