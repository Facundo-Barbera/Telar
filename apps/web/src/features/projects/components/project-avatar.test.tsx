import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectAvatar } from "./project-avatar";

describe("ProjectAvatar", () => {
  test("a remote project's icon is fetched through that host", () => {
    const html = renderToStaticMarkup(<ProjectAvatar name="Delta" projectId="project_1" hostId="mac.lan" icon="k1" />);
    expect(html).toContain('src="/api/hosts/mac.lan/projects/project_1/icon?v=k1"');
  });

  test("a local project's icon is fetched from the local engine", () => {
    const html = renderToStaticMarkup(<ProjectAvatar name="Delta" projectId="project_1" icon="k1" />);
    expect(html).toContain('src="/api/projects/project_1/icon?v=k1"');
  });

  test("a remote project without an icon shows its initial", () => {
    const html = renderToStaticMarkup(<ProjectAvatar name="story" projectId="project_2" hostId="mac.lan" />);
    expect(html).not.toContain("<img");
    expect(html).toContain(">S<");
  });
});
