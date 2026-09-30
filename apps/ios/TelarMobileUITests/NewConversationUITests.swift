import XCTest
import UIKit

extension NavigationUITests {
    func testNewConversationOpensAnEmptyDraftAndTakesAPastedImage() {
        UIPasteboard.general.image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 24, height: 24))
        }
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-newSessionProject", "telar"]
        app.launch()
        let newConversation = app.buttons["New conversation"]
        XCTAssertTrue(newConversation.waitForExistence(timeout: 15))
        newConversation.tap()

        XCTAssertTrue(app.buttons["Project: Telar"].waitForExistence(timeout: 10), "the draft names its project")
        XCTAssertFalse(app.textFields["Title — optional, taken from your message"].exists)
        let prompt = app.textViews["Describe a coding task in Telar"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 10), "the draft's prompt")
        prompt.tap()
        prompt.typeText("go")
        XCTAssertTrue((prompt.value as? String)?.hasSuffix("go") == true, "the prompt still edits text")

        prompt.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "the prompt's own menu offers Paste for a picture")
        paste.tap()
        XCTAssertTrue(app.buttons["Remove pasted.png"].waitForExistence(timeout: 10),
                      "the pasted image waits in the draft's strip")

        app.buttons["Project: Telar"].tap()
        let other = app.buttons["GoVirtual Console"]
        XCTAssertTrue(other.waitForExistence(timeout: 5), "the picker lists the other project")
        other.tap()
        XCTAssertTrue(app.buttons["Project: GoVirtual Console"].waitForExistence(timeout: 5))
    }

    func testTheComposerBarFitsAtTheLargestTextSize() {
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-newSessionProject", "telar",
                               "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL"]
        app.launch()
        let newConversation = app.buttons["New conversation"]
        XCTAssertTrue(newConversation.waitForExistence(timeout: 15))
        newConversation.tap()
        let prompt = app.textViews["Describe a coding task in Telar"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 10))
        prompt.tap()

        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        let window = app.windows.firstMatch.frame
        XCTAssertLessThanOrEqual(send.frame.maxX, window.maxX, "send is not pushed off the edge")
        XCTAssertTrue(send.isHittable, "and nothing covers it")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "New conversation — accessibility XL"; shot.lifetime = .keepAlways; add(shot)
    }
}
