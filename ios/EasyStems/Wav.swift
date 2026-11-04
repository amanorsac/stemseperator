import Foundation

/// 16-bit stereo WAV at 44.1 kHz, the form the stems are kept in.
enum Wav {
    static let rate: UInt32 = 44100

    static func encode(left: [Float], right: [Float]) -> Data {
        let frames = left.count
        var data = Data(capacity: 44 + frames * 4)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + frames * 4)); data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(2); u32(rate); u32(rate * 4); u16(4); u16(16)
        data.append(contentsOf: Array("data".utf8)); u32(UInt32(frames * 4))
        var pcm = [Int16](repeating: 0, count: frames * 2)
        for i in 0..<frames {
            pcm[i * 2] = Int16(max(-32768, min(32767, (left[i] * 32767).rounded())))
            pcm[i * 2 + 1] = Int16(max(-32768, min(32767, (right[i] * 32767).rounded())))
        }
        pcm.withUnsafeBytes { data.append(contentsOf: $0) }
        return data
    }

    /// One of our own files back to float channels.
    static func decode(_ url: URL) throws -> (left: [Float], right: [Float]) {
        let data = try Data(contentsOf: url)
        guard data.count > 44 else { return ([], []) }
        let frames = (data.count - 44) / 4
        var left = [Float](repeating: 0, count: frames)
        var right = [Float](repeating: 0, count: frames)
        data.withUnsafeBytes { raw in
            let pcm = raw.baseAddress!.advanced(by: 44).assumingMemoryBound(to: Int16.self)
            for i in 0..<frames {
                left[i] = Float(Int16(littleEndian: pcm[i * 2])) / 32768
                right[i] = Float(Int16(littleEndian: pcm[i * 2 + 1])) / 32768
            }
        }
        return (left, right)
    }
}
