import XCTest
import UIKit

extension NavigationUITests {
    /// THE SHEET'S PROMPT TAKES A PASTE TOO. It is the same field as the
    /// session composer's and it has to behave the same: nothing is uploaded
    /// here (there is no session id until the arrow is pressed), so the bytes
    /// wait in the draft strip.
    func testPastingAnImageIntoTheNewSessionSheet() {
        UIPasteboard.general.image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 24, height: 24))
        }
        let app = XCUIApplication()
        // The seeded project jumps past "Choose project" to the draft step.
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-newSessionProject", "telar"]
        app.launch()
        let newConversation = app.buttons["New conversation"]
        XCTAssertTrue(newConversation.waitForExistence(timeout: 15))
        newConversation.tap()

        let prompt = app.textViews["Describe a coding task in Telar"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 10), "the sheet's prompt")
        prompt.tap()
        prompt.typeText("go")
        XCTAssertTrue((prompt.value as? String)?.hasSuffix("go") == true, "the prompt still edits text")

        prompt.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "the prompt's own menu offers Paste for a picture")
        paste.tap()
        XCTAssertTrue(app.buttons["Remove pasted.png"].waitForExistence(timeout: 10),
                      "the pasted image waits in the sheet's strip")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "New session — pasted image"; shot.lifetime = .keepAlways; add(shot)
    }
}
