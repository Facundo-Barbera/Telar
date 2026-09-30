import XCTest

final class QuestionCardUITests: XCTestCase {
    func testQuestionsPageOneAtATime() {
        let app = XCUIApplication()
        app.launchArguments = ["-mobilePreviewURL", "http://127.0.0.1:8743", "-openSession", "approval"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Question 1 of 2"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Permiso"].exists)
        XCTAssertFalse(app.staticTexts["¿A quién avisamos del cambio?"].exists)
        let next = app.buttons["Next"]
        XCTAssertFalse(next.isEnabled)
        XCTAssertTrue(app.textViews["Ask the agent, or run a command…"].isHittable)
        attach(app, "Question page one")

        let option = app.buttons["Solo lectura. Puede ver el mapa pero no cambiarlo."]
        option.tap()
        XCTAssertTrue(option.isSelected)
        XCTAssertTrue(next.isEnabled)
        next.tap()

        XCTAssertTrue(app.staticTexts["Question 2 of 2"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["¿A quién avisamos del cambio?"].exists)
        let submit = app.buttons["Submit"]
        XCTAssertFalse(submit.isEnabled)
        app.buttons["Finanzas"].tap()
        app.buttons["Dirección"].tap()
        XCTAssertTrue(app.buttons["Finanzas"].isSelected)
        XCTAssertTrue(submit.isEnabled)
        attach(app, "Question page two")

        app.buttons["Back"].tap()
        XCTAssertTrue(app.staticTexts["Question 1 of 2"].waitForExistence(timeout: 5))
        XCTAssertTrue(option.isSelected)
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
