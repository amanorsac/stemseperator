import Foundation
import AVFAudio

/// Every stem its own player node into the mixer, started on one clock, so
/// mute, solo and levels are gain changes and seeking is the only restart.
@MainActor
final class StemPlayer: ObservableObject {
    struct Track { let key: String; let buffer: AVAudioPCMBuffer; let node: AVAudioPlayerNode; var gain: Float }

    @Published private(set) var playing = false
    @Published private(set) var duration: Double = 0
    private let engine = AVAudioEngine()
    private var tracks: [Track] = []
    private var startOffset: Double = 0
    private var startedAt: AVAudioTime?
    private var sampleRate: Double = 44100
    private var ticker: Timer?
    @Published var position: Double = 0

    func load(stems: [(key: String, left: [Float], right: [Float])]) {
        stop()
        tracks.forEach { engine.detach($0.node) }
        tracks = []
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2, interleaved: false) else { return }
        for stem in stems {
            let n = AVAudioFrameCount(stem.left.count)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n) else { continue }
            buffer.frameLength = n
            stem.left.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: Int(n)) }
            stem.right.withUnsafeBufferPointer { buffer.floatChannelData![1].update(from: $0.baseAddress!, count: Int(n)) }
            let node = AVAudioPlayerNode()
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: format)
            tracks.append(Track(key: stem.key, buffer: buffer, node: node, gain: 1))
        }
        duration = tracks.map { Double($0.buffer.frameLength) / 44100 }.max() ?? 0
        startOffset = 0
        position = 0
    }

    func setGain(_ key: String, _ gain: Float) {
        guard let i = tracks.firstIndex(where: { $0.key == key }) else { return }
        tracks[i].gain = gain
        tracks[i].node.volume = gain
    }

    func play() {
        guard !tracks.isEmpty, !playing else { return }
        if startOffset >= duration - 0.01 { startOffset = 0 }
        if !engine.isRunning { try? engine.start() }
        // One start time for every node, a little ahead so all are scheduled first.
        let hostStart = AVAudioTime(hostTime: mach_absolute_time() + AVAudioTime.hostTime(forSeconds: 0.05))
        for t in tracks {
            let frame = AVAudioFrameCount(startOffset * 44100)
            guard frame < t.buffer.frameLength, let rest = Self.slice(t.buffer, from: frame) else { continue }
            t.node.volume = t.gain
            t.node.scheduleBuffer(rest, at: nil, options: [], completionHandler: nil)
            t.node.play(at: hostStart)
        }
        startedAt = hostStart
        playing = true
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    /// The tail of a buffer from a frame on, since a player node cannot start
    /// a buffer part-way through.
    private static func slice(_ buffer: AVAudioPCMBuffer, from frame: AVAudioFrameCount) -> AVAudioPCMBuffer? {
        let count = buffer.frameLength - frame
        guard count > 0, let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: count) else { return nil }
        out.frameLength = count
        for ch in 0..<Int(buffer.format.channelCount) {
            out.floatChannelData![ch].update(from: buffer.floatChannelData![ch] + Int(frame), count: Int(count))
        }
        return out
    }

    /// A stem's samples back out, for export.
    func samples(_ key: String) -> (left: [Float], right: [Float])? {
        guard let t = tracks.first(where: { $0.key == key }) else { return nil }
        let n = Int(t.buffer.frameLength)
        return (Array(UnsafeBufferPointer(start: t.buffer.floatChannelData![0], count: n)),
                Array(UnsafeBufferPointer(start: t.buffer.floatChannelData![1], count: n)))
    }

    private func tick() {
        guard playing, let startedAt else { return }
        let elapsed = AVAudioTime.seconds(forHostTime: mach_absolute_time()) - AVAudioTime.seconds(forHostTime: startedAt.hostTime)
        position = min(duration, startOffset + max(0, elapsed))
        if position >= duration - 0.02 { stop(); position = duration; startOffset = duration }
    }

    func pause() {
        guard playing else { return }
        tick()
        startOffset = position
        stopNodes()
    }

    func stop() {
        stopNodes()
        startOffset = 0
        position = 0
    }

    func seek(_ seconds: Double) {
        let was = playing
        stopNodes()
        startOffset = max(0, min(duration, seconds))
        position = startOffset
        if was { play() }
    }

    private func stopNodes() {
        tracks.forEach { $0.node.stop() }
        playing = false
        ticker?.invalidate(); ticker = nil
    }
}
