import Foundation
import OnnxRuntimeBindings

/// HT-Demucs through ONNX Runtime, piece by piece, as the desktop app does
/// it: 7.8-second pieces overlapping by an eighth, cross-faded, summed and
/// renormalised. Six stems out, written as WAVs under the song's fingerprint.
final class Separator: @unchecked Sendable {
    static let stems = ["drums", "bass", "other", "vocals", "guitar", "piano"]
    static let segment = 343980
    static let overlap = 343980 / 8
    static var stride: Int { segment - overlap }

    private let modelPath: URL
    private var session: ORTSession?
    private var env: ORTEnv?

    init(modelPath: URL) { self.modelPath = modelPath }

    private func open() throws -> ORTSession {
        if let session { return session }
        let env = try ORTEnv(loggingLevel: .warning)
        let options = try ORTSessionOptions()
        try options.setGraphOptimizationLevel(.all)
        try options.setIntraOpNumThreads(Int32(max(1, ProcessInfo.processInfo.activeProcessorCount - 1)))
        let session = try ORTSession(env: env, modelPath: modelPath.path, sessionOptions: options)
        self.env = env
        self.session = session
        return session
    }

    /// Resolves with the folder the stems were written to.
    func separate(left: [Float], right: [Float], id: String, progress: @escaping (Double) -> Void, cancelled: @escaping () -> Bool) throws -> URL {
        let folder = Paths.stemFolder(id)
        let done = Self.stems.allSatisfy { FileManager.default.fileExists(atPath: folder.appendingPathComponent("\($0).wav").path) }
        if done { progress(1); return folder }

        let session = try open()
        let total = left.count
        let seg = Self.segment
        let count = max(1, Int(ceil(Double(total) / Double(Self.stride))))
        var window = [Float](repeating: 1, count: seg)
        for i in 0..<Self.overlap {
            let fade = Float(i) / Float(Self.overlap - 1)
            window[i] = fade; window[seg - 1 - i] = fade
        }
        var out = Array(repeating: ([Float](repeating: 0, count: total), [Float](repeating: 0, count: total)), count: Self.stems.count)
        var weight = [Float](repeating: 0, count: total)
        var input = [Float](repeating: 0, count: 2 * seg)

        for c in 0..<count {
            if cancelled() { throw CancellationError() }
            let start = c * Self.stride
            let length = min(seg, total - start)
            if length <= 0 { break }
            for i in 0..<(2 * seg) { input[i] = 0 }
            for i in 0..<length { input[i] = left[start + i]; input[seg + i] = right[start + i] }
            let data = NSMutableData(bytes: input, length: input.count * MemoryLayout<Float>.size)
            let tensor = try ORTValue(tensorData: data, elementType: .float, shape: [1, 2, NSNumber(value: seg)])
            let result = try session.run(withInputs: ["mix": tensor], outputNames: ["stems"], runOptions: nil)
            guard let stemsValue = result["stems"] else { throw NSError(domain: "EasyStems", code: 20, userInfo: [NSLocalizedDescriptionKey: "The network returned nothing."]) }
            let bytes = try stemsValue.tensorData() as Data
            bytes.withUnsafeBytes { raw in
                let p = raw.bindMemory(to: Float.self)
                for s in 0..<Self.stems.count {
                    let fromL = (s * 2) * seg, fromR = (s * 2 + 1) * seg
                    for i in 0..<length {
                        out[s].0[start + i] += p[fromL + i] * window[i]
                        out[s].1[start + i] += p[fromR + i] * window[i]
                    }
                }
            }
            for i in 0..<length { weight[start + i] += window[i] }
            progress(Double(c + 1) / Double(count) * 0.97)
        }
        for s in 0..<Self.stems.count {
            for i in 0..<total { let w = max(weight[i], 1e-3); out[s].0[i] /= w; out[s].1[i] /= w }
            try Wav.encode(left: out[s].0, right: out[s].1).write(to: folder.appendingPathComponent("\(Self.stems[s]).wav"))
        }
        progress(1)
        return folder
    }
}
