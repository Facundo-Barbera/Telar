import Foundation
import Testing
@testable import TelarMobile

/// The pandas fast path. Everything this refuses falls through to the web
/// view, so a false NEGATIVE costs a nicer rendering while a false POSITIVE
/// draws a grid with the columns shifted — which is why the ragged and
/// not-quite-pandas cases are here too.
@Suite struct PandasHtmlTableTests {
    /// What `DataFrame.to_html` actually writes, style prelude and all.
    private let real = """
    <div>
    <style scoped>
        .dataframe tbody tr th:only-of-type { vertical-align: middle; }
        .dataframe tbody tr th { vertical-align: top; }
        .dataframe thead th { text-align: right; }
    </style>
    <table border="1" class="dataframe">
      <thead>
        <tr style="text-align: right;">
          <th></th>
          <th>city</th>
          <th>pop</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>0</th>
          <td>Bogotá</td>
          <td>7412566</td>
        </tr>
        <tr>
          <th>1</th>
          <td>Medellín</td>
          <td>2529403</td>
        </tr>
      </tbody>
    </table>
    </div>
    """

    @Test func aRealPandasReprParsesThroughItsStyleAndWrapper() throws {
        let table = try #require(parsePandasHtmlTable(real))
        // The leading header is the INDEX column and pandas leaves it empty.
        // Keeping it empty rather than inventing a name is what makes the row
        // arrays line up with the headers.
        #expect(table.columns == ["", "city", "pop"])
        #expect(table.rows == [["0", "Bogotá", "7412566"], ["1", "Medellín", "2529403"]])
    }

    @Test func theIndexValueIsTheFirstCellOfEachRow() throws {
        let table = try #require(parsePandasHtmlTable(real))
        #expect(table.rows.map(\.first) == ["0", "1"])
        #expect(table.columnCount == 3)
    }

    @Test func aNamedIndexKeepsItsHeader() throws {
        let html = """
        <table class="dataframe"><thead><tr><th>id</th><th>value</th></tr></thead>
        <tbody><tr><th>a1</th><td>3</td></tr></tbody></table>
        """
        let table = try #require(parsePandasHtmlTable(html))
        #expect(table.columns == ["id", "value"])
        #expect(table.rows == [["a1", "3"]])
    }

    @Test func emptyAndNaNCellsKeepTheirPlace() throws {
        // A shifted row is the failure this guards: whatever pandas puts in an
        // empty cell, the cell still has to be counted.
        let html = """
        <table class="dataframe"><thead><tr><th></th><th>a</th><th>b</th></tr></thead>
        <tbody><tr><th>0</th><td>NaN</td><td></td></tr>
        <tr><th>1</th><td>&nbsp;</td><td>2</td></tr></tbody></table>
        """
        let table = try #require(parsePandasHtmlTable(html))
        #expect(table.rows == [["0", "NaN", ""], ["1", "", "2"]])
    }

    @Test func entitiesAndNestedMarkupComeOutAsText() throws {
        let html = """
        <table class="dataframe"><thead><tr><th></th><th>expr</th></tr></thead>
        <tbody><tr><th>0</th><td><b>a</b> &lt; b &amp;&amp; c &gt; d</td></tr></tbody></table>
        """
        let table = try #require(parsePandasHtmlTable(html))
        #expect(table.rows == [["0", "a < b && c > d"]])
    }

    @Test func aMultiIndexHeaderUsesItsMostSpecificLevel() throws {
        // Two header rows; the second names the actual columns.
        let html = """
        <table class="dataframe"><thead>
        <tr><th></th><th>2024</th><th>2024</th></tr>
        <tr><th></th><th>q1</th><th>q2</th></tr>
        </thead><tbody><tr><th>0</th><td>1</td><td>2</td></tr></tbody></table>
        """
        let table = try #require(parsePandasHtmlTable(html))
        #expect(table.columns == ["", "q1", "q2"])
        #expect(table.rows == [["0", "1", "2"]])
    }

    // MARK: what falls through to the web view

    @Test func aTableThatIsNotPandasIsNotClaimed() {
        // Hand-written HTML in a repr has no `dataframe` class, and guessing
        // would draw somebody's layout table as a grid.
        #expect(parsePandasHtmlTable("<table><tr><td>a</td></tr></table>") == nil)
        #expect(parsePandasHtmlTable("<table class=\"summary\"><tr><td>a</td></tr></table>") == nil)
    }

    @Test func htmlWithNoTableAtAllIsNotClaimed() {
        #expect(parsePandasHtmlTable("<div>a widget</div>") == nil)
        #expect(parsePandasHtmlTable("") == nil)
    }

    @Test func aRaggedTableFallsThroughRatherThanShiftingColumns() {
        // Drawing this as a grid would silently put the second row's values
        // under the wrong headers.
        let html = """
        <table class="dataframe"><thead><tr><th></th><th>a</th><th>b</th></tr></thead>
        <tbody><tr><th>0</th><td>1</td><td>2</td></tr>
        <tr><th>1</th><td>3</td></tr></tbody></table>
        """
        #expect(parsePandasHtmlTable(html) == nil)
    }

    @Test func aHeaderWithNoBodyIsNotATable() {
        let html = "<table class=\"dataframe\"><thead><tr><th>a</th></tr></thead><tbody></tbody></table>"
        #expect(parsePandasHtmlTable(html) == nil)
    }

    @Test func theClassIsMatchedAsAWholeWordAmongOthers() throws {
        // `to_html(classes=…)` adds classes beside the marker, and a class
        // merely CONTAINING the word is not the marker.
        #expect(parsePandasHtmlTable("""
        <table class="table dataframe striped"><thead><tr><th>a</th></tr></thead>
        <tbody><tr><td>1</td></tr></tbody></table>
        """) != nil)
        #expect(parsePandasHtmlTable("""
        <table class="my-dataframes"><thead><tr><th>a</th></tr></thead>
        <tbody><tr><td>1</td></tr></tbody></table>
        """) == nil)
    }
}
