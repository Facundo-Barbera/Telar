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
