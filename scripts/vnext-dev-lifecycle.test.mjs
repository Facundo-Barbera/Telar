import { describe, expect, test } from "bun:test";
import net from "node:net";
import {
  assertVnextWebPortAvailable,
  decideEngineStart,
  decideWorkerFailure,
  decideWorkerStart,
  canLaunchCockpit,
  desktopDevCommand,
  ownedChildrenForShutdown,
  resolveVnextWebPort,
  shouldLaunchDesktop,
  vnextCockpitUrl,
  webDevCommand,
} from "./vnext-dev-lifecycle.mjs";

describe("vNext dev lifecycle decisions", () => {
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

  test("the vNext desktop door targets the one explicit web port and reuses the existing runner", () => {
    expect(shouldLaunchDesktop([])).toBeFalse();
    expect(shouldLaunchDesktop(["--desktop"])).toBeTrue();
    expect(resolveVnextWebPort({})).toBe(43125);
    expect(resolveVnextWebPort({ TELAR_VNEXT_WEB_PORT: "43123" })).toBe(43123);
    expect(() => resolveVnextWebPort({ TELAR_VNEXT_WEB_PORT: "not-a-port" })).toThrow("TELAR_VNEXT_WEB_PORT");
    const cockpitUrl = vnextCockpitUrl(43123);
    expect(webDevCommand(43123)).toEqual({
      label: "web",
      args: ["run", "--cwd", "apps/vnext-web", "dev", "--", "--hostname", "127.0.0.1", "--port", "43123"],
      owned: true,
    });
    expect(desktopDevCommand(cockpitUrl)).toEqual({
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
      expect(typeof address === "object" && address ? assertVnextWebPortAvailable(address.port) : Promise.reject(new Error("server did not bind"))).rejects.toThrow("unavailable");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("the desktop is stopped only when this wrapper launched it", () => {
    const attachedDesktop = { name: "desktop", owned: false };
    const launchedDesktop = { name: "desktop", owned: desktopDevCommand(vnextCockpitUrl(43125)).owned };
    expect(ownedChildrenForShutdown([attachedDesktop, launchedDesktop])).toEqual([launchedDesktop]);
  });
});
