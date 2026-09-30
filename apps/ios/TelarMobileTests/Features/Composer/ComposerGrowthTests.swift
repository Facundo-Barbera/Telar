import Foundation
import SwiftUI
import Testing
import UIKit
@testable import TelarMobile

@MainActor @Suite struct ComposerGrowthTests {
    struct Geometry {
        var field: CGRect
        var content: CGFloat
        var composer: CGFloat
        var lineHeight: CGFloat
        var chrome: CGFloat { composer - field.height }
        var lines: Int { lineHeight > 0 ? Int((content / lineHeight).rounded()) : 0 }
        var text: String {
            String(format: "field %.1f (needs %.1f, %d lines) composer %.1f chrome %.1f",
                   field.height, content, lines, composer, chrome)
        }
    }

    static let keyboardUpHeight: CGFloat = 400

    static let pillChrome: CGFloat = 21.5

    @Test func aSqueezedFooterStillDrawsItsTextInsideThePill() async throws {
        let bench = try await Bench(height: Self.keyboardUpHeight, withTranscript: true)
        defer { bench.tearDown() }

        bench.type(Self.twoParagraphs)
        await bench.settle()
        let squeezed = bench.measure()

        #expect(squeezed.chrome >= Self.pillChrome, "the pill is drawn around all of the field — \(squeezed.text)")
        #expect(squeezed.content > squeezed.field.height,
                "and the draft it cannot fit scrolls inside it — \(squeezed.text)")
    }

    @Test func thePillGrowsWithTheDraftInsteadOfLettingItDrawBelow() async throws {
        let bench = try await Bench()
        defer { bench.tearDown() }

        bench.type("one line")
        await bench.settle()
        let short = bench.measure()

        bench.type("one\ntwo\nthree")
        await bench.settle()
        let grown = bench.measure()

        #expect(grown.lines == 3, "the draft takes three lines — \(grown.text)")
        #expect(grown.field.height >= grown.content - 0.5, "the field's frame holds all of its text — \(grown.text)")
        #expect(grown.composer > short.composer, "the pill grows — one line: \(short.text) / three: \(grown.text)")
        #expect(abs(grown.field.maxY - short.field.maxY) < 0.5, "upward, its bottom edge staying where it was")
        #expect(grown.field.minY < short.field.minY - 1, "so the top edge is what moves")
        #expect(grown.chrome >= Self.pillChrome, "and is drawn around all of it — \(grown.text)")
    }

    @Test func theTranscriptStaysPutBehindAGrowingPill() async throws {
        let bench = try await Bench(withTranscript: true)
        defer { bench.tearDown() }

        bench.type("one line")
        await bench.settle()
        let before = bench.model.lastLine
        let composerTop = bench.host.view.bounds.height - bench.model.footerHeight
        #expect(before.maxY <= composerTop + 0.5, "the last line scrolls clear of the composer — line \(before), composer top \(composerTop)")

        bench.type("one\ntwo\nthree\nfour")
        await bench.settle()
        let after = bench.model.lastLine

        #expect(bench.model.footerHeight > 0 && after.minY == before.minY,
                "growing the pill leaves the transcript where it was — before \(before), after \(after)")
    }

    @Test func pastSixLinesTheFieldScrollsInsideThePillInsteadOfGrowing() async throws {
        let bench = try await Bench()
        defer { bench.tearDown() }

        bench.type((1...20).map { "line \($0)" }.joined(separator: "\n"))
        await bench.settle()
        let capped = bench.measure()

        #expect(capped.field.height <= capped.lineHeight * 6 + 0.5, "six lines is the cap — \(capped.text)")
        #expect(capped.content > capped.field.height, "and the rest scrolls inside it — \(capped.text)")
    }

    @Test func focusingKeepsTheComposersShape() async throws {
        let bench = try await Bench(focused: false)
        defer { bench.tearDown() }

        bench.type("one\ntwo")
        await bench.settle()
        let resting = bench.measure()

        bench.model.focused = true
        await bench.settle()
        let focused = bench.measure()

        #expect(abs(focused.composer - resting.composer) < 0.5,
                "focusing only raises the keyboard — resting: \(resting.text) / focused: \(focused.text)")
        #expect(abs(focused.field.minX - resting.field.minX) < 0.5, "and the field stays where it was")
    }

    @MainActor final class Bench {
        let model = DraftModel()
        let window: UIWindow
        let host: UIHostingController<Harness>
        let field: ComposerUITextView

        init(height: CGFloat = 852, withTranscript: Bool = false, focused: Bool = true) async throws {
            model.focused = focused
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
        var composerHeight: CGFloat = 0
        var footerHeight: CGFloat = 0
        var lastLine: CGRect = .zero
        var position = ScrollPosition(edge: .bottom)
    }

    struct Harness: View {
        @Bindable var model: DraftModel
        let store: SessionStore
        var withTranscript = false
        var body: some View {
            Group {
                if withTranscript {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(0..<40, id: \.self) { i in
                                Text("transcript line \(i)").frame(maxWidth: .infinity, alignment: .leading)
                                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                                        if i == 39 { model.lastLine = $0 }
                                    }
                            }
                        }
                    }
                    .scrollPosition($model.position)
                    .floatingComposer(height: $model.footerHeight, onFirstLayout: {
                        DispatchQueue.main.async { model.position.scrollTo(edge: .bottom) }
                    }) { composer }
                } else {
                    VStack(spacing: 0) {
                        Spacer(minLength: 0)
                        composer
                    }
                }
            }
            .background(Theme.canvas)
        }

        private var composer: some View {
            ComposerView(draft: $model.draft, focus: $model.focused, host: SessionComposerHost(store: store), onSend: {})
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { model.composerHeight = $0 }
                .padding(.horizontal, 16)
        }
    }

    private static let twoParagraphs = """
        The composer keeps the draft while the keyboard is up, and a long \
        message wraps across several lines before it reaches the cap.

        A second paragraph pushes it further still, which is the shape the \
        report describes.
        """
}

private struct SilentAPI: EngineAPI {
    func health() async throws -> EngineHealth { fatalError("unused") }
    func liveSessions() async throws -> LiveSessions { fatalError("unused") }
    func session(_ id: EngineID, window: SnapshotWindow?) async throws -> SessionSnapshot { fatalError("unused") }
    func events(_ id: EngineID, after: Int) async throws -> EventPage { fatalError("unused") }
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
