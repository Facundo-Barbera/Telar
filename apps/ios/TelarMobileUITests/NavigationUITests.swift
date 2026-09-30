import XCTest
import UIKit

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
        let composer = app.textViews["Ask the agent, or run a command…"]
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
    func testHiddenSidebarCanBeShownAgainOnIPad() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad only") }
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design"]
        app.launch()
        let composer = app.textViews["Ask the agent, or run a command…"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))

        let toggle = app.buttons["ToggleSidebar"].exists ? app.buttons["ToggleSidebar"] : app.buttons["Hide Sidebar"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5), "system sidebar toggle")
        toggle.tap()
        XCTAssertTrue(search.waitForNonExistence(timeout: 5), "sidebar should be gone once hidden")

        let show = app.buttons["Show sidebar"]
        XCTAssertTrue(show.waitForExistence(timeout: 5), "detail must offer Show sidebar while hidden")
        show.tap()
        XCTAssertTrue(search.waitForExistence(timeout: 5), "sidebar should return")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Sidebar restored"; screenshot.lifetime = .keepAlways; add(screenshot)
    }
}

extension NavigationUITests {
    func testPanelTabsRenderOnIPad() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad only") }
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design"]
        app.launch()
        XCTAssertTrue(app.textViews["Ask the agent, or run a command…"].waitForExistence(timeout: 15))
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10), "the sidebar starts visible")

        app.buttons["Show panel"].tap()
        XCTAssertTrue(app.buttons["Diff tab"].waitForExistence(timeout: 10))
        XCTAssertTrue(search.waitForNonExistence(timeout: 5), "portrait has no room for all three — the sidebar stands aside")
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

    private func select(_ tab: XCUIElement) {
        XCTAssertTrue(tab.waitForExistence(timeout: 10), "\(tab.label) exists")
        tab.tap()
        let up = expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: tab)
        guard XCTWaiter.wait(for: [up], timeout: 5) != .completed else { return }
        tab.tap()
        XCTAssertTrue(XCTWaiter.wait(for: [expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: tab)], timeout: 5) == .completed,
                      "\(tab.label) is the surface that is up")
    }

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

extension NavigationUITests {
    func testPastingAnImageBecomesAnAttachment() {
        UIPasteboard.general.image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 24, height: 24))
        }
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design"]
        app.launch()
        let composer = app.textViews["Ask the agent, or run a command…"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        composer.tap()
        composer.typeText("here")
        XCTAssertTrue((composer.value as? String)?.hasSuffix("here") == true, "the composer still edits text")

        composer.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5),
                      "the field's own menu offers Paste for a picture")
        paste.tap()

        XCTAssertTrue(app.buttons["Remove pasted.png"].waitForExistence(timeout: 15),
                      "the pasted image is in the attachment strip, removable")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "Composer — pasted image"; shot.lifetime = .keepAlways; add(shot)

        app.buttons["Remove pasted.png"].tap()
        XCTAssertTrue(app.buttons["Remove pasted.png"].waitForNonExistence(timeout: 5), "and removing it takes it out")
    }
}

extension NavigationUITests {
    func testThePanelToggleOpensAndClosesIt() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad only") }
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design"]
        app.launch()
        XCTAssertTrue(app.textViews["Ask the agent, or run a command…"].waitForExistence(timeout: 15))

        if app.buttons["Hide panel"].exists {
            app.buttons["Hide panel"].tap()
            XCTAssertTrue(app.buttons["Show panel"].waitForExistence(timeout: 5))
        }
        let show = app.buttons["Show panel"]
        XCTAssertTrue(show.waitForExistence(timeout: 5), "the toolbar offers the panel")
        XCTAssertFalse(show.isSelected, "unlit while the panel is closed")
        snap("Panel toggle — closed")

        show.tap()
        XCTAssertTrue(app.buttons["Diff tab"].waitForExistence(timeout: 10), "the panel opened")
        let hide = app.buttons["Hide panel"]
        XCTAssertTrue(hide.waitForExistence(timeout: 5), "the same button now closes it")
        XCTAssertTrue(hide.isSelected, "lit while the panel is open")
        snap("Panel toggle — open")

        hide.tap()
        XCTAssertTrue(app.buttons["Diff tab"].waitForNonExistence(timeout: 10), "and it closes again")
    }
}

extension NavigationUITests {
    func testThePanelCanFillTheWindowAndComeBack() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad only") }
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design"]
        app.launch()
        let composer = app.textViews["Ask the agent, or run a command…"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        if app.buttons["Show panel"].exists { app.buttons["Show panel"].tap() }
        XCTAssertTrue(app.buttons["Diff tab"].waitForExistence(timeout: 10))
        select(app.buttons["Files tab"])
        openFromTree(app, "README.md")
        XCTAssertTrue(app.staticTexts["README.md"].firstMatch.waitForExistence(timeout: 10))

        let expand = app.buttons["Fill the window"]
        XCTAssertTrue(expand.waitForExistence(timeout: 5), "the panel offers full screen")
        expand.tap()
        XCTAssertTrue(app.buttons["Leave full screen"].waitForExistence(timeout: 10), "it filled the window")
        XCTAssertFalse(composer.isHittable, "the conversation is covered")
        XCTAssertTrue(app.staticTexts["README.md"].firstMatch.exists, "the open file crossed with it")
        snap("Panel — full screen")

        app.buttons["Leave full screen"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "and the conversation is back")
        XCTAssertTrue(app.buttons["Fill the window"].waitForExistence(timeout: 5), "back in the column")
        snap("Panel — back in the column")
    }
}
