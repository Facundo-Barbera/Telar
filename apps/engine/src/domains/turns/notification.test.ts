import { describe, expect, test } from "bun:test";
import { type CohortMember, NotificationDetail } from "@telar/engine-client";
import { cohortNotification } from "./notification";

const result = (index: number, text: string, extra: Partial<CohortMember> = {}): CohortMember => ({
  sessionId: `session_worker_${index}`,
  title: `Worker ${index}`,
  outcome: "result",
  fetch: { sessionId: "session_host", runId: `run_result_${index}` },
  firstLine: text.split("\n")[0]!.slice(0, 200),
  excerpt: text.slice(0, 1_500),
  chars: text.length,
  at: index,
  ...extra,
});

const notify = (members: CohortMember[]) =>
  cohortNotification({ cohortId: "coh_test", openedAt: 0, members, reason: "all", minutes: 240, fallbackFetch: { sessionId: "session_worker_0", runId: "coh_test" } });

const report = (index: number) => `PR #${index} is open, head abc${index}, CI green.\nChanged the parser and its tests.\nTested: bun test src/parser.`;

describe("a cohort's one notification", () => {
  test("quotes every member's short result whole, so no follow-up read is needed", () => {
    const members = Array.from({ length: 5 }, (_, index) => result(index, report(index)));
    const { body } = notify(members);
    for (const index of members.keys()) expect(body).toContain(`<<<\n${report(index)}\n>>>`);
    expect(body).not.toMatch(/more chars not shown/);
  });

  test("twenty members with worst-case results stay inside the body's limit and still name every read", () => {
    const long = (index: number) => `${"x".repeat(250)} ${index}\n${"the long middle of a report ".repeat(200)}`;
    const members = Array.from({ length: 20 }, (_, index) => result(index, long(index), { title: "t".repeat(200), spent: "s".repeat(300) }));
    const detail = notify(members);
    expect(NotificationDetail.safeParse(detail).success).toBe(true);
    expect(detail.body.endsWith("None of this was typed by a person.")).toBe(true);
    expect(detail.entries).toHaveLength(20);
  });

  test("twenty members with ordinary results each get a share of the body", () => {
    const members = Array.from({ length: 20 }, (_, index) => result(index, `${report(index)}\n${"More detail on what was done. ".repeat(30)}`));
    const { body } = notify(members);
    expect(body.length).toBeLessThanOrEqual(8_000);
    for (const index of members.keys()) {
      expect(body).toContain(`PR #${index} is open`);
      expect(body).toContain(`runId: "run_result_${index}"`);
    }
  });

  test("a short result is not crowded out by a long one", () => {
    const { body } = notify([result(0, "a".repeat(1_400) + "\nend"), result(1, report(1))]);
    expect(body).toContain(`<<<\n${report(1)}\n>>>`);
  });
});
