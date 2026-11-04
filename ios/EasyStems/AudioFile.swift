import Foundation
import AVFAudio

/// Any audio file the system can read, as 44.1 kHz stereo floats.
enum AudioDecoder {
    static func decode(_ url: URL) throws -> (left: [Float], right: [Float], duration: Double) {
        let file = try AVAudioFile(forReading: url)
        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44100, channels: 2, interleaved: false) else {
            throw NSError(domain: "EasyStems", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not set up the decoder."])
        }
        let source = file.processingFormat
        let ratio = 44100 / source.sampleRate
        let outFrames = AVAudioFrameCount(Double(file.length) * ratio + 1024)
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: outFrames) else {
            throw NSError(domain: "EasyStems", code: 2, userInfo: [NSLocalizedDescriptionKey: "That file is too large to open."])
        }
        guard let converter = AVAudioConverter(from: source, to: target) else {
            throw NSError(domain: "EasyStems", code: 3, userInfo: [NSLocalizedDescriptionKey: "That file could not be converted."])
        }
        guard let inBuffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: 8192) else {
            throw NSError(domain: "EasyStems", code: 4, userInfo: [NSLocalizedDescriptionKey: "That file could not be read."])
        }
        var done = false
        var readError: Error?
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            if done { outStatus.pointee = .endOfStream; return nil }
            do {
                try file.read(into: inBuffer)
            } catch { readError = error; outStatus.pointee = .endOfStream; return nil }
            if inBuffer.frameLength == 0 { done = true; outStatus.pointee = .endOfStream; return nil }
            outStatus.pointee = .haveData
            return inBuffer
        }
        if let readError { throw readError }
        if status == .error, let error { throw error }
        let n = Int(out.frameLength)
        let l = Array(UnsafeBufferPointer(start: out.floatChannelData![0], count: n))
        let r = Array(UnsafeBufferPointer(start: out.floatChannelData![1], count: n))
        return (l, r, Double(n) / 44100)
    }
}
