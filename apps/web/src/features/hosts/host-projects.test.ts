// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { Project } from "@telar/engine-client";
import { projectLabel, projectsForHost, type HostProjects } from "./host-projects";
import { LOCAL_HOST_ID } from "@/lib/hosts/client";

const project = (id: string, name: string): Project => ({ id, name }) as unknown as Project;

// Ids are per engine, so two Macs can legally hand out the same one.
const SHARED = "project_9ab0";
const local: HostProjects = { hostId: LOCAL_HOST_ID, projects: [project(SHARED, "telar")] };
const remote: HostProjects = { hostId: "host_b", projects: [project(SHARED, "telar"), project("project_only_b", "notes")] };

describe("projectsForHost", () => {
  test("hands back a listing only to the host it describes", () => {
    expect(projectsForHost(remote, "host_b")).toBe(remote.projects);
    expect(projectsForHost(local, LOCAL_HOST_ID)).toBe(local.projects);
  });

  test("a listing from another Mac is dropped, not relabelled", () => {
    expect(projectsForHost(remote, LOCAL_HOST_ID)).toEqual([]);
    expect(projectsForHost(local, "host_b")).toEqual([]);
  });

  test("nothing read yet is the same as nothing to show", () => {
    expect(projectsForHost(undefined, LOCAL_HOST_ID)).toEqual([]);
    expect(projectsForHost(undefined, "host_b")).toEqual([]);
  });
});

describe("projectLabel", () => {
  test("the name this host gave it, whenever there is one", () => {
    expect(projectLabel({ name: "telar", hostName: "mini.lan", resolved: true })).toBe("telar");
    expect(projectLabel({ name: "telar", hostName: undefined, resolved: false })).toBe("telar");
  });

  test("a read that has not landed says so — it never shows the id", () => {
    expect(projectLabel({ name: undefined, hostName: undefined, resolved: false })).toBe("Loading…");
    expect(projectLabel({ name: undefined, hostName: "mini.lan", resolved: false })).toBe("Loading…");
  });

  test("a registry that answered and does not hold it names the Mac it is not on", () => {
    expect(projectLabel({ name: undefined, hostName: "mini.lan", resolved: true })).toBe("No such project on mini.lan");
    expect(projectLabel({ name: undefined, hostName: undefined, resolved: true })).toBe("No such project");
  });
});
