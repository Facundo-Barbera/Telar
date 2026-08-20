# Setup transcript — ozom-gv

> Companion to [`orchestrator.md`](./orchestrator.md) §4. **Illustrative, not a
> log** — the facts are real (verified against the repo and GitHub API on
> 2026-08-19), the dialogue is constructed to test the design.
>
> Purpose: find out whether "look first, ask only what you can't determine"
> survives contact with a real project. It mostly does, and where it doesn't is
> the useful part (§7).

---

## 1. The opening ask

> **Facundo:** Listen for the issues in hito 1 and keep an eye on them. When
> something's ready to work on, take it and open a PR.

Twenty-three words. Everything below is the orchestrator closing the gap between
that and something it can run unattended — **without asking Facundo a single
question it could answer itself.**

---

## 2. What it goes and finds

No questions yet. It looks.

**The work source.** "hito 1" is a milestone, not a label:

```
gh api "repos/:owner/:repo/milestones?state=all" --paginate
```

| # | Title | Open | Closed | Due |
| --- | --- | --- | --- | --- |
| 1 | `Hito 1 · Agosto` | 9 | 13 | 2026-08-29 |
| 2 | `Hito 2 · Septiembre` | 4 | 0 | 2026-09-30 |
| 3 | `Hito 3 · Octubre` | 2 | 1 | 2026-10-31 |
| 4 | `Hito 4 · Nov–Dic` | 14 | 1 | 2026-12-18 |

Current = #1: today is inside its window, it's the only one with real closed
work, and recent merged PRs cite its issues (#480→#448, #483→#414).

*Note the separator is ` · ` — a middle dot — and Hito 4 uses an en-dash. Title
matching cannot assume ASCII.*

**The label vocabulary — nearly empty.** 11 labels, 9 are unused GitHub defaults:

| Label | Open | Meaning (from its description) |
| --- | --- | --- |
| `urgente` | 7 | *"Prioridad alta: atender esta semana."* |
| `needs-approval` | 2 | *"Do not start implementation until explicit approval is recorded."* |
| `enhancement` | 20 | generic work marker, no signal |

**There is no "ready" label.** 14 of 37 open issues carry zero labels, including
6 of the 9 in Hito 1. So "when something's ready" cannot mean a label query —
which the orchestrator has to notice rather than assume.

**Assignee is not a lock.** All 37 open issues are assigned (34 to Facundo).

**The gate.** `package.json` → `"ci": "bun scripts/ci.ts"`. Reading the script
rather than assuming its exit codes:

```
0  every gate ran and passed      → safe to push
1  at least one gate FAILED       → CI will be red
2  nothing failed, a gate SKIPPED → NOT a green light
```

Exit 2 is Docker being down so pgTAP can't run. One workflow, `.github/workflows/ci.yml`,
four jobs: `Lint · Typecheck · Unit`, `Production build`, `pgTAP RLS gate`,
`Migration timestamp monotonicity`. Playwright is deliberately excluded (8.7 min
vs 1.9).

**Conventions, all already written down.** `AGENTS.md`, and
`docs/instrucciones-dev/worktree-agent-brief.md` which is *authoritative over it*.
Between them: branch `t3code/<english-slug>`; conventional commits with Spanish
subjects; PR body opens with `Closes #N` in English (*"GitHub does not parse
«Cierra #N» — which is why several finished issues stayed open for months"*); a
`## Verificación` section quoting the literal command and results, with an
explicit `No verificado:` line; one issue per PR; adjacent findings go to
`docs/hallazgos/<branch>.md` rather than getting fixed inline; never merge your
own PR.

**Worktrees already exist.** `scripts/lib/worktree.ts` allocates per-worktree
slots with their own port and Supabase stack. `bun run up` is idempotent.
~480 MB per stack against ~7.75 GB of Docker ⇒ about five concurrent.

**Dependencies are prose.** `Desprendimiento de #445`, `Depende de #409`. And
#479 explicitly *denies* one: *"Se puede hacer ahora y no depende de él."*
Nothing queryable — this must be read.

**Comments override bodies.** `AGENTS.md` says the most recent comment wins.
#431's fourth comment: *"Retiro los dos comentarios anteriores."* #432's body:
*"Cuerpo reescrito el 18-ago tras medir de nuevo."*

---

## 3. What it asks

Four questions. Each is policy or ambiguity — none is lookup-able.

> **Orchestrator:**
>
> Hito 1 · Agosto, due in 10 days, 9 open. Gate is `bun run ci`, base `main`,
> `t3code/<slug>` branches, `Closes #N`. I've read AGENTS.md and the worktree
> brief. Four things I can't settle by looking:
>
> **1 — I don't think you want hito 1.** Your last 5 closed issues and your 6
> newest open ones (#486–#491, four `urgente`) have **no milestone**. Milestone
> assignment looks like it lapsed around the 18th while the actual work moved to
> freshly-filed production bugs. A strict `milestone:"Hito 1 · Agosto"` filter
> skips your entire week. Queue = the milestone, `urgente` regardless of
> milestone, or the union?
>
> **2 — `bun run ci` exit 2.** Docker down, pgTAP couldn't run. Your script says
> that's not a green light. Do I push and let CI's pgTAP job adjudicate, or hold
> until Docker's up? And how many worktree stacks may I hold at once — I compute
> about five from the RAM.
>
> **3 — Draft or ready-for-review?** The brief says open a draft early because
> CI's pgTAP job *is* the database test environment. But `main` has no branch
> protection at all, so "never merge your own PR" is convention only. If I'm
> pushing branches unattended I'd rather you set the boundary explicitly.
>
> **4 — `needs-approval`.** The description says "until explicit approval is
> recorded" but I can't find what recording looks like — no comment pattern, no
> label removal I can trace. What do I watch for?

> **Facundo:** Union, but urgente first. Hold on exit 2 — I'd rather wake up to
> fewer PRs than to red CI. Four stacks. Draft PRs always, I merge. For
> needs-approval I remove the label, watch for that.

---

## 4. What it writes down

The artifact, abridged. Prose with commands quoted verbatim, not YAML — this is
what gets read at 2am.

```markdown
## Work source
gh issue list --state open --limit 200 --json number,title,labels,milestone,updatedAt
Queue = milestone "Hito 1 · Agosto" ∪ label `urgente`.  urgente sorts first.
Issues are the ONLY source. docs/inbox-dev/ is retired history — never read as tasks.

## Reading an issue
The most recent comment WINS over the body. Read the whole thread.
Dependencies are prose: "Depende de #N", "Desprendimiento de #N" — and #479
denies one outright. Parse; never assume the body is current.

## Never touch
needs-approval → hard stop. Approval = Facundo removes the label.
Generated: supabase/functions/_shared/pd/**, src/generated/role-permissions.ts,
           *_rbac_grants_sync.sql
Pinned:    next, react, react-dom, eslint-config-next
Secrets:   .env*, supabase/.env.keys, docs/keys/

## Gate         bun run ci
0 → push   1 → hold, report   2 → HOLD (Docker down; not a green light)
Always `bun install` first in a fresh worktree.

## Work
bun run up (idempotent, allocates slot+port+stack).  Max 4 concurrent.
Branch t3code/<english-slug> from main.  One issue per PR.
Adjacent findings → docs/hallazgos/<branch>.md, shipped with the PR. Never fixed inline.

## Done
Draft PR. Body starts `Closes #N` (English — «Cierra #N» does not parse).
## Verificación quotes the literal command + counts, plus explicit "No verificado:".
NEVER merge. NEVER write "verified" about something not run.

## Assumed — confirm
- "Área · frase" title convention inferred from ~30 issues, never written down.
- Playwright out of CI ⇒ E2E-dependent criteria get "No verificado", not a claim.
```

---

## 5. The dry run

```
Hito 1 · Agosto (9 open, due 2026-08-29)  ∪  urgente (7)          19:04

DISPATCH
  #491  urgente   KB · embeddings model id sent with an `openai/` prefix
                  OpenAI rejects. Root cause found, 200-vs-400 table, "Dónde
                  nace" points at the code. Small, no deps.
  #432            Idioma · voseo rioplatense. 15 exact i18n keys tabulated with
                  replacements + a guard test, two in-repo precedents cited.
  #458            Consola · Vendedores shows UUIDs, overflows, won't sort.
                  Three observable defects; explicitly "con el mismo criterio
                  que #451", which is closed — the pattern exists.
  #445            Análisis PD · temperature 0 survives via #427's retry.
                  file:line given. Scope to the primary fix; the two "conviene
                  resolverlos juntos" extras → hallazgos.

READ COMMENTS FIRST
  #450  urgente   Fix is named and the RPC exists, but body says "ver el
                  comentario de abajo, incluido el aviso sobre #358" — and #358
                  is open in Hito 4. Dispatch only if not blocked.
  #479            Forensics excellent, explicitly not blocked by #478 — but
                  "Resultado esperado" is one sentence; which surface is
                  undesigned. Borderline.

SKIP
  #464  urgente   "Requiere autorización explícita y una campaña desechable."
                  A human production procedure, not agent work.
  #486  urgente   Needs live Google Ads credentials + quota. Can't close from a
                  worktree. Could dispatch a read-only investigation → hallazgos.
  #457            Self-splits: "los puntos 2 y 3 son decisión de JMB".
  #409  urgente   Identity backbone. 5 comments, absorbs #352, #413/#416 depend
                  on it. Needs decomposition before it's one loom.
  #431            6 comments; the 4th retracts the 2nd and 3rd. Human triage.
  #488, #490      Deliverable is agent prompt/behaviour design. No mechanical
                  acceptance criterion.
  #302, #304      needs-approval.

Order: #491 → #432 → #458 → #445.  4 concurrent max.
⚠ 33 of 37 open issues are NOT dispatchable — and not because they're badly
  written. They need a decision, a credential, or a split. Nothing in your
  labels distinguishes those. Want me to propose a taxonomy?
```

---

## 6. What the dry run caught

Three things, none of which any amount of design discussion would have produced:

1. **The opening instruction was wrong.** "Listen for hito 1" was fluent,
   specific, and would have ignored the week's actual work. Only live data
   catches that.
2. **The gate isn't binary.** Exit 2 has no answer in a pass/fail model, and the
   right answer turned out to be a preference (*"I'd rather wake up to fewer PRs
   than to red CI"*) that could not have been inferred.
3. **The real bottleneck is triage.** 4 of 37 dispatchable, with excellent
   issues — the constraint is classification, not specification. See
   `orchestrator.md` §3.10.

---

## 7. Where the design strained

Honest failures, worth more than the parts that worked.

**"Look first" has a floor.** Determining that #464 needs a human means reading
its body *and* comments, and 37 issues of that is not free. The cheap-sentinel
model (§3.6) assumes waking is cheap because *checking* is cheap — but the first
real classification pass is genuinely expensive. It only amortizes if the
classification is **cached in the ledger and refreshed on `updated_at`**, which
the design gestures at but does not specify.

**Setup wanted to change the repo.** The single highest-value action here is
adding four labels. §4.4 forbids setup from refactoring the repo, correctly —
but the boundary between "propose a taxonomy" and "restructure your backlog" is
thinner than that rule admits, and the doc should say where it sits.

**A PR is not purely terminal.** §3.5 says a loom ends at an open PR. But the
brief says open a *draft* PR early **because CI's pgTAP job is the database test
environment** — the PR is part of the verification loop, not just its result.
A loom that can't run pgTAP locally (exit 2) may need to open a draft PR *to get
verified at all*. The terminal-state model doesn't currently express that.

**One human, high cadence.** ~18 PRs/day, all authored and merged by Facundo, on
an unprotected `main`. This is not a repo with slack in it. An orchestrator
adding four concurrent branches to that stream will hit rebase conflicts against
`main` constantly — and PR #492 is currently rewriting the worktree machinery
itself, so every branch cut today needs a rebase after it lands. `orchestrator.md`
§6.1 flags worktree divergence as open; this repo makes it urgent, not
theoretical.
