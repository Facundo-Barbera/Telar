// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PullLineCommentBody } from "./pull-line-comment";
import { ANCHOR_REASON } from "../pull-anchor";

const never = () => new Promise<never>(() => {});

describe("PullLineCommentBody", () => {
  test("a line that cannot be placed says why, and offers no button", () => {
    const html = renderToStaticMarkup(<PullLineCommentBody answer={{ reason: ANCHOR_REASON.push }} number={7} send={never} />);
    expect(html).toContain("Push your commits first to comment on the pull request.");
    expect(html).not.toContain("<button");
  });

  test("a placeable line offers to comment on the numbered pull request", () => {
    const html = renderToStaticMarkup(
      <PullLineCommentBody answer={{ anchor: { commitId: "a".repeat(40), path: "a.ts", line: 2, side: "RIGHT" } }} number={7} send={never} />,
    );
    expect(html).toContain("Comment on the pull request #7");
  });
});
