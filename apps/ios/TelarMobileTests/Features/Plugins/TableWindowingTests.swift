import Foundation
import Testing
@testable import TelarMobile

@MainActor @Suite struct TableWindowingTests {
    private final class Reads { var offsets: [Int] = [] }

    private func windows(total: Int = 1000, reads: Reads) -> TableWindows {
        TableWindows { offset in
            reads.offsets.append(offset)
            let count = max(0, min(TableWindows.page, total - offset))
            return TableWindow(path: "t.csv", columns: ["i"], dtypes: nil, total: total, offset: offset,
                               rows: (0..<count).map { [.number(Double(offset + $0))] }, truncated: nil)
        }
    }

    @Test func aRowIsReadWithTheWholePageItSitsOn() async {
        let reads = Reads()
        let table = windows(reads: reads)
        await table.ensure(437)?.value
        #expect(reads.offsets == [400])
        #expect(table.rows[400] == [.number(400)])
        #expect(table.rows[599] == [.number(599)])
        #expect(table.rows[600] == nil)
        #expect(TableWindows.pageOffset(of: 199) == 0)
        #expect(TableWindows.pageOffset(of: 200) == 200)
    }

    @Test func rowsOnAPageAlreadyInFlightDoNotReadItAgain() async {
        let reads = Reads()
        let table = windows(reads: reads)
        let first = table.ensure(401)
        #expect(first != nil)
        #expect(table.ensure(450) == nil)
        #expect(table.ensure(599) == nil)
        await first?.value
        #expect(reads.offsets == [400])
    }

    @Test func aPageThatArrivedIsNotReadAgain() async {
        let reads = Reads()
        let table = windows(reads: reads)
        await table.ensure(0)?.value
        #expect(table.ensure(150) == nil)
        await table.ensure(200)?.value
        #expect(reads.offsets == [0, 200])
        #expect(table.meta?.total == 1000)
    }

    @Test func aFailedFirstReadIsShownAndMayBeRetried() async {
        var fail = true
        let table = TableWindows { offset in
            if fail { throw EngineAPIError.engine(code: "nope", message: "The table is gone.", status: 404) }
            return TableWindow(path: "t.csv", columns: ["i"], dtypes: nil, total: 1, offset: offset, rows: [[.number(0)]], truncated: nil)
        }
        await table.ensure(0)?.value
        #expect(table.error != nil)
        fail = false
        await table.ensure(0)?.value
        #expect(table.rows[0] == [.number(0)])
    }
}
