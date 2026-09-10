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
