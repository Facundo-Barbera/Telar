// GALLERY (delete with /gallery) — env group: the env-review gate. A live-critic
// loom with no server recipe pauses on a setup-agent-PROPOSED servers.yaml the
// human Accepts / Steers / Rejects.
import type { GalleryFixtureBundle } from "../index";
import { at, galleryId, makeLoom, makeServers, makeService } from "../builders";

export const envBundles: GalleryFixtureBundle[] = [
  {
    id: galleryId("env-review"),
    label: "Env review · proposed servers.yaml",
    group: "env",
    description:
      "The setup agent's proposed lane recipe (a Postgres + web service graph) awaiting Accept / Steer / Reject.",
    surface: "env",
    loom: makeLoom({
      id: galleryId("env-review"),
      project: "aurora",
      kind: "story",
      title: "Cohort retention chart on the analytics dashboard",
      prompt: "Add a weekly cohort-retention heatmap to the Aurora overview page.",
      state: "env-review",
      createdAt: at(0),
      updatedAt: at(300),
      proposedServers: makeServers({
        driver: "host-process",
        services: {
          db: makeService({
            command: "docker compose up -d postgres",
            portStrategy: "fixed",
            port: 5432,
            readyCheck: { kind: "command", run: "pg_isready -h localhost -p 5432" },
            reset: "psql -f db/reset.sql",
          }),
          web: makeService({
            command: "bun run dev",
            portStrategy: "dynamic",
            portInject: { env: "PORT" },
            readyCheck: { kind: "http", path: "/api/health", status: 200 },
            dependsOn: ["db"],
            env: { DATABASE_URL: "postgres://localhost:5432/aurora", NODE_ENV: "test" },
          }),
        },
      }),
    }),
    threads: [],
    feed: [],
  },
];
