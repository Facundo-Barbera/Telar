import Foundation
import Testing
@testable import TelarMobile

@Suite struct HostMigrationTests {
    @Test func freshInstallHasNothingToMigrate() {
        #expect(HostMigration.plan(legacyBaseURL: nil, existingKeys: [], now: Date(), id: HostID()) == nil)
        #expect(HostMigration.plan(legacyBaseURL: "", existingKeys: [], now: Date(), id: HostID()) == nil)
    }

    @Test func singleHostInstallBecomesHostZeroWithScopedPendingSends() {
        let id = HostID()
        let plan = HostMigration.plan(
            legacyBaseURL: "http://100.1.1.1:3000",
            existingKeys: ["telar.pendingSend.session_a", "telar.baseURL", "unrelated"],
            now: Date(timeIntervalSince1970: 500), id: id
        )
        #expect(plan?.host?.baseURLString == "http://100.1.1.1:3000")
        #expect(plan?.host?.name == "100.1.1.1:3000")
        #expect(plan?.host?.migratedFromSingle == true)
        #expect(plan?.pendingSendRenames == [
            .init(old: "telar.pendingSend.session_a", new: "telar.pendingSend.\(id.uuidString).session_a"),
        ])
    }

    @Test func persistAndLoadRoundTrip() {
        let defaults = UserDefaults(suiteName: "telar.test.migration.\(UUID().uuidString)")!
        var book = HostBook()
        _ = book.upsert(baseURLString: "http://a:3000")
        _ = book.upsert(baseURLString: "http://b:3000")
        HostMigration.persist(book, defaults: defaults)
        #expect(HostMigration.load(defaults: defaults) == book)
    }

    @Test func tokenAccountsAreHostScoped() {
        let id = HostID()
        #expect(HostMigration.tokenAccount(id) == "deviceToken.\(id.uuidString)")
    }
}
