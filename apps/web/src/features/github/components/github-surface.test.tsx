import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GitHubSurface } from "./github-surface";

const draw = (props: Parameters<typeof GitHubSurface>[0]) => renderToStaticMarkup(<GitHubSurface {...props} />);

describe("a surface nobody has drilled into", () => {
  test("draws no sub-strip at all", () => {
    const markup = draw({ kind: "issues", projectId: "p" });
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain("Open issues");
  });
});

describe("the sub-strip", () => {
  const open = { numbers: [675, 666], at: 675 };

  test("holds the list as its first chip and one chip per open detail", () => {
    const markup = draw({ kind: "issues", projectId: "p", open });
    expect(markup).toContain('aria-label="Open issues"');
    expect(markup).toContain("Issues");
    expect(markup).toContain("#675");
    expect(markup).toContain("#666");
    expect(markup).toContain('aria-label="Close #675"');
    expect(markup).toContain('aria-label="Close #666"');
  });

  test("names the pull-request list by its own name, not 'Issues'", () => {
    const markup = draw({ kind: "pulls", projectId: "p", open: { numbers: [700] } });
    expect(markup).toContain('aria-label="Open pull requests"');
    expect(markup).toContain("Pull requests");
  });

  test("exactly one chip is selected, whichever body is showing", () => {
    const detail = draw({ kind: "issues", projectId: "p", open });
    expect(detail.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(detail).toContain('title="Issue #675"');
    const list = draw({ kind: "issues", projectId: "p", open: { numbers: [675, 666] } });
    expect(list.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(list).toContain('title="All issues"');
  });
});

describe("the list and a detail are a swap", () => {
  test("the list is not mounted under a detail", () => {
    const list = draw({ kind: "issues", projectId: "p", open: { numbers: [675] } });
    expect(list).toContain("asking gh…");
    const detail = draw({ kind: "issues", projectId: "p", open: { numbers: [675], at: 675 } });
    expect(detail).not.toContain("asking gh…");
    expect(detail).toContain('aria-label="Open issues"');
    expect(detail).toContain('title="All issues"');
  });

  test("the surface owns its height, so a detail's pinned merge footer has a floor", () => {
    expect(draw({ kind: "pulls", projectId: "p" })).toContain("h-full");
  });
});
