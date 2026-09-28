import Foundation

/// WHICH MAC A CONVERSATION COMES FROM — issue #244.
///
/// The phone pairs with more than one Mac and a conversation gave no hint of
/// which one it belonged to. The fact was never missing: the host id already
/// scopes every persistence key, every keychain account and every poll. It was
/// simply never drawn, and it is not something a reader can reconstruct —
/// `ScopedSessionID` exists precisely because two engines can mint the same
/// session id, and nothing stops two Macs holding a checkout of one repository
/// with conversations of the same name in it.
///
/// THE RULE LIVES HERE RATHER THAN IN THE TWO VIEWS because it is one rule
/// asked twice, with one difference, and a rule spelled as an `if` condition
/// inside a `body` is a rule nothing can check. The header strip and the rail's
/// rows both ask this type; neither decides anything itself.
enum HostLabel {
    /// What a Mac with no usable name is called. A host record normally always
    /// carries one — `HostBook.defaultName` falls back to the URL's host at add
    /// time — so this covers the window where a Mac has just been forgotten
    /// while its rows are still on screen.
    static let unknown = "Mac"

    /// The record's name, or the fallback. EMPTY IS ABSENT: `HostBook.rename`
    /// trims to `""` and then restores the URL host, and a badge drawn between
    /// those two writes would be an empty rounded rectangle with nothing in it.
    static func name(_ raw: String?) -> String {
        guard let raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return unknown }
        return raw
    }

    /// THE CONVERSATION'S OWN HEADER STRIP — named whenever this phone knows
    /// more than one Mac.
    ///
    /// Unconditional within that, because the strip is the one surface where the
    /// reader has a conversation and nothing else: no neighbouring row from
    /// another Mac, no group header, no badge list to infer an answer from. A
    /// conversation opened from a notification or a Handoff link never passed
    /// through the rail at all.
    ///
    /// ONE MAC PAIRED SAYS NOTHING, which is why this is not simply always: a
    /// badge that reads identically on every conversation a phone can open is a
    /// word the reader trains themselves to skip, and then it is not there on
    /// the day the second Mac is added — which is the day it starts to matter.
    static func header(name raw: String?, hostCount: Int) -> String? {
        guard hostCount > 1 else { return nil }
        return name(raw)
    }

    /// A ROW IN THE RAIL, which unlike the strip sits in a context that may have
    /// answered this already.
    ///
    /// `placesAbove` is how many Macs the group header directly above the row
    /// names, and `0` for a row with no header over it — a search result, either
    /// shelf, the attention band and the pinned band all mix projects and Macs
    /// freely.
    ///
    /// EXACTLY ONE MAC ABOVE IS AN ANSWER, so the row keeps quiet. This is the
    /// case the slim row exists for: it costs one line and gives its space back,
    /// and stamping the header's own badge onto every row under it is exactly
    /// what turns a project group into a column of badges.
    ///
    /// TWO MACS ABOVE IS A LIST, NOT AN ANSWER. A repository checked out on two
    /// paired Macs is ONE group here (`SidebarModel.groupKey`), and its header
    /// badges every Mac the group lives on — so the reader can see that two are
    /// involved and cannot see which one owns the row they are about to open.
    /// That is #244 exactly, and it does not wait for two sessions to share a
    /// title before it bites: a repeated title is one way to be confused about
    /// which Mac a row is on, not the condition for being confused.
    static func row(name raw: String?, hostCount: Int, placesAbove: Int) -> String? {
        guard hostCount > 1 else { return nil }
        guard placesAbove != 1 else { return nil }
        return name(raw)
    }
}
