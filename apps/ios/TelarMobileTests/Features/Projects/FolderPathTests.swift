import Foundation
import Testing
@testable import TelarMobile

@Suite struct FolderPathTests {
    @Test func acceptsAbsoluteAndHomePathsTrimmed() {
        #expect(FolderPath.parse("  /Volumes/Taller/projects/life/ \n") == .success("/Volumes/Taller/projects/life"))
        #expect(FolderPath.parse("\"/Volumes/My Drive/x\"") == .success("/Volumes/My Drive/x"))
        #expect(FolderPath.parse("~") == .success("~"))
        #expect(FolderPath.parse("~/code") == .success("~/code"))
        #expect(FolderPath.parse("/") == .success("/"))
    }

    @Test func refusesEmptyAndRelativePathsWithOneSentence() {
        #expect(FolderPath.parse("   ") == .failure(.init(message: "Type or paste a folder path.")))
        #expect(FolderPath.parse("projects/life") == .failure(.init(message: "A folder path has to start with / or ~.")))
        #expect(FolderPath.parse("~someone/x") == .failure(.init(message: "A folder path has to start with / or ~.")))
    }

    @Test func otherRootsOffersEachVolumeButNotTheFolderShown() throws {
        let json = """
        {"path":"/Users/me","name":"me","dirs":[],"roots":[
          {"name":"Home","path":"/Users/me"},
          {"name":"Taller","path":"/Volumes/Taller"}
        ]}
        """
        let listing = try JSONDecoder().decode(DirectoryListing.self, from: Data(json.utf8))
        #expect(FolderPath.otherRoots(of: listing).map(\.path) == ["/Volumes/Taller"])

        let older = try JSONDecoder().decode(DirectoryListing.self, from: Data(#"{"path":"/","name":"/","dirs":[]}"#.utf8))
        #expect(FolderPath.otherRoots(of: older).isEmpty)
    }
}
