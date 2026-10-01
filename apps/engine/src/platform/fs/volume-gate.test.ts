import { afterEach, expect, jest, test } from "bun:test";
import { mountRootsFor } from "./volumes";
import { probeVolume, VolumeGate, volumeOf } from "./volume-gate";

const MOUNTS = mountRootsFor(process.platform)[0]!;

afterEach(() => jest.useRealTimers());

const never = () => new Promise<never>(() => {});

test("a volume whose stat never answers is slow after the probe's timeout, and its paths are closed", async () => {
  jest.useFakeTimers();
  const gate = new VolumeGate((mount) => probeVolume(mount, never));
  const admitted = gate.admit([`${MOUNTS}/Slow/worktrees/a`, `${MOUNTS}/Slow/worktrees/b`]);
  jest.advanceTimersByTime(2_000);
  await admitted;
  expect(gate.degraded).toEqual(new Map([[`${MOUNTS}/Slow`, "slow"]]));
  expect(gate.open(`${MOUNTS}/Slow/worktrees/a`)).toBe(false);
  expect(await gate.run(`${MOUNTS}/Slow/worktrees/a`, async () => "touched")).toBeUndefined();
});

test("each volume is probed once, and an empty folder where a drive was is missing", async () => {
  const probed: string[] = [];
  const gate = new VolumeGate(async (mount) => {
    probed.push(mount);
    return mount === `${MOUNTS}/Gone` ? "missing" : "ok";
  });
  await gate.admit([`${MOUNTS}/Gone/a`, `${MOUNTS}/Gone/b`, `${MOUNTS}/Here/a`, "/Users/someone/a"]);
  expect(probed.sort()).toEqual(["/", `${MOUNTS}/Gone`, `${MOUNTS}/Here`]);
  expect(gate.open(`${MOUNTS}/Here/a`)).toBe(true);
  expect(gate.open(`${MOUNTS}/Gone/a`)).toBe(false);
  const sameDevice = async () => ({ dev: 1 });
  expect(await probeVolume(`${MOUNTS}/Gone`, sameDevice)).toBe("missing");
  expect(await probeVolume("/", sameDevice)).toBe("ok");
});

test("a call that outlives its timeout degrades its volume, and a recheck that answers opens it again", async () => {
  jest.useFakeTimers();
  let health: "ok" | "slow" = "ok";
  const gate = new VolumeGate(async () => health);
  const hung = gate.run(`${MOUNTS}/Usb/wt/a`, never, 500);
  jest.advanceTimersByTime(500);
  expect(await hung).toBeUndefined();
  expect(gate.open(`${MOUNTS}/Usb/wt/b`)).toBe(false);
  health = "slow";
  await gate.recheck();
  expect(gate.open(`${MOUNTS}/Usb/wt/b`)).toBe(false);
  health = "ok";
  await gate.recheck();
  expect(gate.open(`${MOUNTS}/Usb/wt/b`)).toBe(true);
  expect(volumeOf(`${MOUNTS}/Usb/wt/b`)).toBe(`${MOUNTS}/Usb`);
});
