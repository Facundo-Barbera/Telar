import { describe, expect, test } from "bun:test";
import net from "node:net";
import {
  assertWebPortAvailable,
  decideEngineStart,
  decideWorkerFailure,
  decideWorkerStart,
  canLaunchCockpit,
  describeWebExposure,
  desktopDevCommand,
  ownedChildrenForShutdown,
  isLoopbackHost,
  resolveWebHost,
  resolveWebPort,
  shouldLaunchDesktop,
  cockpitUrl,
  webDevCommand,
} from "./dev-lifecycle.mjs";

describe("Telar dev lifecycle decisions", () => {
  test("attaches to a healthy discovered engine and spawns only when discovery is unusable", () => {
    expect(decideEngineStart("healthy")).toBe("attach");
    expect(decideEngineStart("missing")).toBe("spawn");
    expect(decideEngineStart("unreachable")).toBe("spawn");
  });

  test("an attached engine is never included in shutdown targets", () => {
    const attached = { name: "engine", owned: false };
    const worker = { name: "worker", owned: true };
    const web = { name: "web", owned: true };
    expect(ownedChildrenForShutdown([attached, worker, web])).toEqual([worker, web]);
  });

  test("a worker start failure is fatal before the cockpit is launched", () => {
    expect(decideWorkerFailure()).toEqual({ fatal: true, startWeb: false });
    expect(canLaunchCockpit({ workerAction: "spawn", workerExited: true, workerRegistered: false })).toBeFalse();
    expect(canLaunchCockpit({ workerAction: "spawn", workerExited: true, workerRegistered: true })).toBeFalse();
  });

  test("an attached engine with a live worker never spawns a second one", () => {
    expect(decideWorkerStart({ registered: true, workerId: "worker_one", activeWorkers: 1 })).toBe("attach");
    expect(canLaunchCockpit({ workerAction: "attach", workerExited: false, workerRegistered: true })).toBeTrue();
    expect(decideWorkerStart({ registered: false, activeWorkers: 0 })).toBe("spawn");
  });

  test("the Telar desktop door targets the one explicit web port and reuses the existing runner", () => {
    expect(shouldLaunchDesktop([])).toBeFalse();
    expect(shouldLaunchDesktop(["--desktop"])).toBeTrue();
    // Next's own default. Safe to sit on a crowded port only because
    // `assertWebPortAvailable` fails loudly instead of letting Next slide
    // to 3001 and leave every printed URL pointing at the wrong cockpit.
    expect(resolveWebPort({})).toBe(3000);
    expect(resolveWebPort({ TELAR_WEB_PORT: "43123" })).toBe(43123);
    expect(() => resolveWebPort({ TELAR_WEB_PORT: "not-a-port" })).toThrow("TELAR_WEB_PORT");
    const url = cockpitUrl(43123);
    expect(webDevCommand(43123)).toEqual({
      label: "web",
      args: ["run", "--cwd", "apps/web", "dev", "--", "--hostname", "127.0.0.1", "--port", "43123"],
      owned: true,
    });
    expect(desktopDevCommand(url)).toEqual({
      label: "desktop",
      args: ["run", "--cwd", "apps/desktop", "dev"],
      env: { TELAR_DESKTOP_URL: "http://127.0.0.1:43123/" },
      owned: true,
    });
  });

  test("refuses a selected web port that is already occupied", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const address = server.address();
    try {
      expect(typeof address === "object" && address ? assertWebPortAvailable(address.port) : Promise.reject(new Error("server did not bind"))).rejects.toThrow("unavailable");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("the desktop is stopped only when this wrapper launched it", () => {
    const attachedDesktop = { name: "desktop", owned: false };
    const launchedDesktop = { name: "desktop", owned: desktopDevCommand(cockpitUrl(3000)).owned };
    expect(ownedChildrenForShutdown([attachedDesktop, launchedDesktop])).toEqual([launchedDesktop]);
  });
});

describe("reaching the cockpit from another device", () => {
  test("binds loopback unless told otherwise, and that default is the security boundary", () => {
    // The cockpit has no login and its sessions run tools without asking by
    // default, so the listener is the only thing standing between a stranger on
    // the network and a shell on this machine.
    expect(resolveWebHost({})).toBe("127.0.0.1");
    expect(resolveWebHost({ TELAR_WEB_HOST: "  100.72.141.10 " })).toBe("100.72.141.10");
    // Passed to a child process, so shell-hostile input is refused outright.
    expect(() => resolveWebHost({ TELAR_WEB_HOST: "127.0.0.1; rm -rf /" })).toThrow(/bare host or IP/);
    expect(() => resolveWebHost({ TELAR_WEB_HOST: "$(whoami)" })).toThrow(/bare host or IP/);
  });

  test("a non-loopback bind is announced, and a wildcard bind says so in the strongest terms", () => {
    expect(describeWebExposure("127.0.0.1", 3000)).toBeNull();
    expect(describeWebExposure("localhost", 3000)).toBeNull();
    expect(isLoopbackHost("::1")).toBeTrue();

    const tailnet = describeWebExposure("100.72.141.10", 3000);
    expect(tailnet).toContain("100.72.141.10:3000");
    expect(tailnet).toContain("shell on this machine");

    // `0.0.0.0` is accepted and is almost always a mistake — it follows the
    // machine onto whatever wifi it joins next.
    expect(describeWebExposure("0.0.0.0", 3000)).toContain("untrusted wifi");
  });

  test("the launch command, the printed URL and the port check all use the SAME host", () => {
    // Three places that could disagree. A URL advertising one address while
    // Next binds another is the failure that reads as "connection refused".
    expect(webDevCommand(3000, "100.72.141.10").args).toContain("100.72.141.10");
    expect(cockpitUrl(3000, "100.72.141.10")).toBe("http://100.72.141.10:3000/");
    // A bare IPv6 literal is not a URL authority without brackets.
    expect(cockpitUrl(3000, "::1")).toBe("http://[::1]:3000/");
    expect(cockpitUrl(3000)).toBe("http://127.0.0.1:3000/");
  });

  test("availability is checked on the interface that will actually be bound", async () => {
    // A port can be free on loopback and taken on the interface that matters;
    // checking the wrong one reports success and then fails at launch.
    const held = net.createServer();
    await new Promise((resolve) => held.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const port = held.address().port;
    await expect(assertWebPortAvailable(port, "127.0.0.1")).rejects.toThrow(/unavailable on 127\.0\.0\.1/);
    await new Promise((resolve) => held.close(resolve));
    await assertWebPortAvailable(port, "127.0.0.1");
  });
});
