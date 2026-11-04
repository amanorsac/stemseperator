import Foundation

/// The separation network, fetched once and kept.
final class ModelStore: @unchecked Sendable {
    static let file = "htdemucs_6s_fp16weights.onnx"
    static let url = URL(string: "https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx")!
    static let bytes: Int64 = 136 * 1024 * 1024

    var path: URL { Paths.models.appendingPathComponent(Self.file) }
    var ready: Bool {
        let size = (try? FileManager.default.attributesOfItem(atPath: path.path)[.size] as? Int64) ?? 0
        return size > 100 * 1024 * 1024
    }

    func ensure(progress: @escaping @MainActor (Double) -> Void) async throws {
        if ready { return }
        let (stream, response) = try await URLSession.shared.bytes(from: Self.url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "EasyStems", code: 10, userInfo: [NSLocalizedDescriptionKey: "The model download failed. Check the connection and try again."])
        }
        let total = max(response.expectedContentLength, Self.bytes)
        let partial = path.appendingPathExtension("part")
        FileManager.default.createFile(atPath: partial.path, contents: nil)
        let handle = try FileHandle(forWritingTo: partial)
        defer { try? handle.close() }
        var buffer = Data(); buffer.reserveCapacity(1 << 20)
        var received: Int64 = 0
        for try await byte in stream {
            buffer.append(byte)
            if buffer.count >= 1 << 20 {
                try handle.write(contentsOf: buffer); received += Int64(buffer.count); buffer.removeAll(keepingCapacity: true)
                let fraction = min(1, Double(received) / Double(total))
                await progress(fraction)
            }
        }
        try handle.write(contentsOf: buffer); received += Int64(buffer.count)
        try? FileManager.default.removeItem(at: path)
        try FileManager.default.moveItem(at: partial, to: path)
        await progress(1)
    }
}
