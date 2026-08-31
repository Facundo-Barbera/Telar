import SwiftUI

@main
struct TelarMobileApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    var body: some View {
        Text("Telar")
            .font(.largeTitle.bold())
    }
}
