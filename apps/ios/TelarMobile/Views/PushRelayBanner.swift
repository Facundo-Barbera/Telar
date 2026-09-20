import SwiftUI

/// "THIS MAC CANNOT NOTIFY YOU" — issue #579.
///
/// The Mac answers `configured: false` on every registration when it has no
/// push relay, and until now the single place that fact was rendered was a
/// status line under a toggle in Settings ▸ Notifications — a screen nobody
/// opens, and which on the owner's phone had never been opened at all. So the
/// fact is put where the person already is: over the conversation, and over the
/// inbox.
///
/// IT NAMES THE SCREEN ON THE MAC. The missing thing is a credential in that
/// machine's Keychain, so a banner that said "notifications are unavailable"
/// would leave somebody looking on the phone, which is the one place the fix
/// cannot be.
///
/// QUIET, AND ABSENT WHEN THERE IS NOTHING TO SAY. It is amber rather than red
/// because nothing is broken — a feature is unprovisioned — and it draws
/// nothing at all while the Mac is merely unreachable, which is a different
/// problem with a different fix.
struct PushRelayBanner: View {
    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "bell.slash").font(.system(Theme.caption))
            Text(PushReadiness.bannerLine).font(Theme.meta)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Theme.statusAmber)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Notifications unavailable: \(PushReadiness.bannerLine)")
    }
}
