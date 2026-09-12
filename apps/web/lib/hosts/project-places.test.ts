// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { projectPlaces } from "./project-places";

const row = (hostId: string | undefined, projectId: string, hostName?: string) => ({
  ...(hostId ? { hostId } : {}),
  ...(hostName ? { hostName } : {}),
  projectId,
});

describe("projectPlaces", () => {
  test("one Mac's group has one place, and it is that Mac's own project id", () => {
    expect(projectPlaces([row(undefined, "project_local"), row(undefined, "project_local")])).toEqual([
      { projectId: "project_local" },
    ]);
  });

  test("two Macs' checkouts are two places, each keeping ITS OWN project id", () => {
    // The whole point: ids are minted per engine, so a destination built from
    // one Mac's id would open nothing on the other.
    expect(projectPlaces([row("host_b", "project_over_there", "mini"), row(undefined, "project_here")])).toEqual([
      { projectId: "project_here" },
      { hostId: "host_b", hostName: "mini", projectId: "project_over_there" },
    ]);
  });

  test("this Mac comes first however the rows arrived", () => {
    const places = projectPlaces([row("host_b", "p_b", "mini"), row("host_a", "p_a", "studio"), row(undefined, "p_here")]);
    expect(places.map((place) => place.hostName ?? "this Mac")).toEqual(["this Mac", "mini", "studio"]);
  });

  test("the remotes keep a stable order, so the header does not re-shuffle between polls", () => {
    const forwards = projectPlaces([row("host_a", "p_a", "studio"), row("host_b", "p_b", "mini")]);
    const backwards = projectPlaces([row("host_b", "p_b", "mini"), row("host_a", "p_a", "studio")]);
    expect(forwards).toEqual(backwards);
    // By NAME, not by id — the name is what the reader sees on the badge.
    expect(forwards.map((place) => place.hostName)).toEqual(["mini", "studio"]);
  });

  test("one Mac holding two registrations of one repository is two places", () => {
    // Legal: the same repository cloned twice on one machine. They are two
    // checkouts and two destinations, even though they share a group.
    expect(projectPlaces([row(undefined, "project_one"), row(undefined, "project_two")])).toHaveLength(2);
  });

  test("a project-less row contributes nothing", () => {
    expect(projectPlaces([{ projectId: undefined }, row(undefined, "project_here")])).toEqual([
      { projectId: "project_here" },
    ]);
    expect(projectPlaces([])).toEqual([]);
  });
});
