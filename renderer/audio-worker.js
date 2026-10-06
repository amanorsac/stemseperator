/**
 * The page's own worker: turns stem files into float channels and
 * waveforms, mixes stems for export, and encodes WAVs — the loops over
 * forty million samples that would otherwise freeze the window.
 */
importScripts('audio-core.js');

self.onmessage = ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'decode') {
      // Past the 44-byte header, a WAV of this kind is nothing but samples.
      const samples = new Int16Array(data.bytes, 44, Math.floor((data.bytes.byteLength - 44) / 2));
      const [left, right] = int16ToChannels(samples);
      const peaks = peaksOfStereo(left, right, data.waveBuckets);
      const songPeaks = peaksOfStereo(left, right, data.songBuckets);
      self.postMessage({ id, result: { left, right, peaks, songPeaks } },
        [left.buffer, right.buffer, peaks.buffer, songPeaks.buffer]);
      return;
    }
    if (type === 'mix') {
      const [left, right] = mixChannels(data.parts);
      self.postMessage({ id, result: { left, right } }, [left.buffer, right.buffer]);
      return;
    }
    if (type === 'encode') {
      const bytes = encodeWav(data.left, data.right, data.rate, data.bits);
      self.postMessage({ id, result: bytes }, [bytes]);
      return;
    }
    throw new Error(`Unknown job: ${type}`);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
