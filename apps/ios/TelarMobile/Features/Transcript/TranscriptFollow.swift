import Foundation

enum TranscriptFollow {
    static func shouldFollow(takenByReader: Bool, atBottom: Bool) -> Bool {
        if !takenByReader { return true }

        return atBottom
    }
}
