import SwiftUI

/// The desktop app's palette, so the two look like one product.
enum Theme {
    static let bg = Color(red: 7/255, green: 11/255, blue: 20/255)
    static let panel = Color(red: 15/255, green: 23/255, blue: 42/255)
    static let panel2 = Color(red: 19/255, green: 28/255, blue: 48/255)
    static let line = Color(red: 30/255, green: 42/255, blue: 68/255)
    static let blue = Color(red: 26/255, green: 125/255, blue: 255/255)
    static let blue2 = Color(red: 61/255, green: 147/255, blue: 255/255)
    static let muted = Color(red: 138/255, green: 151/255, blue: 177/255)
    static let danger = Color(red: 255/255, green: 92/255, blue: 106/255)
    static let amber = Color(red: 255/255, green: 176/255, blue: 32/255)

    static func stemColor(_ key: String) -> Color {
        switch key {
        case "drums": return Color(red: 1, green: 90/255, blue: 90/255)
        case "bass": return Color(red: 1, green: 159/255, blue: 46/255)
        case "guitar": return Color(red: 47/255, green: 214/255, blue: 106/255)
        case "piano": return Color(red: 47/255, green: 139/255, blue: 255/255)
        case "vocals": return Color(red: 165/255, green: 92/255, blue: 255/255)
        default: return Color(red: 138/255, green: 148/255, blue: 166/255)
        }
    }

    static func stemIcon(_ key: String) -> String {
        switch key {
        case "drums": return "music.note"
        case "bass": return "guitars"
        case "guitar": return "guitars.fill"
        case "piano": return "pianokeys"
        case "vocals": return "mic.fill"
        default: return "ellipsis"
        }
    }

    static func stemLabel(_ key: String) -> String {
        switch key {
        case "drums": return "Drums"
        case "bass": return "Bass"
        case "guitar": return "Guitar"
        case "piano": return "Keys"
        case "vocals": return "Vocals"
        default: return "Aux / Other"
        }
    }
}

extension View {
    func card() -> some View {
        self.padding(16)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.line, lineWidth: 1))
    }
}
