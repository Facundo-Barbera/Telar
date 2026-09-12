import Foundation
import SwiftUI
import Testing
import UIKit
@testable import TelarMobile

/// #289: with the keyboard up and a wrapped draft, the composer's LAST LINE
/// renders below the focused card's bottom edge, between the card and the
/// toolbar row. This hosts the REAL `ComposerView` at a phone's width and
/// measures the field against the box the card is drawn for, so the answer is
/// a number rather than a screenshot.
@MainActor @Suite struct ComposerGrowthTests {

    /// What the field and its card measure, in the host's coordinates.
    struct Geometry {
        /// The text view's own frame — everything it draws is clipped to this.
        var field: CGRect
        /// The height the text actually needs at that width.
        var content: CGFloat
        /// The whole composer: card, toolbar row, queue line.
        var composer: CGFloat
        var lineHeight: CGFloat
        /// Card and toolbar chrome around the field. CONSTANT if the card is
        /// sized for the field; it shrinks by exactly the overflow if not.
        var chrome: CGFloat { composer - field.height }
        var lines: Int { lineHeight > 0 ? Int((content / lineHeight).rounded()) : 0 }
        var text: String {
            String(format: "field %.1f (needs %.1f, %d lines) composer %.1f chrome %.1f",
                   field.height, content, lines, composer, chrome)
        }
    }

    /// The content height an iPhone has left with the keyboard up: the screen
    /// less the keyboard and the navigation chrome.
    static let keyboardUpHeight: CGFloat = 400

    /// THE CASE THE REPORT DESCRIBES. With the keyboard up the session's VStack
    /// has to fit a transcript AND the composer into what is left, so the
    /// composer is offered less height than a grown draft wants. What it does
    /// with that offer is the bug.
    @Test func aSqueezedFooterStillDrawsItsTextInsideTheCard() async throws {
        let bench = try await Bench(height: Self.keyboardUpHeight, withTranscript: true)
        defer { bench.tearDown() }

        bench.type(Self.twoParagraphs)
        await bench.settle()
        let squeezed = bench.measure()
        print("[#289] squeezed — \(squeezed.text)")

        // THE CARD IS STILL DRAWN AROUND THE WHOLE FIELD. Squeezed, the box
        // takes what it was offered and scrolls the rest inside itself; what
        // it must never do is keep the height it wanted, because the card is
        // drawn for the height it was granted and the difference lands on the
        // page as the draft's last line.
        #expect(squeezed.chrome >= 93.5, "the card is drawn around all of the field — \(squeezed.text)")
        #expect(squeezed.content > squeezed.field.height,
                "and the draft it cannot fit scrolls inside it — \(squeezed.text)")
    }

    @Test func theCardGrowsWithTheDraftInsteadOfLettingItDrawBelow() async throws {
        let bench = try await Bench()
        defer { bench.tearDown() }

        bench.type("one line")
        await bench.settle()
        let short = bench.measure()
        print("[#289] one line — \(short.text)")

        // TYPED INTO, the way a draft actually grows: the characters land in
        // the text view and the delegate writes the binding. This is the step
        // the hypothesis says SwiftUI never re-measures.
        bench.type(Self.twoParagraphs)
        await bench.settle()
        let grown = bench.measure()
        print("[#289] wrapped — \(grown.text)")

        #expect(grown.lines >= 5, "the sample draft wraps to five or more lines at 393pt — \(grown.text)")
        // THE BUG, AS A NUMBER. The text view clips to its own frame, so text
        // that appears below the card means the frame outgrew what the card
        // was drawn for: the chrome around the field is that margin.
        #expect(grown.field.height >= grown.content - 0.5,
                "the field's frame holds all of its text — \(grown.text)")
        #expect(grown.chrome >= 93.5,
                "and the card is drawn around all of it — one line: \(short.text) / wrapped: \(grown.text)")
    }

    @Test func pastTheCapTheFieldScrollsInsideTheCardInsteadOfGrowing() async throws {
        let bench = try await Bench()
        defer { bench.tearDown() }

        bench.type((1...20).map { "line \($0) of a draft that keeps going" }.joined(separator: "\n"))
        await bench.settle()
        let capped = bench.measure()
        print("[#289] capped — \(capped.text)")

        #expect(capped.field.height <= capped.lineHeight * 7 + 0.5, "seven lines is the cap — \(capped.text)")
        #expect(capped.content > capped.field.height, "and the rest scrolls inside it — \(capped.text)")
    }

    // MARK: the bench

    /// The composer on a phone-sized window, bottom-pinned the way the session
    /// puts it, with the field found once and the geometry readable after.
    @MainActor final class Bench {
        let model = DraftModel()
        let window: UIWindow
        let host: UIHostingController<Harness>
        let field: ComposerUITextView

        init(height: CGFloat = 852, withTranscript: Bool = false) async throws {
            let store = SessionStore(api: SilentAPI(), sessionId: "s")
            host = UIHostingController(rootView: Harness(model: model, store: store, withTranscript: withTranscript))
            window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: height))
            window.rootViewController = host
            window.makeKeyAndVisible()
            for _ in 0..<3 {
                try? await Task.sleep(for: .milliseconds(60))
                host.view.setNeedsLayout(); host.view.layoutIfNeeded()
            }
            field = try #require(Bench.find(in: host.view), "the composer's UITextView is hosted")
        }

        func tearDown() { window.isHidden = true; window.rootViewController = nil }

        func type(_ text: String) {
            field.text = text
            field.delegate?.textViewDidChange?(field)
        }

        /// SwiftUI needs a turn of the run loop to see the change, and the
        /// layout pass has to run before anything is worth reading.
        func settle() async {
            for _ in 0..<4 {
                try? await Task.sleep(for: .milliseconds(60))
                host.view.setNeedsLayout(); host.view.layoutIfNeeded()
            }
        }

        func measure() -> Geometry {
            Geometry(
                field: field.convert(field.bounds, to: host.view),
                content: field.sizeThatFits(CGSize(width: field.bounds.width, height: .greatestFiniteMagnitude)).height,
                composer: model.composerHeight,
                lineHeight: field.font?.lineHeight ?? 0
            )
        }

        private static func find(in view: UIView) -> ComposerUITextView? {
            if let field = view as? ComposerUITextView { return field }
            for child in view.subviews {
                if let found = find(in: child) { return found }
            }
            return nil
        }
    }

    @Observable @MainActor final class DraftModel {
        var draft = ""
        var focused = true
        /// The composer's own height, reported by the layout rather than
        /// guessed from the padding constants.
        var composerHeight: CGFloat = 0
    }

    /// SessionView's own shape: a greedy transcript above, the composer as the
    /// footer under it. `withTranscript` is what makes the VStack have to
    /// choose, which is the keyboard-up case.
    struct Harness: View {
        @Bindable var model: DraftModel
        let store: SessionStore
        var withTranscript = false
        var body: some View {
            VStack(spacing: 0) {
                if withTranscript {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(0..<40, id: \.self) { i in
                                Text("transcript line \(i)").frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                } else {
                    Spacer(minLength: 0)
                }
                ComposerView(draft: $model.draft, focus: $model.focused, store: store, onSend: {})
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { model.composerHeight = $0 }
                    .padding(.horizontal, 16)
            }
            .background(Theme.canvas)
        }
    }

    private static let twoParagraphs = """
        The composer keeps the draft while the keyboard is up, and a long \
        message wraps across several lines before it reaches the cap.

        A second paragraph pushes it further still, which is the shape the \
        report describes.
        """
}

/// Never reached: this suite lays the composer out and never sends anything.
private struct SilentAPI: EngineAPI {
    func health() async throws -> EngineHealth { fatalError("unused") }
    func liveSessions() async throws -> LiveSessions { fatalError("unused") }
    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot { fatalError("unused") }
    func events(_ id: EngineID, after: Int) async throws -> EventPage { fatalError("unused") }
    func sessionData(_ id: EngineID) async throws -> Data { fatalError("unused") }
    func liveSessionsData() async throws -> Data { fatalError("unused") }
    func projectIcon(_ projectId: EngineID, icon: String) async throws -> Data { fatalError("unused") }
    func submitTurn(_ id: EngineID, runId: String, input: String, attachments: [EngineID]?) async throws -> TurnSubmissionResult { fatalError("unused") }
    func stopSession(_ id: EngineID) async throws {}
    func stopTurn(_ id: EngineID, runId: String) async throws {}
    func resolveRequest(_ id: EngineID, requestId: EngineID, decision: RequestDecision, reason: String?, answers: [String: AnswerValue]?) async throws {}
    func patchSession(_ id: EngineID, patch: SessionPatch) async throws {}
    func markSessionRead(_ id: EngineID, runId: String) async throws -> Session { fatalError("unused") }
    func promoteTurn(_ id: EngineID, runId: String) async throws {}
    func createSession(projectId: EngineID, input: NewSessionInput) async throws -> Session { fatalError("unused") }
    func inboxPolicy() async throws -> InboxPolicy { InboxPolicy(autoSettleAfterHours: 72) }
    func uploadAttachment(_ id: EngineID, name: String, mediaType: String, data: Data) async throws -> TurnAttachment { fatalError("unused") }
    func models(driver: String) async throws -> ModelCatalogue { fatalError("unused") }
    func providerInstances() async throws -> [ProviderInstance] { [] }
    func sessionDiff(_ id: EngineID) async throws -> SessionDiff { fatalError("unused") }
    func filePatch(_ id: EngineID, path: String, untracked: Bool) async throws -> FilePatch { fatalError("unused") }
    func listDirectories(path: String?) async throws -> DirectoryListing { fatalError("unused") }
    func registerProject(name: String, root: String) async throws -> ProjectRef { fatalError("unused") }
    func projectGit(_ projectId: EngineID) async throws -> GitOverview { fatalError("unused") }
    func remoteStatus() async throws -> RemoteStatus { fatalError("unused") }
    func renameDevice(_ id: String, name: String) async throws -> RemoteDevice { fatalError("unused") }
    func setDeviceRole(_ id: String, role: String) async throws -> RemoteDevice { fatalError("unused") }
    func revokeDevice(_ id: String) async throws {}
    func revokeOtherDevices() async throws -> Int { 0 }
}
