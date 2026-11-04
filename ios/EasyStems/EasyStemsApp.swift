import SwiftUI
import AVFAudio

/// Easy Stems for iPhone and iPad: a song in, its instruments out, on the
/// device. The desktop app's ideas in SwiftUI; the same Demucs network
/// through ONNX Runtime.
@main
struct EasyStemsApp: App {
    @StateObject private var model = AppModel()

    init() {
        // Playback keeps going with the screen off, and mixes with nothing.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .tint(Theme.blue)
        }
    }
}
