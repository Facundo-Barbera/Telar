import Foundation
import Testing
@testable import TelarMobile

@Suite struct KernelSignalsTests {
    private func event(_ json: String) -> EngineEvent {
        try! JSONDecoder().decode(EngineEvent.self, from: Data(json.utf8))
    }

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
        let decoded = event(#"{"id":6,"at":1,"sessionId":"s","type":"notebook.cell.output","execId":"e1","output":42}"#)
        if case .notebookCellOutput(let execId, _, let producer, let output) = decoded.payload {
            #expect(execId == "e1")
            #expect(producer == nil)
            #expect(output == nil)
        } else {
            Issue.record("expected notebookCellOutput")
        }
    }

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
        let signals = foldKernelSignals([stateChange, output(11)], after: 50)
        #expect(signals == KernelSignals())
    }

    @Test func onlyTheEventsPastTheCursorCount() {
        let signals = foldKernelSignals([output(5), output(6), output(90)], after: 50)
        #expect(signals.outputRevision == 1)
        #expect(signals.notebookRevision["nb.ipynb"] == 1)
    }

    @Test func outputsAreCountedPerProducer() {
        let signals = foldKernelSignals([
            output(11, producer: "a.ipynb"), output(12, producer: "a.ipynb"), output(13, producer: "b.ipynb"),
        ], after: 0)
        #expect(signals.notebookRevision["a.ipynb"] == 2)
        #expect(signals.notebookRevision["b.ipynb"] == 1)
        #expect(signals.outputRevision == 3)
    }

    @Test func anOutputWithNoProducerStillCountsForTheNamespace() {
        let signals = foldKernelSignals([output(11, producer: nil)], after: 0)
        #expect(signals.outputRevision == 1)
        #expect(signals.notebookRevision.isEmpty)
    }

    @Test func onlyPicturesMoveThePlotRevision() {
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
        let events = [stateChange, output(11), output(12)]
        #expect(foldKernelSignals(events, after: 0) == foldKernelSignals(events, after: 0))
    }

    @Test func aTailWithNothingFromTheKernelSaysNothing() {
        let signals = foldKernelSignals([], after: 0)
        #expect(signals.kernelState == nil)
        #expect(signals.kernelRevision == 0)
    }
}
