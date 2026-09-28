// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { remoteHome, RemoteStoreError } from "./store";

const savedTelarHome = process.env.TELAR_HOME;
const savedTelarCockpit = process.env.TELAR_COCKPIT;

afterEach(() => {
  if (savedTelarHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = savedTelarHome;
  if (savedTelarCockpit === undefined) delete process.env.TELAR_COCKPIT;
  else process.env.TELAR_COCKPIT = savedTelarCockpit;
});

describe("the remote home", () => {
  test("remoteHome applies the launcher discipline", () => {
    delete process.env.TELAR_COCKPIT;
    process.env.TELAR_HOME = "/tmp/telar-x";
    expect(() => remoteHome()).toThrow(RemoteStoreError);

    process.env.TELAR_COCKPIT = "1";
    process.env.TELAR_HOME = "relative/home";
    expect(() => remoteHome()).toThrow("absolute TELAR_HOME");

    process.env.TELAR_HOME = path.join(os.homedir(), ".telar-dev");
    expect(() => remoteHome()).toThrow("legacy");
  });
});
