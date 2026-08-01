// The "workspace" in-process MCP server — the ONLY path any session has to the
// user's item store (SPEC-organization-workspace CAP-12, FR-OW-12).
//
// ── WHY A TOOL SURFACE AND NOT FILE ACCESS ───────────────────────────────────
// CAP-12 says items "are not the Workspace surface's private data": every
// session anywhere in Telar must be able to read and file them. brownfield.md
// says why files cannot be how — "Codex's sandbox workspace-write boundary is
// purely path-based — working root + --add-dir. A project session's root is its
// own repo, so TELAR_HOME/workspace is outside it... Granting every project
// session an --add-dir onto the workspace store would widen each session's write
// boundary across all projects' items — the opposite of the isolation the rest
// of the system maintains." So this file is not a convenience wrapper over the
// store; it is the store's only door, and the store sits deliberately outside
// every session's cwd.
//
// ── THIS FILE'S CONTRACT IS MOSTLY ITS ABSENCES, AND EACH ONE IS ASSERTED ────
// workspace-mcp.test.ts and invariants.test.ts's INV-11 prove all of these,
// because a comment claiming a negative is worth nothing:
//   - NO ACCEPT PATH. The four names below survive INV-1c's ACCEPT_STEMS check,
//     and the Item schema carries no status/state/done/accepted field to
//     transition. Filing a task is PREPARE, never COMMIT (NFR-OW-2).
//   - NO DELETE TOOL. SPEC.md's non-goals: "No deletion path." No handler here
//     calls rmSync/unlinkSync/rmdirSync, and the store's reconcile is
//     projection-only so an unreadable packet can never drop its own id either.
//   - NO AGENT PROMOTION PATH. NFR-OW-15: "Agents have no promotion path,
//     proposed or otherwise." `promotedFrom` exists on the item and no input
//     shape here can write it.
//   - NO LANE-STRUCTURE CHANGE. NFR-OW-10 reserves splits, renames and retires
//     to the human. list_lanes READS; nothing creates. The store's ensure step
//     seeds one lane, and that it is the STORE and not a TOOL is the whole of
//     what makes it legal.
//   - NO CROSS-PROJECT REACH. See WorkspaceMcpOpts.project below.
//   - NO ENTITY SCHEMA. NFR-X-5 puts persisted schemas in @telar/core. The
//     shapes below are ARGUMENT schemas — what a caller may pass — and are
//     structurally unrelated to `Item`. INV-11 arm 5 asserts `z.object(` never
//     appears in this file, which is also why every shape below is a raw zod
//     shape rather than a wrapped one.
//   - NO PATH-SHAPED INPUT KEY. apps/web/lib/permissions.ts's PATH_KEYS is
//     ["file_path", "notebook_path", "path"], consumed by inputPaths() inside
//     makeGuardrailDecision, which runs for EVERY tool name. An argument called
//     `path` here would have an opaque item id resolved against the session root
//     and matched against protectedPaths — meaningless, and it would deny by
//     accident.
//
// Modelled on apps/web/lib/ultra-mcp.ts, which is the closer of the two
// templates: like Ultra and unlike loom's start_loom, nothing here is a
// human-gated commit, so no tool needs the interactive canUseTool approval card.
// It lives in its OWN FILE and that is not style: invariants.test.ts computes
// tool-name literals PER FILE and applies them to EVERY server declared in it, so
// a second createSdkMcpServer inside an existing *-mcp.ts would give both servers
// that file's whole tool list and make MCP_INVENTORY unsatisfiable.
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  attachmentTally,
  createItem,
  getWorkspaceItem,
  listItems,
  rankOf,
  readLanes,
  readPacketAttachments,
  updateItem,
  type AccountProfile,
  type Item,
  type ItemPatch,
} from "@telar/core";

// Every workspace tool auto-runs. ui-contract.md §5 — "The tool pills are real
// in v1" — so a permission card on every "what are the tasks here?" would be a
// failure of the surface this exists to build, and there is no human-gated
// commit here to exclude the way LOOM_AUTO_TOOLS excludes start_loom and
// answer_blocked.
//
// PINNED AGAINST core's WORKSPACE_AUTO_TOOL_NAMES by
// apps/web/lib/session-profiles.test.ts, the only file in the repo that can
// import both worlds. THE ORDER IS LOAD-BEARING: invariants.test.ts's
// MCP_INVENTORY compares each server's tool list as an ORDERED list, so these
// four, the registration order below, and that inventory all say the same thing
// in the same sequence.
export const WORKSPACE_AUTO_TOOLS = [
  "mcp__workspace__list_items",
  "mcp__workspace__list_lanes",
  "mcp__workspace__create_item",
  "mcp__workspace__update_item",
] as const;

export type WorkspaceMcpOpts = {
  // The project SLUG this session belongs to — route.ts's own `project` request
  // field, the same value it passes to createUltraMcpServer.
  //
  // NEVER READ FROM TOOL INPUT, and this is the single most load-bearing line in
  // the file. If list_items took a `project` key, any project session could
  // enumerate and file into EVERY OTHER PROJECT'S items — which brownfield.md
  // calls "the opposite of the isolation the rest of the system maintains", and
  // is precisely the leak the tool-surface design exists to prevent.
  //
  // OPTIONAL, because `undefined` means UNSCOPED — story 5.3's project-less
  // master session sees every project's items. Story 5.1 never constructs the
  // server that way; the branch exists so 5.3 does not have to edit this file,
  // and a cross-project view is therefore always a property of how the SERVER
  // was built, never of what a caller asked for.
  project?: string;
  // The chat's own resolved account profile — the human this session belongs to.
  // Used only to compose the creation timeline entry's text. Never read from
  // tool input (loom-mcp.ts's start_loom states the same rule for `by`).
  account: AccountProfile;
  // Tool calls always run after the SDK's system:init message, so read this
  // lazily rather than capture it at server-construction time — identical
  // reasoning to loom-mcp.ts's and ultra-mcp.ts's own getSessionId.
  getSessionId: () => string | null;
};

const errResult = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});
const okResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

// What happened to a lane key that names no lane, in the words the MODEL will
// read back to the user. TWO SENTENCES, because the two verbs genuinely behave
// differently and one shared sentence would tell the model the item moved when
// it did not: a create has no home and lands in "unfiled"; an update has one and
// STAYS PUT (the store refuses to evict a filed item over a typo). The shared
// opening clause is factored out so only the consequence differs.
//
// THE NO-LANE-NAMED CASE GETS ITS OWN SENTENCE. `No lane named null exists` is
// what the composed form said whenever no lane was named at all, which is the
// bare-one-liner path and therefore the COMMON case: it reads as a lookup
// failure for a lane called "null" rather than as "you did not say".
const noSuchLane = (laneKey?: string): string =>
  laneKey === undefined ? `No lane was named` : `No lane named ${JSON.stringify(laneKey)} exists`;

const TAIL = ` Lanes are theirs to create — call list_lanes to see which ones exist.`;

// create_item: the item is NEW and has no home, so it has to land somewhere.
const unplacedNote = (laneKey?: string): string =>
  `${noSuchLane(laneKey)}, so this landed in "unfiled" and is marked for the user to place.${TAIL}`;

// update_item: the item ALREADY has a home, and the store deliberately does not
// redirect it into "unfiled" — that would evict a filed item from the user's
// queue over a spelling mistake. The sentences differ because the BEHAVIOURS
// differ, and a shared one would tell the model the item moved when it did not.
const notMovedNote = (laneKey: string): string =>
  `${noSuchLane(laneKey)}, so the item did NOT move — it is still in the lane it was in, and is now marked unplaced so the user is asked where it belongs.${TAIL}`;

const LIST_ITEMS_DESCRIPTION = `List the user's workspace tasks for THIS session's project — the shared item store, not this chat's private notes. Returns each item's id, title, lane, 1-based rank within that lane, and whether it is on the workspace desk. Items with no project are floating and are not in a project-scoped list. If some packets could not be read you get a COUNT of them, so you know the list may be short; the store is fine, a file needs a human. Scope is resolved server-side from the session; there is no argument that can widen it. Call this before answering any question about what the user has to do.`;

const LIST_LANES_DESCRIPTION = `List the user's lanes: key, label, the coarse window the lane's work tends to happen in, and how many items it holds. Lanes are the user's own data, not a fixed set — call this before create_item so you file into a lane that exists. You cannot create, rename, split or retire a lane; that is the user's to do.`;

const CREATE_ITEM_DESCRIPTION = `File a new task into the user's workspace. Give it a title and, ideally, the key of an existing lane (call list_lanes first). Returns the item's id, the lane it landed in, its 1-based rank, its provenance and that it is on the desk. If you name a lane that does not exist — or name none — the item lands in the store's unfiled lane and is marked unplaced so the user is asked where it belongs; NO LANE IS EVER CREATED FOR YOU. The item is filed to this session's project automatically. There is no way to delete an item.`;

const UPDATE_ITEM_DESCRIPTION = `Modify an existing workspace task: retitle it, move it to another existing lane (it goes to the BOTTOM of that lane), take it off the desk (desk:false — this drains it to the queue and never deletes it), mark it unplaced, or attach a foreign issue reference. Naming a lane that does not exist lands the item in the unfiled lane and marks it unplaced, exactly as create_item does; NO LANE IS EVER CREATED FOR YOU, so call list_lanes first. Every other field is out of reach on purpose: the user's original words (raw), the sub-task list, the timeline and the promotion link cannot be changed by a tool.`;

// Exported as the harness-neutral definition — see harness-tools.ts. The scope
// closure below is built here, with the tools, so a second harness cannot get
// the tools without also getting the scoping that makes them safe.
export function workspaceTools(opts: WorkspaceMcpOpts) {
  // The project scope, resolved ONCE from the server's own options. Every
  // handler below reads this and no handler reads anything scope-shaped from
  // its arguments.
  const inScope = (item: Item): boolean =>
    opts.project === undefined ? true : item.project === opts.project;

  // What a tool tells the model about an item. Deliberately NOT the whole `Item`
  // — `raw`, `fixed`, `acceptance` and `timeline` are the ripening history a
  // packet view renders, not context every list call should spend tokens on.
  const summarise = (item: Item, lanes: ReturnType<typeof readLanes>) => {
    const tally = attachmentTally(readPacketAttachments(item.id));
    return {
      id: item.id,
      title: item.title,
      // THE AUTHORITATIVE LANE, READ OFF lanes.yaml — NOT `item.lane`.
      // packet.yaml's `lane` is a RECOVERY HINT, consulted only when the id is
      // in no stack at all, and after a human moves an id between stacks in the
      // file that hint is deliberately STALE (the store does not rewrite the
      // packet, which is what keeps a reorder to one small file). Reporting the
      // hint here would tell a session the OLD lane after every hand-edit —
      // exactly contradicting AD-6, whose whole claim is that the hand-edit
      // wins. Caught by the dev-server proof, not by a unit test, which is why
      // that proof exercises a real cross-lane move.
      //
      // Falls back to the hint, then to null, so an item that is in no stack
      // still says something useful about where it thinks it belongs.
      lane: lanes.find((l) => l.items.includes(item.id))?.key ?? item.lane ?? null,
      // null when the item is in no lane stack — unfiled, which is a resting
      // state and not an error.
      rank: rankOf(lanes, item.id),
      ...(item.project ? { project: item.project } : {}),
      ...(item.desk ? { desk: true } : {}),
      ...(item.unplaced ? { unplaced: true } : {}),
      ...(item.mirrored ? { mirrored: item.mirrored } : {}),
      ...(item.deadline ? { deadline: item.deadline } : {}),
      ...(item.verdict ? { verdict: item.verdict } : {}),
      ...(item.subtasks?.length ? { subtasks: item.subtasks.length } : {}),
      ...(tally.files || tally.mockups ? { packet: tally } : {}),
    };
  };

  return [
      tool(
        "list_items",
        LIST_ITEMS_DESCRIPTION,
        // NO ARGUMENTS AT ALL. There is nothing a caller could usefully narrow
        // that the server does not already know, and an empty shape is the
        // strongest possible form of "no identity and no scope on any input".
        {},
        async () => {
          const lanes = readLanes();
          const { items, unreadable } = listItems();
          const scoped = items.filter(inScope);
          return okResult(
            JSON.stringify(
              {
                // Rendered so the model can SAY what it is looking at. This is
                // the resolved scope, never an argument that produced it.
                scope: opts.project ?? "all projects",
                items: scoped.map((i) => summarise(i, lanes)),
                // One unreadable packet never blanks the other ninety-nine, and
                // a human is told rather than silently shown a short list.
                //
                // A COUNT WHEN THIS SERVER IS PROJECT-SCOPED, THE LIST ONLY WHEN
                // IT IS NOT. An unreadable packet has no readable `project`
                // field BY CONSTRUCTION — that is what unreadable means — so
                // there is nothing to filter it by, and passing the array
                // through handed a project session other projects' item ids and
                // lane keys in the reason text. That is the same leak
                // `update_item`'s anti-oracle ordering exists to prevent, one
                // channel over. The count still tells the model the truthful
                // thing ("some items could not be read, so this list may be
                // short"); the diagnosis itself belongs to 5.3's project-less
                // master, which is the unscoped case below.
                ...(unreadable.length
                  ? opts.project === undefined
                    ? { unreadable }
                    : { unreadable: unreadable.length }
                  : {}),
              },
              null,
              2,
            ),
          );
        },
      ),
      tool(
        "list_lanes",
        LIST_LANES_DESCRIPTION,
        {},
        async () => {
          const lanes = readLanes();
          return okResult(
            JSON.stringify(
              lanes.map((l) => ({
                key: l.key,
                label: l.label,
                window: l.window,
                ...(l.note ? { note: l.note } : {}),
                items: l.items.length,
              })),
              null,
              2,
            ),
          );
        },
      ),
      tool(
        "create_item",
        CREATE_ITEM_DESCRIPTION,
        // `laneKey`, never `lane` — and never `path`, `file_path` or
        // `notebook_path`, which permissions.ts's inputPaths would resolve
        // against the session root for every tool call.
        { title: z.string().min(1), laneKey: z.string().optional() },
        async ({ title, laneKey }) => {
          // READ THE SESSION ID, NEVER BLOCK ON IT. watch_loom returns an
          // actionable error when it has no session, because a watch without one
          // is an orphan. An ITEM without one is just an item — refusing to
          // capture the user's task because the chat is not yet persisted is the
          // worse failure by a wide margin.
          const sessionId = opts.getSessionId();
          let item: Item;
          try {
            item = createItem({
              title,
              lane: laneKey,
              // SERVER-SUPPLIED. The one place the session's project reaches the
              // store, and it cannot come from anywhere else.
              ...(opts.project ? { project: opts.project } : {}),
              // The session's identity rides the creation timeline entry's TEXT
              // — §5.5-D7 adds no sessionId field to the item, because
              // item-model.md's Item table is the shape contract. The store owns
              // the entry's `at` and `actor`, so this cannot forge either.
              creationNote: `captured by ${opts.account.name} in this session${sessionId ? ` (${sessionId})` : ""}`,
            });
          } catch (e) {
            // A write that can fail returns an actionable sentence; a read that
            // legitimately finds nothing returns an empty result. Per-call
            // judgement, which is what the existing servers do.
            return errResult(
              `Could not file "${title}": ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          return okResult(
            JSON.stringify(
              {
                id: item.id,
                lane: item.lane,
                rank: rankOf(readLanes(), item.id),
                provenance: item.provenance,
                desk: item.desk === true,
                ...(item.unplaced ? { unplaced: true, note: unplacedNote(laneKey) } : {}),
              },
              null,
              2,
            ),
          );
        },
      ),
      tool(
        "update_item",
        UPDATE_ITEM_DESCRIPTION,
        // EXACTLY ItemPatch's fields, minus `project` (a scope, and scope is
        // never a tool input) and minus `deadline`/`verdict` (story 5.4's to
        // write), with `lane` spelled `laneKey` for the same reason as above.
        // No `by`, no `account`, no `sessionId`, no `provenance`, no `raw`.
        {
          itemId: z.string().min(1),
          title: z.string().min(1).optional(),
          laneKey: z.string().optional(),
          desk: z.boolean().optional(),
          unplaced: z.boolean().optional(),
          mirrored: z.string().optional(),
        },
        async ({ itemId, title, laneKey, desk, unplaced, mirrored }) => {
          const patch: ItemPatch = {
            ...(title !== undefined ? { title } : {}),
            ...(laneKey !== undefined ? { lane: laneKey } : {}),
            ...(desk !== undefined ? { desk } : {}),
            ...(unplaced !== undefined ? { unplaced } : {}),
            ...(mirrored !== undefined ? { mirrored } : {}),
          };
          if (Object.keys(patch).length === 0) {
            return errResult(
              `Nothing to change on "${itemId}" — pass at least one of title, laneKey, desk, unplaced or mirrored.`,
            );
          }
          // SCOPE IS CHECKED BEFORE THE WRITE, NOT AFTER, and the order is the
          // whole guarantee. An item id is opaque, so a session that guessed or
          // was told one belonging to ANOTHER project must not be able to modify
          // it — and checking afterwards would mean the write had already
          // happened and only the confirmation was withheld. The answer for an
          // out-of-scope id is byte-identical to the answer for a nonexistent
          // one, so the surface does not become an oracle for whether some other
          // project holds a given id.
          const existing = getWorkspaceItem(itemId);
          if (!existing || !inScope(existing)) {
            return errResult(`No workspace item found with id "${itemId}".`);
          }
          let updated: Item | null;
          try {
            updated = updateItem(itemId, patch);
          } catch (e) {
            return errResult(
              `Could not update "${itemId}": ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          if (!updated) return errResult(`No workspace item found with id "${itemId}".`);
          // READ THE LANES AFTER THE WRITE, because a lane change is a TWO-FILE
          // move: the store rewrote lanes.yaml, so a stale read here would
          // report the rank the item held before its own move.
          const lanes = readLanes();
          // THE INVERSE OF create_item's GUARD, which this surface was missing:
          // a laneKey naming no existing lane returned isError:false and said
          // nothing, so a model was told a move succeeded that had instead
          // resolved to "unfiled". No lane is ever created for either verb.
          const unknownLane = laneKey !== undefined && !lanes.some((l) => l.key === laneKey);
          // Narrowed for the note below: `laneKey` is a string on this branch.
          return okResult(
            JSON.stringify(
              {
                ...summarise(updated, lanes),
                ...(unknownLane ? { note: notMovedNote(laneKey) } : {}),
              },
              null,
              2,
            ),
          );
        },
      ),
  ];
}

export const WORKSPACE_MCP_VERSION = "1.0.0";

export function createWorkspaceMcpServer(opts: WorkspaceMcpOpts): McpServerConfig {
  return createSdkMcpServer({
    // A BARE QUOTED LITERAL IN FIRST POSITION, deliberately: invariants.test.ts's
    // mcpServerNameLiterals matches only `<factory>({ name: "<literal>"`, while
    // callsMcpFactory is satisfied by the call alone. A shorthand `{ name, … }`
    // would put this file in MCP_SURFACES while contributing NO server, and
    // INV-1a/INV-1b would then fail with a message that does not name the cause.
    name: "workspace",
    version: "1.0.0",
    tools: workspaceTools(opts),
  });
}
