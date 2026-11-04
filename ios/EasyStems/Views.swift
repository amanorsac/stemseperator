import SwiftUI
import UniformTypeIdentifiers

struct RootView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg.ignoresSafeArea()
                if model.song != nil { SongView(player: model.player) } else { HomeView() }
            }
            .navigationTitle("Easy Stems")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar)
        }
    }
}

struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @State private var picking = false
    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                VStack(spacing: 10) {
                    Image(systemName: "waveform").font(.system(size: 44)).foregroundStyle(Theme.blue2)
                    Text("Split a song into its instruments").font(.title2.bold()).multilineTextAlignment(.center)
                    Text("Drums, bass, guitar, keys, vocals and the rest, separated on this device. Nothing is uploaded.")
                        .font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                    Button { picking = true } label: {
                        Label("Open a song", systemImage: "folder").font(.headline).padding(.horizontal, 22).padding(.vertical, 12)
                    }.buttonStyle(.borderedProminent).padding(.top, 6)
                    if !model.models.ready {
                        Text("The first song downloads the 136 MB model, once.").font(.caption).foregroundStyle(Theme.muted)
                    }
                    if let working = model.working {
                        VStack(spacing: 6) {
                            HStack { ProgressView().tint(Theme.blue2); Text(working.label).font(.subheadline.bold()); Spacer(); Text("\(Int(working.progress * 100))%").font(.caption.monospacedDigit()).foregroundStyle(Theme.muted) }
                            ProgressView(value: working.progress).tint(Theme.blue2)
                        }.padding(.top, 8)
                    }
                    if let error = model.error { Text(error).font(.footnote).foregroundStyle(Theme.danger).padding(.top, 4) }
                }
                .frame(maxWidth: .infinity).padding(.vertical, 24).card()

                if !model.library.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Songs you've separated").font(.headline)
                        ForEach(model.library) { entry in
                            HStack {
                                Image(systemName: "music.note").frame(width: 36, height: 36).background(Theme.blue, in: RoundedRectangle(cornerRadius: 8))
                                VStack(alignment: .leading) { Text(entry.name).font(.subheadline.bold()).lineLimit(1); Text(format(entry.duration)).font(.caption).foregroundStyle(Theme.muted) }
                                Spacer()
                                Button(role: .destructive) { model.forget(entry) } label: { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(Theme.muted)
                            }
                            .contentShape(Rectangle())
                            .onTapGesture { model.open(entry: entry) }
                        }
                    }.card()
                }
                Text("Separation runs on this device and takes a few minutes per song. Keep Easy Stems open while it works.")
                    .font(.caption).foregroundStyle(Theme.muted).multilineTextAlignment(.center).padding(.horizontal)
            }.padding(16)
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.audio, .mpeg4Movie, .quickTimeMovie], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first { model.open(url: url) }
        }
    }
}

struct SongView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var player: StemPlayer
    @State private var scrub: Double? = nil
    @State private var shareItems: [URL] = []
    @State private var sharing = false

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                // Song card and transport
                VStack(spacing: 12) {
                    HStack {
                        VStack(alignment: .leading) { Text(model.song?.name ?? "").font(.headline).lineLimit(1); Text("\(format(player.position)) / \(format(player.duration))").font(.caption.monospacedDigit()).foregroundStyle(Theme.muted) }
                        Spacer()
                        Button { model.closeSong() } label: { Label("Home", systemImage: "chevron.left") }.buttonStyle(.bordered)
                    }
                    Slider(value: Binding(get: { scrub ?? player.position }, set: { scrub = $0 }), in: 0...max(1, player.duration)) { editing in
                        if !editing, let s = scrub { player.seek(s); scrub = nil }
                    }
                    HStack(spacing: 18) {
                        Button { player.seek(player.position - 10) } label: { Image(systemName: "gobackward.10").font(.title2) }
                        Button { player.playing ? player.pause() : player.play() } label: {
                            Image(systemName: player.playing ? "pause.fill" : "play.fill").font(.title).frame(width: 60, height: 60).background(Theme.blue, in: Circle())
                        }
                        Button { player.seek(player.position + 10) } label: { Image(systemName: "goforward.10").font(.title2) }
                        Button { player.stop() } label: { Image(systemName: "stop.fill").font(.title2) }
                    }.foregroundStyle(.white).disabled(model.stems.isEmpty)
                }.card()

                if let working = model.working {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { ProgressView().tint(Theme.blue2); Text(working.label).font(.subheadline.bold()); Spacer(); Text("\(Int(working.progress * 100))%").font(.caption.monospacedDigit()).foregroundStyle(Theme.muted) }
                        ProgressView(value: working.progress).tint(Theme.blue2)
                        Text("Keep the app open; iOS pauses the work when it goes to the background.").font(.caption).foregroundStyle(Theme.muted)
                    }.card()
                }
                if let error = model.error { Text(error).font(.footnote).foregroundStyle(Theme.danger).card() }

                if !model.stems.isEmpty {
                    VStack(spacing: 0) {
                        HStack { Text("Stems").font(.headline); Spacer(); Button("Select all") { model.selectAll() }.font(.caption) }.padding(.bottom, 8)
                        ForEach(model.stems) { stem in StemRow(stem: stem) }
                    }.card()

                    HStack(spacing: 12) {
                        Button { shareItems = model.exportFiles(mix: false); sharing = !shareItems.isEmpty } label: { Label("Export stems", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
                        Button { shareItems = model.exportFiles(mix: true); sharing = !shareItems.isEmpty } label: { Label("Export mix", systemImage: "waveform").frame(maxWidth: .infinity) }.buttonStyle(.bordered)
                    }.disabled(!model.stems.contains { $0.on })
                }
            }.padding(16)
        }
        .sheet(isPresented: $sharing) { ShareSheet(items: shareItems) }
    }
}

struct StemRow: View {
    @EnvironmentObject var model: AppModel
    let stem: Stem
    var body: some View {
        let soloed = model.stems.allSatisfy { $0.on == ($0.key == stem.key) }
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: Theme.stemIcon(stem.key)).frame(width: 34, height: 34).background(Theme.stemColor(stem.key), in: RoundedRectangle(cornerRadius: 8)).foregroundStyle(.white)
                Toggle("", isOn: Binding(get: { stem.on }, set: { _ in model.toggle(stem.key) })).labelsHidden().tint(Theme.blue)
                Text(Theme.stemLabel(stem.key)).font(.subheadline.weight(.medium)).opacity(stem.on ? 1 : 0.5)
                Spacer()
                Button("Solo") { model.solo(stem.key) }.font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 6)
                    .background(soloed ? Theme.amber : Theme.panel2, in: RoundedRectangle(cornerRadius: 8)).foregroundStyle(soloed ? .black : .white)
                Button { model.auditionToggle(stem.key) } label: { Image(systemName: "headphones").padding(6) }
                    .background(model.audition == stem.key ? Theme.blue.opacity(0.3) : Theme.panel2, in: RoundedRectangle(cornerRadius: 8))
            }
            HStack(spacing: 8) {
                WaveformView(peaks: stem.peaks, color: Theme.stemColor(stem.key)).frame(height: 26).opacity(stem.on ? 1 : 0.4)
                Slider(value: Binding(get: { Double(stem.gain) }, set: { model.setGain(stem.key, Float($0)) }), in: -24...12, step: 0.5).frame(width: 120)
                Text(String(format: "%@%.1f dB", stem.gain > 0 ? "+" : "", stem.gain)).font(.caption2.monospacedDigit()).foregroundStyle(Theme.muted).frame(width: 56, alignment: .trailing)
            }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}

struct WaveformView: View {
    let peaks: [Float]
    let color: Color
    var body: some View {
        Canvas { ctx, size in
            let n = peaks.count
            guard n > 0 else { return }
            let w = size.width / CGFloat(n)
            for (i, p) in peaks.enumerated() {
                let h = max(1, CGFloat(p) * (size.height - 2))
                ctx.fill(Path(CGRect(x: CGFloat(i) * w, y: (size.height - h) / 2, width: max(1, w - 1), height: h)), with: .color(color))
            }
        }
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [URL]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

func format(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let s = Int(seconds)
    return String(format: "%d:%02d", s / 60, s % 60)
}
