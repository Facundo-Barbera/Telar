import XCTest
import UIKit

/// Run with the local preview server; no real pairing or engine state is used.
final class NavigationUITests: XCTestCase {
    func testSidebarOpensConversationAndSettings() {
        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        if isPad { XCUIDevice.shared.orientation = .landscapeLeft }
        defer { if isPad { XCUIDevice.shared.orientation = .portrait } }
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743"]
        app.launch()
        let row = app.staticTexts["Bring Telar’s design to iPhone and iPad"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        let sidebarRightEdge = row.frame.maxX
        row.tap()
        let composer = app.textFields["Ask the agent, or run a command…"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        if isPad {
            XCTAssertTrue(row.exists)
            XCTAssertGreaterThan(composer.frame.minX, sidebarRightEdge - 20, "Conversation must stay beside the sidebar")
        }
        app.buttons["Session actions"].tap()
        XCTAssertFalse(app.buttons["Follow session"].exists)
        app.tap()
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Conversation navigation"; screenshot.lifetime = .keepAlways; add(screenshot)
    }

    func testSettingsExposeNotifications() {
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSettings", "1"]
        app.launch()
        let settings = app.buttons["Notifications & activities"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        XCTAssertTrue(app.switches["Notifications"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.switches["Show session titles"].exists)
        XCTAssertTrue(app.switches["Automatic Live Activities"].exists)
    }
}

extension NavigationUITests {
    /// The iPad split view: hiding the sidebar must leave a way back. The
    /// system toggle can be displaced by the detail's own toolbar, so the
    /// detail carries its own "Show sidebar" while the sidebar is hidden.
    func testHiddenSidebarCanBeShownAgainOnIPad() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad only") }
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design"]
        app.launch()
        let composer = app.textFields["Ask the agent, or run a command…"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        // The search field exists only in the sidebar column; the session's
        // title also appears in the detail's navigation bar, so a row's text
        // cannot stand in for "the sidebar is visible".
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))

        // Hide the sidebar with the system toggle in the sidebar's own bar.
        let toggle = app.buttons["ToggleSidebar"].exists ? app.buttons["ToggleSidebar"] : app.buttons["Hide Sidebar"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5), "system sidebar toggle")
        toggle.tap()
        XCTAssertTrue(search.waitForNonExistence(timeout: 5), "sidebar should be gone once hidden")

        // The way back.
        let show = app.buttons["Show sidebar"]
        XCTAssertTrue(show.waitForExistence(timeout: 5), "detail must offer Show sidebar while hidden")
        show.tap()
        XCTAssertTrue(search.waitForExistence(timeout: 5), "sidebar should return")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Sidebar restored"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
}

extension NavigationUITests {
    /// The right panel against the preview fixture: every tab renders, files
    /// open from the tree, the sidebar gets out of the way in portrait and
    /// comes back, and the screenshots are kept for review.
    ///
    /// PORTRAIT ON PURPOSE. It is the width where all three columns do not
    /// fit, so it is the one that exercises both the sidebar rule and the
    /// tree/file toggle inside a ~370pt inspector.
    func testPanelTabsRenderOnIPad() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad only") }
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design"]
        app.launch()
        XCTAssertTrue(app.textFields["Ask the agent, or run a command…"].waitForExistence(timeout: 15))
        // The search field exists only in the sidebar column.
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10), "the sidebar starts visible")

        app.buttons["Session actions"].tap()
        app.buttons["Panel"].tap()
        XCTAssertTrue(app.buttons["Diff tab"].waitForExistence(timeout: 10))
        XCTAssertTrue(search.waitForNonExistence(timeout: 5), "portrait has no room for all three — the sidebar stands aside")
        // The panel REMEMBERS which tab was up, so a previous run decides
        // what opens; say which one this test wants.
        select(app.buttons["Diff tab"])
        XCTAssertTrue(app.staticTexts["No recorded base — committed work is not included."].waitForExistence(timeout: 10),
                      "the Diff surface, not just its chip")
        snap("Panel — Diff")

        select(app.buttons["Files tab"])
        openFromTree(app, "README.md")
        XCTAssertTrue(app.staticTexts["README.md"].firstMatch.waitForExistence(timeout: 10), "the file's address row")
        snap("Panel — Files, README")

        openFromTree(app, "exoplanets.ipynb")
        XCTAssertTrue(app.buttons["Run all cells"].waitForExistence(timeout: 10), "notebook header")
        snap("Panel — Files, notebook")

        openFromTree(app, "rows.csv")
        XCTAssertTrue(app.staticTexts["2 rows × 2"].waitForExistence(timeout: 10), "table window")
        snap("Panel — Files, table")

        openFromTree(app, "main.pdf")
        XCTAssertTrue(app.staticTexts["report/main.pdf"].waitForExistence(timeout: 10), "PDF header")
        snap("Panel — Files, PDF")

        XCTAssertTrue(app.buttons["Data tab"].exists, "Data tab is offered when the project opted in")
        select(app.buttons["Data tab"])
        // The sub-tab is a habit remembered per DEVICE, so a previous run
        // decides which one is up; say which one this test wants.
        select(app.buttons["Plots"])
        XCTAssertTrue(app.buttons["Pin plot"].firstMatch.waitForExistence(timeout: 10), "plots grid")
        snap("Panel — Data, plots")
        select(app.buttons["Variables"])
        XCTAssertTrue(app.staticTexts["df"].waitForExistence(timeout: 10))
        snap("Panel — Data, variables")
        select(app.buttons["Environment"])
        XCTAssertTrue(app.staticTexts["pandas"].waitForExistence(timeout: 10))
        snap("Panel — Data, environment")

        select(app.buttons["LaTeX tab"])
        XCTAssertTrue(app.buttons["Compile"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Undefined control sequence \\foo."].waitForExistence(timeout: 10))
        snap("Panel — LaTeX")
        app.buttons["Open PDF"].tap()
        XCTAssertTrue(app.buttons["Files tab"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["report/main.pdf"].waitForExistence(timeout: 10), "LaTeX handed the PDF to Files")
        snap("Panel — LaTeX opened the PDF")

        app.buttons["Close panel"].tap()
        XCTAssertTrue(search.waitForExistence(timeout: 10), "the sidebar comes back when the panel closes")
    }

    /// Tap a strip until it is the one that is up. The panel remembers its
    /// tab between launches, so "tap it" is not the same as "it is showing" —
    /// and the menu's own dismissal can eat the first tap at the strip.
    private func select(_ tab: XCUIElement) {
        XCTAssertTrue(tab.waitForExistence(timeout: 10), "\(tab.label) exists")
        // ALWAYS TAP. A stale `isSelected` read would otherwise skip the tap
        // and leave the previous surface up under the name of this one.
        // Tapping the tab that is already up is a no-op in the model.
        tab.tap()
        let up = expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: tab)
        guard XCTWaiter.wait(for: [up], timeout: 5) != .completed else { return }
        tab.tap()
        XCTAssertTrue(XCTWaiter.wait(for: [expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: tab)], timeout: 5) == .completed,
                      "\(tab.label) is the surface that is up")
    }

    /// The tree and the file share the narrow panel, so getting to the next
    /// file means asking for the tree back — exactly what a reader does.
    private func openFromTree(_ app: XCUIApplication, _ name: String) {
        let showTree = app.buttons["Show tree"]
        if showTree.exists { showTree.tap() }
        let row = app.buttons[name].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the tree lists \(name)")
        row.tap()
    }

    private func snap(_ name: String) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
    }
}
