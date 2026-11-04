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
            let frame = AVAudioFramePosition(startOffset * 44100)
            let remaining = AVAudioFrameCount(max(0, Int64(t.buffer.frameLength) - frame))
            if remaining == 0 { continue }
            t.node.volume = t.gain
            t.node.scheduleSegment(t.buffer, startingFrame: frame, frameCount: remaining, at: nil)
            t.node.play(at: hostStart)
        }
        startedAt = hostStart
        playing = true
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
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
