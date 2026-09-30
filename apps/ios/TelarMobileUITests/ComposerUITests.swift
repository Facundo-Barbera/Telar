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
        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "text puts send in the slot")
        let oneLine = composer.frame
        composer.typeText("\ntwo\nthree")
        XCTAssertGreaterThan(composer.frame.height, oneLine.height, "the pill grows with the text")
        XCTAssertEqual(composer.frame.maxY, oneLine.maxY, accuracy: 0.5, "upward, its bottom edge anchored")
        XCTAssertEqual(send.frame.maxY, app.buttons["More"].frame.maxY, accuracy: 0.5, "and the controls stay level at the bottom")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "Composer — focused with text"; shot.lifetime = .keepAlways; add(shot)

        app.buttons["More"].tap()
        XCTAssertTrue(app.buttons["Attach photos"].waitForExistence(timeout: 5), "attachments live behind +")
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model'")).firstMatch
        XCTAssertTrue(model.exists, "and so does the model picker")
    }
}
