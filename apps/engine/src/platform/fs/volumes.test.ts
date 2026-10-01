import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fakeMounts, type FakeMounts } from "../../../test/fake-mount";
import { findVolumeMount, isMountPoint, mountPointForRoot, mountRootsFor, parseSolidState, parseVolumeUuid, probeAvailability, volumeForRoot } from "./volumes";

const drives: FakeMounts[] = [];
const fixture = (): FakeMounts => {
  const made = fakeMounts();
  drives.push(made);
  return made;
};
afterEach(() => {
  for (const drive of drives.splice(0)) drive.cleanup();
});

test("the mount roots are the platform's, and nothing anywhere else is external", () => {
  expect(mountRootsFor("darwin")).toEqual(["/Volumes"]);
  expect(mountRootsFor("linux")).toEqual(["/media", "/mnt"]);
  expect(mountRootsFor("win32")).toEqual([]);
});

test("a path under a mount root belongs to the volume one segment down", () => {
  const deps = { platform: "darwin" as const, mounts: ["/Volumes"] };
  expect(mountPointForRoot("/Volumes/TelarVR", deps)).toBe("/Volumes/TelarVR");
  expect(mountPointForRoot("/Volumes/TelarVR/code/thing", deps)).toBe("/Volumes/TelarVR");
});

test("an ordinary home-directory project is NOT on a volume — the APFS trap", () => {
  const deps = { platform: "darwin" as const, mounts: ["/Volumes"] };
  expect(mountPointForRoot("/Users/someone/code/thing", deps)).toBeUndefined();
  expect(mountPointForRoot("/Volumes", deps)).toBeUndefined();
});

test("a mounted drive has a device of its own; an empty folder left at its path does not", () => {
  const drives = fixture();
  const mount = drives.mount("TelarVR");
  expect(isMountPoint(mount, drives.deps)).toBe(true);

  drives.leaveEmptyMountpoint("TelarVR");
  expect(fs.existsSync(mount)).toBe(true);
  expect(isMountPoint(mount, drives.deps)).toBe(false);

  drives.unmount("TelarVR");
  expect(isMountPoint(mount, drives.deps)).toBe(false);
});

test("a volume identity is the mount AND the uuid, and absent without a uuid", () => {
  const drives = fixture();
  const mount = drives.mount("TelarVR");
  const root = path.join(mount, "project");
  fs.mkdirSync(root);

  expect(volumeForRoot(root, drives.deps)).toEqual({ mount, uuid: drives.uuidOf("TelarVR") });

  expect(volumeForRoot(root, { ...drives.deps, volumeUuid: () => undefined })).toBeUndefined();
});

test("VolumeUUID is read out of diskutil's plist, and absent when it is not there", () => {
  expect(
    parseVolumeUuid(`<dict>\n<key>VolumeName</key>\n<string>TelarVR</string>\n<key>VolumeUUID</key>\n<string>1B2C-3D4E</string>\n</dict>`),
  ).toBe("1B2C-3D4E");
  expect(parseVolumeUuid("<dict><key>VolumeName</key><string>TelarVR</string></dict>")).toBeUndefined();
});

test("a project on this machine's own disk is available, and missing once deleted", () => {
  const drives = fixture();
  const root = path.join(drives.mountRoot, "not-a-mount");
  fs.mkdirSync(root);

  expect(probeAvailability({ root }, drives.deps)).toBe("available");
  fs.rmSync(root, { recursive: true });
  expect(probeAvailability({ root }, drives.deps)).toBe("missing");
});

test("a project on a mounted drive is available", () => {
  const drives = fixture();
  const mount = drives.mount("TelarVR");
  const root = path.join(mount, "project");
  fs.mkdirSync(root);

  expect(probeAvailability({ root, volume: { mount, uuid: drives.uuidOf("TelarVR") } }, drives.deps)).toBe("available");
});

test("an unplugged drive is UNMOUNTED, not missing — the difference is a cable", () => {
  const drives = fixture();
  const mount = drives.mount("TelarVR");
  const root = path.join(mount, "project");
  fs.mkdirSync(root);
  const volume = { mount, uuid: drives.uuidOf("TelarVR") };

  drives.unmount("TelarVR");
  expect(probeAvailability({ root, volume }, drives.deps)).toBe("unmounted");
});

test("a RECREATED EMPTY MOUNTPOINT is unmounted, however readable it looks", () => {
  const drives = fixture();
  const mount = drives.mount("TelarVR");
  const root = path.join(mount, "project");
  fs.mkdirSync(root);
  const volume = { mount, uuid: drives.uuidOf("TelarVR") };

  drives.leaveEmptyMountpoint("TelarVR");
  fs.mkdirSync(root, { recursive: true });
  expect(fs.statSync(root).isDirectory()).toBe(true);

  expect(probeAvailability({ root, volume }, drives.deps)).toBe("unmounted");
});

test("a folder deleted from a drive that IS here is missing, not unmounted", () => {
  const drives = fixture();
  const mount = drives.mount("TelarVR");
  const root = path.join(mount, "project");
  fs.mkdirSync(root);
  const volume = { mount, uuid: drives.uuidOf("TelarVR") };

  fs.rmSync(root, { recursive: true });
  expect(probeAvailability({ root, volume }, drives.deps)).toBe("missing");
});

test("a drive is found by uuid wherever macOS mounted it this time", () => {
  const drives = fixture();
  drives.mount("TelarVR");
  const uuid = drives.uuidOf("TelarVR");

  const moved = drives.remount("TelarVR", "TelarVR 1");
  expect(findVolumeMount(uuid, drives.deps)).toBe(moved);
});

test("a drive that is not plugged in is not found, and an empty mountpoint is not it", () => {
  const drives = fixture();
  drives.mount("TelarVR");
  const uuid = drives.uuidOf("TelarVR");

  drives.leaveEmptyMountpoint("TelarVR");
  expect(findVolumeMount(uuid, drives.deps)).toBeUndefined();
});

test("diskutil's Solid State line says whether a disk spins", () => {
  const info = (solid: string) => `   Device Identifier:         disk4s1\n   Protocol:                  USB\n   Solid State:               ${solid}\n   Media Type:                Generic\n`;
  expect(parseSolidState(info("No"))).toBe(false);
  expect(parseSolidState(info("Yes"))).toBe(true);
  expect(parseSolidState("   Device Identifier:         disk3s1\n")).toBeUndefined();
});
