import Foundation
import SwiftUI

struct LibraryEntry: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var duration: Double
    var savedAt: Date
}

/// A flag a background job polls, set from the main actor.
final class Flag: @unchecked Sendable { var set = false }

struct Stem: Identifiable, Sendable {
    let key: String
    var id: String { key }
    var on = true
    var gain: Float = 0   // dB
    let left: [Float]
    let right: [Float]
    let peaks: [Float]
}

/// The app's state and its flows: open, separate, mix, export, remember.
@MainActor
final class AppModel: ObservableObject {
    @Published var song: (id: String, name: String, duration: Double)?
    @Published var stems: [Stem] = []
    @Published var audition: String?
    @Published var working: (label: String, progress: Double)?
    @Published var error: String?
    @Published var library: [LibraryEntry] = []
    let player = StemPlayer()
    let models = ModelStore()
    private let cancel = Flag()
    private var libraryURL: URL { Paths.support.appendingPathComponent("library.json") }

    init() { loadLibrary() }

    // MARK: Library
    func loadLibrary() {
        library = (try? JSONDecoder().decode([LibraryEntry].self, from: Data(contentsOf: libraryURL))) ?? []
    }
    private func saveLibrary() {
        try? JSONEncoder().encode(library).write(to: libraryURL)
    }
    func forget(_ entry: LibraryEntry) {
        library.removeAll { $0.id == entry.id }
        saveLibrary()
        try? FileManager.default.removeItem(at: Paths.stems.appendingPathComponent(entry.id))
    }

    // MARK: Opening and separating
    func open(url: URL) {
        error = nil
        let name = url.deletingPathExtension().lastPathComponent
        let secured = url.startAccessingSecurityScopedResource()
        working = ("Reading the song…", 0)
        let stop = cancel
        stop.set = false
        let models = self.models
        Task { [weak self] in
            defer { if secured { url.stopAccessingSecurityScopedResource() } }
            do {
                let audio = try await Task.detached { try AudioDecoder.decode(url) }.value
                let id = await Task.detached { Fingerprint.of(left: audio.left, right: audio.right) }.value
                guard let self else { return }
                self.song = (id, name, audio.duration)
                self.working = ("Checking the model…", 0)
                try await models.ensure { [weak self] p in self?.working = ("Downloading the model…", p) }
                self.working = ("Separating the instruments…", 0)
                let separator = Separator(modelPath: models.path)
                let folder = try await Task.detached {
                    try separator.separate(left: audio.left, right: audio.right, id: id,
                        progress: { p in Task { @MainActor [weak self] in if self?.song?.id == id { self?.working = ("Separating the instruments…", p) } } },
                        cancelled: { stop.set })
                }.value
                guard self.song?.id == id else { return }
                try await self.loadStems(from: folder)
                self.working = nil
                self.library.removeAll { $0.id == id }
                self.library.insert(LibraryEntry(id: id, name: name, duration: audio.duration, savedAt: Date()), at: 0)
                self.saveLibrary()
            } catch is CancellationError {
                self?.working = nil
            } catch {
                self?.working = nil
                self?.error = error.localizedDescription
            }
        }
    }

    func open(entry: LibraryEntry) {
        error = nil
        song = (entry.id, entry.name, entry.duration)
        working = ("Opening the stems…", 0.5)
        Task { [weak self] in
            do {
                try await self?.loadStems(from: Paths.stems.appendingPathComponent(entry.id))
                self?.working = nil
            } catch {
                self?.working = nil
                self?.error = "That song's stems are no longer on the device. Open the file again to separate it."
            }
        }
    }

    private func loadStems(from folder: URL) async throws {
        let stems = try await Task.detached { () throws -> [Stem] in
            var loaded: [Stem] = []
            for key in ["drums", "bass", "guitar", "piano", "vocals", "other"] {
                let (l, r) = try Wav.decode(folder.appendingPathComponent("\(key).wav"))
                if l.isEmpty { throw NSError(domain: "EasyStems", code: 30, userInfo: [NSLocalizedDescriptionKey: "A stem file is missing."]) }
                loaded.append(Stem(key: key, left: l, right: r, peaks: AppModel.peaks(l, r, buckets: 120)))
            }
            return loaded
        }.value
        self.stems = stems
        self.audition = nil
        self.player.load(stems: stems.map { ($0.key, $0.left, $0.right) })
        self.applyGains()
    }

    static func peaks(_ l: [Float], _ r: [Float], buckets: Int) -> [Float] {
        guard !l.isEmpty else { return [Float](repeating: 0, count: buckets) }
        let per = max(1, l.count / buckets)
        var out = [Float](repeating: 0, count: buckets)
        var peak: Float = 0
        for b in 0..<buckets {
            var m: Float = 0
            let start = b * per, end = min(l.count, start + per)
            if start < end { for i in start..<end { m = max(m, abs(l[i]), abs(r[i])) } }
            out[b] = m; peak = max(peak, m)
        }
        return peak > 0 ? out.map { $0 / peak } : out
    }

    func closeSong() {
        cancel.set = true
        player.stop()
        song = nil
        stems = []
        audition = nil
        error = nil
        working = nil
    }

    // MARK: Mixer
    func liveGain(_ stem: Stem) -> Float {
        let heard = audition.map { $0 == stem.key } ?? stem.on
        return heard ? powf(10, stem.gain / 20) : 0
    }
    func applyGains() { stems.forEach { player.setGain($0.key, liveGain($0)) } }
    func toggle(_ key: String) { if let i = stems.firstIndex(where: { $0.key == key }) { stems[i].on.toggle(); applyGains() } }
    func solo(_ key: String) {
        let alone = stems.allSatisfy { $0.on == ($0.key == key) }
        for i in stems.indices { stems[i].on = alone ? true : stems[i].key == key }
        applyGains()
    }
    func auditionToggle(_ key: String) { audition = audition == key ? nil : key; applyGains() }
    func setGain(_ key: String, _ db: Float) { if let i = stems.firstIndex(where: { $0.key == key }) { stems[i].gain = db; applyGains() } }
    func selectAll() { for i in stems.indices { stems[i].on = true }; audition = nil; applyGains() }

    // MARK: Export
    /// WAV files for the chosen stems (or one mix of everything on), in a temp folder for the share sheet.
    func exportFiles(mix: Bool) -> [URL] {
        guard let song else { return [] }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("export-\(song.id)", isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let on = stems.filter { $0.on }
        var urls: [URL] = []
        if mix {
            let n = on.first?.left.count ?? 0
            var l = [Float](repeating: 0, count: n), r = [Float](repeating: 0, count: n)
            for s in on { let g = powf(10, s.gain / 20); for i in 0..<n { l[i] += s.left[i] * g; r[i] += s.right[i] * g } }
            let off = stems.filter { !$0.on }
            let label = off.isEmpty ? "Full mix" : (on.count == 1 ? "\(Theme.stemLabel(on[0].key)) only" : (off.count == 1 ? "No \(Theme.stemLabel(off[0].key))" : on.map { Theme.stemLabel($0.key) }.joined(separator: " + ")))
            let url = folder.appendingPathComponent("\(song.name) - \(label).wav")
            try? Wav.encode(left: l, right: r).write(to: url); urls.append(url)
        } else {
            for s in on {
                let g = powf(10, s.gain / 20)
                let url = folder.appendingPathComponent("\(song.name) - \(s.key == "other" ? "Aux" : Theme.stemLabel(s.key)).wav")
                try? Wav.encode(left: s.left.map { $0 * g }, right: s.right.map { $0 * g }).write(to: url); urls.append(url)
            }
        }
        return urls
    }
}
