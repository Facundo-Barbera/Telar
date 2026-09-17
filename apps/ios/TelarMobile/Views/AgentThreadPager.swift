import Foundation
import Observation

/// WHERE THE AGENT'S TRANSCRIPT IS UP TO, AND HOW IT GETS THERE — issue #580.
///
/// ── THE BUG THIS REPLACES ───────────────────────────────────────────────────
/// `AgentView` opened with `cursor = 0` and walked FORWARD, up to twenty pages
/// of fifty rows, before it drew anything. On the owner's thread — 584 rows,
/// 782 KB of `detail` — that was a dozen sequential requests over the host
/// proxy and most of a megabyte before the first line appeared. The Mac reads
/// backward now, so the open is ONE request for the last page, and the rest of
/// the conversation is fetched by pulling down.
///
/// ── THREE READS, ONE LIST ───────────────────────────────────────────────────
/// The open, the pull and the poll all hand back rows, and they disagree about
/// which cursors they move: the open takes the thread's TIP, the pull moves
/// only the floor, and the poll moves only the tip. Keeping that in three
/// places inside a View is how a pull ends up dragging the poll back into the
/// middle of the conversation — so it is one type, with a method per read.
///
/// LIFTED OUT OF THE VIEW so the claims are a test's to hold rather than a
/// screenshot's — `AgentTranscriptScroll`'s own reason, and `AgentPagingTests`
/// is where they are held.
///
/// MERGED BY ID THROUGHOUT (`mergeAgentRows`), which is what makes all three
/// idempotent: a re-open, a replayed poll and a pull that overlaps what is
/// already held cost nothing but the request.
@MainActor @Observable final class AgentThreadPager {
    /// The conversation, ascending by id.
    private(set) var rows: [AgentRow] = []
    /// The newest row this phone knows about — the next `after`.
    private(set) var cursor = 0
    /// The top of what is held, and the next `before`. `nil` means there is
    /// nothing further back to ask for.
    private(set) var oldest: Int?
    /// Whether the Mac said older rows are waiting. Kept apart from `oldest`
    /// because a window can hand back its own floor and still be the last one.
    private(set) var hasOlder = false

    /// THE OPEN — the last page, and nothing above it.
    ///
    /// `cursor` TAKES THE THREAD'S TIP, which is what the Mac answers for a
    /// window and is NOT the top of the page just read. Taking the window's own
    /// top would send the next poll into the middle of the conversation and
    /// replay everything after it.
    ///
    /// `max` RATHER THAN ASSIGNMENT, because a re-open runs against rows this
    /// screen already holds, and a tip that went BACKWARDS would re-fetch them.
    ///
    /// A MAC THAT DID NOT ANSWER KEEPS WHAT IS ON SCREEN, like every other read
    /// on this screen: the next poll is three seconds away.
    func open(_ api: any EngineAPI, limit: Int) async {
        guard let page = try? await api.agentThreadTail(limit: limit) else { return }
        rows = mergeAgentRows(rows, page.rows)
        cursor = max(cursor, page.cursor)
        oldest = page.oldest
        hasOlder = page.more
    }

    /// ONE PAGE FURTHER BACK — what pulling down at the top asks for.
    ///
    /// THE TIP IS LEFT ALONE. Reading history must not move where the poll
    /// resumes; every row arriving here is older than everything held.
    ///
    /// A WINDOW THAT CAME BACK EMPTY IS THE TOP, whatever it said about `more`
    /// — leaving `oldest` where it was would let the same empty read be made on
    /// every pull, for ever.
    func older(_ api: any EngineAPI, limit: Int) async {
        guard let before = oldest else { return }
        guard let page = try? await api.agentThread(before: before, limit: limit) else { return }
        rows = mergeAgentRows(rows, page.rows)
        oldest = page.oldest
        hasOlder = page.oldest != nil && page.more
    }

    /// THE POLL, unchanged from what it always was: forward from the tip, a few
    /// pages at a time so a phone that was asleep catches up without pulling a
    /// night's work down in one go.
    ///
    /// `oldest` IS LEFT ALONE for the mirror of `older`'s reason: a row landing
    /// at the end of the conversation says nothing about where its beginning
    /// is, and moving the backward cursor to meet it would skip everything in
    /// between.
    func poll(_ api: any EngineAPI, maxPages: Int) async {
        var after = cursor
        for _ in 0..<maxPages {
            guard let page = try? await api.agentThread(after: after) else { return }
            rows = mergeAgentRows(rows, page.rows)
            after = page.cursor
            cursor = max(cursor, page.cursor)
            if !page.more { return }
        }
    }
}
