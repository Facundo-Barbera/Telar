/**
 * The rule that keeps a project id with the Mac that minted it.
 *
 * Ids are per engine, so two Macs can hand out the same one for different
 * projects. That makes "which host is this list from" load-bearing rather than
 * decorative: a list whose host no longer matches the address cannot be
 * relabelled, only dropped, and this is where that is pinned.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Project } from "@telar/engine-client";
import { projectLabel, projectsForHost, type HostProjects } from "./host-projects";
import { LOCAL_HOST_ID } from "./client";

const project = (id: string, name: string): Project => ({ id, name }) as unknown as Project;

/** The same id on two Macs, which is legal and is the whole point. */
const SHARED = "project_9ab0";
const local: HostProjects = { hostId: LOCAL_HOST_ID, projects: [project(SHARED, "telar")] };
const remote: HostProjects = { hostId: "host_b", projects: [project(SHARED, "telar"), project("project_only_b", "notes")] };

describe("projectsForHost", () => {
  test("hands back a listing only to the host it describes", () => {
    expect(projectsForHost(remote, "host_b")).toBe(remote.projects);
    expect(projectsForHost(local, LOCAL_HOST_ID)).toBe(local.projects);
  });

  test("a listing from another Mac is dropped, not relabelled", () => {
    // The ids match, so a check on ids alone would have passed this through and
    // linked host_b's project as if it were this Mac's.
    expect(projectsForHost(remote, LOCAL_HOST_ID)).toEqual([]);
    expect(projectsForHost(local, "host_b")).toEqual([]);
  });

  test("nothing read yet is the same as nothing to show", () => {
    expect(projectsForHost(undefined, LOCAL_HOST_ID)).toEqual([]);
    expect(projectsForHost(undefined, "host_b")).toEqual([]);
  });
});

/**
 * The breadcrumb's rule. #204's screenshot is a header reading a raw project id
 * while the composer waits on a session another Mac holds — and the id is the
 * least informative thing that could be there, since the same string names
 * different work on two Macs.
 */
describe("projectLabel", () => {
  test("the name this host gave it, whenever there is one", () => {
    expect(projectLabel({ name: "telar", hostName: "mini.lan", resolved: true })).toBe("telar");
    // A name that arrived before the registry finished is still a name.
    expect(projectLabel({ name: "telar", hostName: undefined, resolved: false })).toBe("telar");
  });

  test("a read that has not landed says so — it never shows the id", () => {
    expect(projectLabel({ name: undefined, hostName: undefined, resolved: false })).toBe("Loading…");
    expect(projectLabel({ name: undefined, hostName: "mini.lan", resolved: false })).toBe("Loading…");
  });

  test("a registry that answered and does not hold it names the Mac it is not on", () => {
    // The one that matters: this is a row opened against the wrong Mac, and
    // saying it is the difference between a visible fault and a name that looks
    // like it is still loading.
    expect(projectLabel({ name: undefined, hostName: "mini.lan", resolved: true })).toBe("No such project on mini.lan");
    expect(projectLabel({ name: undefined, hostName: undefined, resolved: true })).toBe("No such project");
  });
});
