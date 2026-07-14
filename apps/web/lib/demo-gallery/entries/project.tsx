// LANE: project (NEW) — the per-project hub view (route /projects/<id>) that no
// redesign lane covered. Rounds 17 A/B were competing takes; the owner picked a
// HYBRID (Variant C) as the direction. C leads; A and B are kept for reference
// as retired candidates. Demo components live under
// apps/web/lib/demo-gallery/project/**.
import type { DemoEntry } from "../registry";
import { ProjectGithubTab } from "../project/github-tab";

export const projectEntries: DemoEntry[] = [
  {
    id: "project-github-tab",
    title: "Project hub — GitHub tab",
    concern: "extra",
    variant: "RECOMMENDED · avatar-first, constrained, For-you default",
    summary:
      "The project hub reframed around GitHub at the app-standard content width (matching the dashboard column — the hub was the one full-width surface). Tab strip is Sessions | Looms | GitHub | Settings (Git renamed, Files cut). The GitHub tab is avatar-first with four sub-views: FOR YOU (review requested, assigned, mentions, your failing checks — one glance = what needs me), ISSUES and PRS as master-detail (list left with search + Open/Mine/Review-requested chips + j/k, detail right) at full GitHub fidelity (real github.com avatars w/ initials fallback, colored label pills, state glyphs, checks clusters, review chips, head→base mono, rendered markdown + threads), and REPO (worktrees w/ reclaimable + the new conflict-radar chip per branch from a dry git merge-tree, compact branches, cleanup). Bridge actions make it Telar not a mirror: issue → Work-on-this (pre-seeded session sheet) + Weave-loom (charter seed); PR → Check-out (local worktree) + Land (guarded gates→ff-merge→push→delete/reclaim pipeline). Replay: re-running #146's checks flips its red check green so it leaves For-you's failing list. Both themes; retires project-git-unified.",
    Component: ProjectGithubTab,
  },
];
