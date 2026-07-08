---
description: Review uncommitted changes and flag risks before a run
---

Review the uncommitted changes in this repository (`git status`, `git diff`).
For each changed file, summarize what changed and flag anything risky:
missing tests, behavior changes without gate coverage, protected-path
proximity, or seams with in-flight work. End with a short verdict on
whether this is ready to become a run.

$ARGUMENTS
