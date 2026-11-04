import Foundation
import CryptoKit

/// The same fingerprint the desktop app uses: a spread of samples hashed, so
/// a renamed file is still the same song.
enum Fingerprint {
    static func of(left: [Float], right: [Float]) -> String {
        var hasher = Insecure.SHA1()
        hasher.update(data: Data(String(left.count).utf8))
        let step = max(1, left.count / 20000)
        var picked = [Float]()
        picked.reserveCapacity((left.count / step + 1) * 2)
        var i = 0
        while i < left.count { picked.append(left[i]); picked.append(right[i]); i += step }
        picked.withUnsafeBytes { hasher.update(bufferPointer: $0) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined().prefix(20).description
    }
}
