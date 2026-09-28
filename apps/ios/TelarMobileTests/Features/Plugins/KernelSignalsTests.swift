import Foundation
import Testing
@testable import TelarMobile

/// The two events that make the panel re-read while a kernel is working.
///
/// WHAT THIS IS FOR: every panel surface used to key its read on a TURN
/// settling, so cells the agent ran mid-turn changed nothing on screen until
/// the whole turn finished — "tables don't render until you refresh the
/// kernel". The engine was already saying so; the phone dropped both events on
/// the floor.
@Suite struct KernelSignalsTests {
    private func event(_ json: String) -> EngineEvent {
        try! JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8))
    }

    // MARK: decoding

    @Test func aKernelStateChangeDecodesWithItsReason() {
        let decoded = event(#"{"id":5,"at":1,"sessionId":"s","type":"kernel.state.changed","state":"busy","reason":"cell"}"#)
        if case .kernelStateChanged(let state, let reason) = decoded.payload {
            #expect(state == .busy)
            #expect(reason == "cell")
        } else {
            Issue.record("expected kernelStateChanged, got \(decoded.payload)")
        }
    }

    @Test func anUnknownKernelStateStillMovesTheRevision() {
        // A newer engine's vocabulary must not be silently dropped: the state
        // decodes to `.unknown` and the surface still re-reads.
        let decoded = event(#"{"id":5,"at":1,"sessionId":"s","type":"kernel.state.changed","state":"hibernating"}"#)
        if case .kernelStateChanged(let state, let reason) = decoded.payload {
            #expect(state == .unknown)
            #expect(reason == nil)
        } else {
            Issue.record("expected kernelStateChanged")
        }
    }

    @Test func aCellOutputDecodesItsProducerAndBody() {
        let decoded = event(#"""
        {"id":6,"at":1,"sessionId":"s","type":"notebook.cell.output","execId":"e1","cellId":"c2",
         "producer":"analysis/etl.ipynb","output":{"kind":"text","stream":"stdout","text":"hi"}}
        """#)
        if case .notebookCellOutput(let execId, let cellId, let producer, let output) = decoded.payload {
            #expect(execId == "e1")
            #expect(cellId == "c2")
            #expect(producer == "analysis/etl.ipynb")
            #expect(output != nil)
        } else {
            Issue.record("expected notebookCellOutput, got \(decoded.payload)")
        }
    }

    @Test func anOutputBodyThisBuildCannotReadIsStillAnExecution() {
        // The revision it bumps is what makes the surface re-read; refusing
        // the whole event over an unreadable body would lose that.
        let decoded = event(#"{"id":6,"at":1,"sessionId":"s","type":"notebook.cell.output","execId":"e1","output":42}"#)
        if case .notebookCellOutput(let execId, _, let producer, let output) = decoded.payload {
            #expect(execId == "e1")
            #expect(producer == nil)
            #expect(output == nil)
        } else {
            Issue.record("expected notebookCellOutput")
        }
    }

    // MARK: the fold

    private var stateChange: EngineEvent {
        event(#"{"id":10,"at":1,"sessionId":"s","type":"kernel.state.changed","state":"idle"}"#)
    }

    private func output(_ id: Int, producer: String? = "nb.ipynb", kind: String = "text") -> EngineEvent {
        let body = kind == "image"
            ? #"{"kind":"image","mediaType":"image/png","attachmentId":"a1"}"#
            : #"{"kind":"text","stream":"stdout","text":"x"}"#
        let producerField = producer.map { ",\"producer\":\"\($0)\"" } ?? ""
        return event(#"{"id":\#(id),"at":1,"sessionId":"s","type":"notebook.cell.output","execId":"e\#(id)"\#(producerField),"output":\#(body)}"#)
    }

    @Test func aStateChangeAfterTheCursorBumpsTheRevisionAndKeepsTheState() {
        let signals = foldKernelSignals([stateChange], after: 0)
        #expect(signals.kernelRevision == 1)
        #expect(signals.kernelState == .idle)
    }

    @Test func aReplayedEventBeforeTheCursorIsIgnored() {
        // THE GUARD THAT MATTERS. The journal replays from zero on every open,
        // so a session with a hundred past outputs would otherwise look like a
        // hundred cells running right now and every surface would re-read a
        // hundred times before drawing anything.
        let signals = foldKernelSignals([stateChange, output(11)], after: 50)
        #expect(signals == KernelSignals())
    }

    @Test func onlyTheEventsPastTheCursorCount() {
        let signals = foldKernelSignals([output(5), output(6), output(90)], after: 50)
        #expect(signals.outputRevision == 1)
        #expect(signals.notebookRevision["nb.ipynb"] == 1)
    }

    @Test func outputsAreCountedPerProducer() {
        // A notebook keys its re-read on its OWN entry, so a cell in another
        // notebook does not reload it.
        let signals = foldKernelSignals([
            output(11, producer: "a.ipynb"), output(12, producer: "a.ipynb"), output(13, producer: "b.ipynb"),
        ], after: 0)
        #expect(signals.notebookRevision["a.ipynb"] == 2)
        #expect(signals.notebookRevision["b.ipynb"] == 1)
        #expect(signals.outputRevision == 3)
    }

    @Test func anOutputWithNoProducerStillCountsForTheNamespace() {
        // A scratch run changes the variables even though it belongs to no
        // notebook.
        let signals = foldKernelSignals([output(11, producer: nil)], after: 0)
        #expect(signals.outputRevision == 1)
        #expect(signals.notebookRevision.isEmpty)
    }

    @Test func onlyPicturesMoveThePlotRevision() {
        // A cell printing a table should not reload the gallery.
        let signals = foldKernelSignals([output(11), output(12, kind: "image"), output(13)], after: 0)
        #expect(signals.plotRevision == 1)
        #expect(signals.outputRevision == 3)
    }

    @Test func theLastStateWins() {
        let events = [
            event(#"{"id":11,"at":1,"sessionId":"s","type":"kernel.state.changed","state":"busy"}"#),
            event(#"{"id":12,"at":1,"sessionId":"s","type":"kernel.state.changed","state":"idle"}"#),
        ]
        let signals = foldKernelSignals(events, after: 0)
        #expect(signals.kernelRevision == 2)
        #expect(signals.kernelState == .idle)
    }

    @Test func theFoldIsCountedRatherThanIncremented() {
        // The fold runs again over the same array on every tick. A `+= 1` on
        // stored state would climb with nothing happening; running it twice
        // must give the same answer.
        let events = [stateChange, output(11), output(12)]
        #expect(foldKernelSignals(events, after: 0) == foldKernelSignals(events, after: 0))
    }

    @Test func aTailWithNothingFromTheKernelSaysNothing() {
        // Nil state, not `.none`: a session opened after the kernel started
        // must fall back to its own one-shot read rather than claim there is
        // no kernel.
        let signals = foldKernelSignals([], after: 0)
        #expect(signals.kernelState == nil)
        #expect(signals.kernelRevision == 0)
    }
}
