/**
 * A PANEL ROW DRAWS NO COLOURED RAIL. The owner wants no coloured left stripes
 * anywhere; a row that has a state says it as a word at its trailing edge.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelEmpty, PanelRow } from "@/ui/panel";

test("a panel row renders no rail", () => {
  const markup = renderToStaticMarkup(<PanelRow>row</PanelRow>);
  expect(markup).not.toContain("before:");
  expect(markup).not.toContain("w-[3px]");
  expect(markup).not.toContain("data-tone");
});

test("an empty panel names what is missing, and offers the fix when there is one", () => {
  const html = renderToStaticMarkup(
    <PanelEmpty title="No servers" action={<button type="button">Add a server</button>}>
      Nothing is configured for this project.
    </PanelEmpty>,
  );
  expect(html).toContain("No servers");
  expect(html).toContain("Nothing is configured for this project.");
  expect(html).toContain("<button");
  expect(renderToStaticMarkup(<PanelEmpty title="No servers" />)).not.toContain("<button");
});
