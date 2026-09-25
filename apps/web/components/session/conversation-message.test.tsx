// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationMessage } from "./conversation-message";

const shot = { id: "att_1", name: "Screenshot.png", mediaType: "image/png", bytes: 4, path: "/tmp/shot.png" };

test("an image-only message draws its picture and no empty paragraph", () => {
  const html = renderToStaticMarkup(<ConversationMessage text="" attachments={[shot]} />);
  expect(html).toContain("Screenshot.png");
  expect(html).not.toMatch(/<p[ >]/);
  // Anti-vacuity: words still draw as the paragraph they always were.
  expect(renderToStaticMarkup(<ConversationMessage text="look" attachments={[shot]} />)).toMatch(/<p[ >]/);
});
