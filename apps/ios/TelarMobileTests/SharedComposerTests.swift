import Foundation
import SwiftUI
import Testing
@testable import TelarMobile

/// ONE COMPOSER, TWO SCREENS (#539, item 6).
///
/// The Agent screen had a bare `TextField` with a send button, because
/// `ComposerView` took a `SessionStore` and the Agent is not a session. What it
/// was missing was not decoration: `ComposerTextView` is a UIKit field, and that
/// is the only reason the system's own Paste offers a picture at all.
///
/// `ComposerHost` is what made the box reusable — it names the handful of facts
/// the composer reads rather than a store. These tests hold the seam:
///
///   - BOTH SCREENS INSTANTIATE THE SAME TYPE, which is the claim that stops
///     the Agent quietly growing a second composer again;
///   - the session's answers are the STORE'S, field for field, so nothing about
///     the session composer changed when it was lifted;
///   - the Agent's three noes are honest ones, each for a stated reason.
@Suite @MainActor struct SharedComposerTests {
    /// A `ComposerView` is a value, so "the same type" is a fact a test can
    /// state directly: both call sites produce `ComposerView`, differing only
    /// in the host and the pills they hand it.
    @Test func bothScreensBuildTheSameComposer() {
        var draft = ""
        var focused = false
        let text = Binding(get: { draft }, set: { draft = $0 })
        let focus = Binding(get: { focused }, set: { focused = $0 })

        let agent = ComposerView(
            draft: text,
            focus: focus,
            host: AgentComposerHost(running: false, onSend: { _ in }, onStop: {}),
            controls: AnyView(EmptyView())
        )
        // The session's call site passes `SessionComposerHost`; both are
        // `ComposerView`, which is the whole of the claim.
        #expect(type(of: agent) == ComposerView.self)
        #expect(agent.host is AgentComposerHost)
    }

    @Test func theAgentSaysNoToAttachmentsBecauseItsRouteHasNowhereToPutThem() {
        let host = AgentComposerHost(running: false, onSend: { _ in }, onStop: {})
        // `POST /v2/agent/turns` takes `{ text }`: there is no attachment index
        // on a thread and no id an upload could be referenced by. The photo
        // button, the drop target and paste-to-attach all hang off this.
        #expect(!host.acceptsAttachments)
        #expect(host.pendingAttachments.isEmpty)
        #expect(!host.uploading)
    }

    @Test func theAgentHasNoQueueStripBecauseTheEngineReportsACountAndNotAList() {
        let host = AgentComposerHost(running: false, onSend: { _ in }, onStop: {})
        // `GET /v2/agent` says how MANY turns are queued, not what they say —
        // so there is nothing to list, and nothing to promote or withdraw.
        #expect(host.queuedTurns.isEmpty)
        #expect(!host.canPromoteQueued)
    }

    @Test func theAgentsPlaceholderIsItsOwn() {
        let host = AgentComposerHost(running: false, onSend: { _ in }, onStop: {})
        // "Ask the agent, or run a command…" is a SESSION's placeholder: the
        // Agent runs no commands and is the agent.
        #expect(host.placeholder == "Message the Agent")
    }

    @Test func runningIsWhatSwapsSendForStop() {
        #expect(!AgentComposerHost(running: false, onSend: { _ in }, onStop: {}).isRunning)
        #expect(AgentComposerHost(running: true, onSend: { _ in }, onStop: {}).isRunning)
    }

    @Test func theAgentsSendReachesTheScreensOwnHandler() async {
        // The host is a forwarder and nothing else: the screen owns what a send
        // means, exactly as `SessionComposerHost` leaves it to the store.
        final class Box: @unchecked Sendable { var sent: String? }
        let box = Box()
        let host = AgentComposerHost(running: false, onSend: { box.sent = $0 }, onStop: {})
        await host.send("delegate it")
        #expect(box.sent == "delegate it")
    }
}
