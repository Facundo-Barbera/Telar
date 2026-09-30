import XCTest

extension NavigationUITests {
    func testTheComposerKeepsOneRowAndItsControlsLiveBehindPlus() {
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "design"]
        app.launch()
        let composer = app.textViews["Ask the agent, or run a command…"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15))
        let resting = composer.frame

        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(composer.frame.height, resting.height, accuracy: 0.5, "focusing does not enlarge the field")
        XCTAssertEqual(composer.frame.width, resting.width, accuracy: 0.5, "nor move anything into or out of its row")

        composer.typeText("hello")
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 5), "text puts send in the slot")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "Composer — focused with text"; shot.lifetime = .keepAlways; add(shot)

        app.buttons["More"].tap()
        XCTAssertTrue(app.buttons["Attach photos"].waitForExistence(timeout: 5), "attachments live behind +")
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model'")).firstMatch
        XCTAssertTrue(model.exists, "and so does the model picker")
    }
}
