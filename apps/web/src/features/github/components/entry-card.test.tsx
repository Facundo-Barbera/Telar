import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildForgeTimeline, type ForgeEntry } from "../github-forge";
import { EntryCard } from "./entry-card";

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

const entry = (over: Partial<ForgeEntry> = {}): ForgeEntry => ({
  id: "e1",
  kind: "comment",
  at: NOW - HOUR,
  author: "Facundo-Barbera",
  body: "",
  ...over,
});

describe("the opening post", () => {
  test("carries no author bar of its own — the facts line above it is the attribution", () => {
    const opening = buildForgeTimeline({ body: "", author: "Facundo-Barbera", createdAt: NOW - 2 * HOUR, comments: [] })[0]!;
    const markup = renderToStaticMarkup(<EntryCard entry={opening} />);
    expect(markup).not.toContain("Facundo-Barbera");
    expect(markup).not.toContain("opened this");
  });

  test("is still a card, so it is still the opening of a thread rather than loose prose", () => {
    const opening = buildForgeTimeline({ body: "", author: "Facundo-Barbera", createdAt: NOW, comments: [] })[0]!;
    expect(renderToStaticMarkup(<EntryCard entry={opening} />)).toContain("border-border");
  });

  test("the card is capped to a measure and centred, rather than its prose stopping short inside a full-width card", () => {
    const opening = buildForgeTimeline({ body: "Layout over data we already have.", createdAt: NOW, comments: [] })[0]!;
    const markup = renderToStaticMarkup(<EntryCard entry={opening} />);
    const card = /<div class="([^"]*)"/.exec(markup)?.[1] ?? "";
    expect(card).toContain("max-w-[64ch]");
    expect(card).toContain("self-center");
    expect(markup.split("max-w-[64ch]").length - 1).toBe(1);
  });
});

describe("a reply's author bar", () => {
  const bar = (over: Partial<ForgeEntry> = {}) => renderToStaticMarkup(<EntryCard entry={entry(over)} />);

  test("prints the time next to the name, not a column away from it", () => {
    const markup = bar({ url: "https://github.com/o/r/issues/692#issuecomment-1" });
    expect(markup).toContain("Facundo-Barbera");
    expect(markup.indexOf("ml-auto")).toBeGreaterThan(markup.indexOf("tabular-nums"));
    expect(markup.split("ml-auto").length - 1).toBe(1);
    expect(markup.slice(markup.indexOf("Open this comment on GitHub"))).toContain("ml-auto");
  });

  test("a review still says its verdict, and a plain comment still says nothing", () => {
    expect(bar({ kind: "review", state: "APPROVED" })).toContain("approved");
    expect(bar()).not.toContain("commented");
  });

  test("draws the author's face at the head of the bar, before the name", () => {
    const markup = bar({ avatar: "https://github.com/Facundo-Barbera.png" });
    expect(markup).toContain("https://github.com/Facundo-Barbera.png?size=48");
    expect(markup.indexOf("size=48")).toBeLessThan(markup.indexOf("Facundo-Barbera<"));
  });

  test("an author with no face gets a LETTER, not a blank circle or a broken image", () => {
    const markup = bar({ author: "app/renovate", avatar: undefined });
    expect(markup).not.toContain("<img");
    expect(markup).toContain(">R<");
  });

  test("carries the face AND the session link together, in the reading order who → when → whence", () => {
    const markup = bar({
      avatar: "https://github.com/Facundo-Barbera.png",
      sessionId: "session_a957243f19c8423db79774b49ea2134c",
      url: "https://github.com/o/r/issues/692#issuecomment-1",
    });
    expect(markup).toContain("size=48");
    expect(markup).toContain("session_a957243f19c8423db79774b49ea2134c");
    expect(markup.indexOf("size=48")).toBeLessThan(markup.indexOf("Facundo-Barbera<"));
    expect(markup.indexOf("tabular-nums")).toBeLessThan(markup.indexOf("session_a957243f"));
    expect(markup.split("ml-auto").length - 1).toBe(1);
    expect(markup.slice(markup.indexOf("Open this comment on GitHub"))).toContain("ml-auto");
  });

  test("a face with no session, and a session with no face, each still draw", () => {
    expect(bar({ avatar: "https://github.com/ada.png" })).not.toContain("/sessions/");
    const noFace = bar({ author: "app/renovate", sessionId: "session_1" });
    expect(noFace).not.toContain("<img");
    expect(noFace).toContain("/sessions/session_1");
    expect(noFace).toContain(">R<");
  });

  test("the face is decorative, so a screen reader hears the name once", () => {
    const markup = bar({ avatar: "https://github.com/ada.png" });
    expect(markup).toContain('alt=""');
    expect(markup).toContain('aria-hidden="true"');
  });
});

describe("a comment's session", () => {
  test("is a link to the conversation, beside the author who is always the same account", () => {
    const markup = renderToStaticMarkup(<EntryCard entry={entry({ author: "Facundo-Barbera", sessionId: "session_abc", body: "a finding" })} />);
    expect(markup).toContain("session_abc");
    expect(markup).toContain('href="/sessions/session_abc"');
    expect(markup).toContain("<a");
  });

  test("a comment with no session draws nothing at all", () => {
    const markup = renderToStaticMarkup(<EntryCard entry={entry({ author: "Facundo-Barbera", body: "a finding" })} />);
    expect(markup).not.toContain("/sessions/");
    expect(markup).not.toContain("session");
  });
});

describe("a card's reactions", () => {
  test("draws a counted pill per reaction, and marks the one the viewer is in", () => {
    const markup = renderToStaticMarkup(
      <EntryCard
        entry={entry({
          body: "a finding",
          reactions: [
            { content: "THUMBS_UP", count: 3, viewerHasReacted: true },
            { content: "ROCKET", count: 1, viewerHasReacted: false },
          ],
        })}
      />,
    );
    expect(markup).toContain("👍");
    expect(markup).toContain("🚀");
    expect(markup).toContain('aria-label="3 thumbs up, including you"');
    expect(markup).toContain('aria-label="1 rocket"');
    expect(markup.match(/data-mine="true"/g)).toHaveLength(1);
  });

  test("the opening post carries the issue's own reactions too", () => {
    const [body] = buildForgeTimeline({ body: "the ask", createdAt: NOW, comments: [], reactions: [{ content: "HEART", count: 2, viewerHasReacted: false }] });
    expect(renderToStaticMarkup(<EntryCard entry={body!} />)).toContain("❤️");
  });

  test("nobody reacted draws no row at all — and neither does a read that did not ask", () => {
    expect(renderToStaticMarkup(<EntryCard entry={entry({ body: "x", reactions: [] })} />)).not.toContain("data-reactions");
    expect(renderToStaticMarkup(<EntryCard entry={entry({ body: "x" })} />)).not.toContain("data-reactions");
  });

  test("a comment the repository hid does not show its reactions until revealed", () => {
    const markup = renderToStaticMarkup(
      <EntryCard entry={entry({ body: "spam", minimized: true, reactions: [{ content: "EYES", count: 5, viewerHasReacted: false }] })} />,
    );
    expect(markup).not.toContain("👀");
  });
});

describe("reacting from a card (#842)", () => {
  const react = async () => ({ reacted: true as const, reactions: [] });

  test("with somewhere to write, pills are toggles and the picker is offered", () => {
    const markup = renderToStaticMarkup(
      <EntryCard
        entry={entry({ body: "x", subjectId: "IC_1", reactions: [{ content: "HEART", count: 2, viewerHasReacted: true }] })}
        onReact={react}
      />,
    );
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Add a reaction"');
  });

  test("nobody has reacted yet — the picker is still there, so the first one can be added", () => {
    const markup = renderToStaticMarkup(<EntryCard entry={entry({ body: "x", subjectId: "IC_1", reactions: [] })} onReact={react} />);
    expect(markup).toContain('aria-label="Add a reaction"');
  });

  test("WITHOUT a node id there is nothing to write against, so the pills stay a read", () => {
    const markup = renderToStaticMarkup(
      <EntryCard entry={entry({ body: "x", reactions: [{ content: "HEART", count: 2, viewerHasReacted: false }] })} onReact={react} />,
    );
    expect(markup).toContain("❤️");
    expect(markup).not.toContain("aria-pressed");
    expect(markup).not.toContain("Add a reaction");
  });
});
