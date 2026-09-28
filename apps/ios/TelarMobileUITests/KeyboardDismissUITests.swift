import XCTest
import UIKit

extension NavigationUITests {
    func testTheTranscriptPutsTheKeyboardAway() {
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design"]
        app.launch()
        let composer = app.textViews["Ask the agent, or run a command…"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15))

        composer.tap()
        XCTAssertTrue(keyboard(app, is: true), "the composer raises the keyboard")
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 200, dy: 260)).tap()
        XCTAssertTrue(keyboard(app, is: false), "a tap on the conversation puts it away")

        composer.tap()
        XCTAssertTrue(keyboard(app, is: true), "and it comes back")
        let from = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 200, dy: 180))
        let to = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 200, dy: 330))
        from.press(forDuration: 0.05, thenDragTo: to)
        XCTAssertTrue(keyboard(app, is: false), "scrolling the conversation puts it away too")
    }

    private func keyboard(_ app: XCUIApplication, is wanted: Bool) -> Bool {
        for _ in 0..<30 {
            if (app.keyboards.count > 0) == wanted { return true }
            usleep(100_000)
        }
        return false
    }
}
