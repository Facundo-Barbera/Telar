// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnFailureRow } from "./transcript";

/**
 * #290 — ONE OF A TURN'S FAILURES IS NOT A FAULT.
 *
 * Every failure used to render as the same attention marker holding the
 * provider's sentence. That is right for a crash and wrong for a usage limit,
 * which is a wait with a known end: the useful fact is the time it lifts, the
 * session is not broken, and there is something the person can do about it.
 */
describe("a turn waiting for a usage limit to reset", () => {
  const render = (props: Parameters<typeof TurnFailureRow>[0]) => renderToStaticMarkup(<TurnFailureRow {...props} />);
  /** Fixed, and read back through the same formatter the row uses, so the test
   *  asserts the row's own wording rather than the runner's timezone. */
  const resumeAt = Date.now() + 3 * 60 * 60 * 1000;
  const expected = new Date(resumeAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  test("says when the limit lifts, and names which limit", () => {
    const markup = render({ failure: "limited", code: "rate_limited", resumeAt, limitType: "five_hour" });
    expect(markup).toContain(`Waiting for the five hour limit to reset at ${expected}`);
    // NOT the destructive colour: a session that is merely waiting must not
    // read as one that is damaged.
    expect(markup).not.toContain("text-destructive");
  });

  test("offers Resume now only when there is something to press", () => {
    const withButton = render({ failure: "limited", code: "rate_limited", resumeAt, onResume: () => {} });
    expect(withButton).toContain("Resume now");
    expect(render({ failure: "limited", code: "rate_limited", resumeAt })).not.toContain("Resume now");
  });

  test("the button says it is working, so a slow resume is not pressed twice", () => {
    const markup = render({ failure: "limited", code: "rate_limited", resumeAt, onResume: () => {}, resuming: true });
    expect(markup).toContain("Resuming…");
    expect(markup).toContain("disabled");
  });

  test("`other` names nothing actionable, so it earns no parenthetical", () => {
    const markup = render({ failure: "limited", code: "rate_limited", resumeAt, limitType: "other" });
    expect(markup).toContain("Waiting for the limit to reset at");
  });

  test("an ordinary failure still reads as one, with its own message", () => {
    const markup = render({ failure: "the CLI died", code: "driver_failed" });
    expect(markup).toContain("the CLI died");
    expect(markup).not.toContain("Waiting for the");
  });

  test("a limit with no reset time falls back rather than promising a time it lacks", () => {
    // Otherwise the row renders "resets at Invalid Date", which is worse than
    // the plain failure it replaced.
    const markup = render({ failure: "limited", code: "rate_limited" });
    expect(markup).toContain("limited");
    expect(markup).not.toContain("Waiting for the");
  });
});
