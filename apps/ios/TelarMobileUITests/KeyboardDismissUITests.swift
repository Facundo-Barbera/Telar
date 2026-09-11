import XCTest
import UIKit

extension NavigationUITests {
    /// THE CONVERSATION IS STILL THE WAY OUT OF THE KEYBOARD. A tap on the
    /// transcript, or a scroll of it, puts the keyboard away.
    ///
    /// Pinned because the scroll half stopped being free: the composer's field
    /// is a `UITextView` now, which `.scrollDismissesKeyboard` cannot reach —
    /// the transcript moved with the keyboard still standing until the session
    /// dropped focus itself.
    func testTheTranscriptPutsTheKeyboardAway() {
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design"]
        app.launch()
        let composer = app.textViews["Ask the agent, or run a command…"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15))

        composer.tap()
        XCTAssertTrue(keyboard(app, is: true), "the composer raises the keyboard")
        // A tap high in the transcript, well clear of the composer.
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 200, dy: 260)).tap()
        XCTAssertTrue(keyboard(app, is: false), "a tap on the conversation puts it away")

        composer.tap()
        XCTAssertTrue(keyboard(app, is: true), "and it comes back")
        // Downward, from inside the transcript: reading BACK always has room,
        // so the scroll view really begins a drag.
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
