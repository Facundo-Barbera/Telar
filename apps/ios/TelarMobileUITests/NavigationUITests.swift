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
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Conversation navigation"; screenshot.lifetime = .keepAlways; add(screenshot)
    }

    func testFollowSessionCreatesAndEndsLiveActivity() {
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design", "-localActivityPreview", "1"]
        app.launch()
        let actions = app.buttons["Session actions"]
        XCTAssertTrue(actions.waitForExistence(timeout: 10))
        actions.tap()
        let follow = app.buttons["Follow session"]
        XCTAssertTrue(follow.waitForExistence(timeout: 5))
        follow.tap()
        if app.alerts["Live Activity"].waitForExistence(timeout: 2) {
            XCTFail(app.alerts["Live Activity"].debugDescription)
            return
        }
        actions.tap()
        XCTAssertTrue(app.buttons["Stop following"].waitForExistence(timeout: 5))
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 5))
        app.activate()
        if !app.buttons["Stop following"].exists { actions.tap() }
        app.buttons["Stop following"].tap()
        actions.tap()
        XCTAssertTrue(app.buttons["Follow session"].waitForExistence(timeout: 5))
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
    }
}
