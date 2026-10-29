// Pitch detection for the tuner: YIN (de Cheveigné & Kawahara) on a
// downsampled frame, with a noise gate and a small median filter on top.

export interface PitchResult { freq: number; clarity: number; rms: number }

/** One frame → a frequency, or null when it is too quiet or not a clear tone. */
export function detectPitch(frame: Float32Array, sampleRate: number, minFreq = 27, maxFreq = 1400, threshold = 0.12): PitchResult | null {
  // downsample by two (simple average): halves the work, still fine up to ~6 kHz
  const n = frame.length >> 1
  const x = new Float32Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) { const v = (frame[2 * i] + frame[2 * i + 1]) * 0.5; x[i] = v; sum += v * v }
  const sr = sampleRate / 2
  const rms = Math.sqrt(sum / n)
  if (rms < 0.006) return null
  const tauMin = Math.max(2, Math.floor(sr / maxFreq))
  const tauMax = Math.min(Math.floor(sr / minFreq), Math.floor(n / 2))
  const w = n - tauMax
  if (w < 64) return null
  const d = new Float32Array(tauMax + 1)
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0
    for (let i = 0; i < w; i++) { const diff = x[i] - x[i + tau]; s += diff * diff }
    d[tau] = s
  }
  // cumulative mean normalised difference
  const c = new Float32Array(tauMax + 1)
  c[0] = 1
  let run = 0
  for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; c[tau] = run > 0 ? (d[tau] * tau) / run : 1 }
  let tau = -1
  for (let t = tauMin; t <= tauMax; t++) {
    if (c[t] < threshold) {
      while (t + 1 <= tauMax && c[t + 1] < c[t]) t++
      tau = t
      break
    }
  }
  if (tau < 0) {
    // no dip under the threshold: take the global minimum if it is reasonably clear
    let best = tauMin
    for (let t = tauMin; t <= tauMax; t++) if (c[t] < c[best]) best = t
    if (c[best] > 0.3) return null
    tau = best
  }
  // parabolic interpolation around the dip
  let betterTau = tau
  if (tau > 1 && tau < tauMax) {
    const a = c[tau - 1], b = c[tau], cc = c[tau + 1]
    const den = a + cc - 2 * b
    if (den !== 0) betterTau = tau + (a - cc) / (2 * den)
  }
  let freq = sr / betterTau
  // high notes: a few samples per period at the reduced rate; refine at the full rate
  if (freq > 250) {
    const centre = Math.round(sampleRate / freq)
    const lo = Math.max(2, centre - 4), hi = centre + 4
    const win = Math.min(frame.length - hi - 1, 4096)
    const diff = (t: number) => { let s = 0; for (let i = 0; i < win; i++) { const v = frame[i] - frame[i + t]; s += v * v } return s }
    let bt = lo, bv = Infinity
    const vals: number[] = []
    for (let t = lo; t <= hi; t++) { const v = diff(t); vals.push(v); if (v < bv) { bv = v; bt = t } }
    const k = bt - lo
    let ft = bt
    if (k > 0 && k < vals.length - 1) { const a = vals[k - 1], b = vals[k], c2 = vals[k + 1]; const den = a + c2 - 2 * b; if (den > 0) ft = bt + (a - c2) / (2 * den) }
    freq = sampleRate / ft
  }
  if (freq < minFreq || freq > maxFreq) return null
  return { freq, clarity: 1 - Math.min(1, c[tau]), rms }
}

/** Keeps the last few readings and answers their median, dropping stray octave jumps. */
export class PitchSmoother {
  private buf: number[] = []
  private size: number
  constructor(size = 5) { this.size = size }
  push(f: number): number {
    const last = this.median()
    if (last && (f / last > 1.9 || last / f > 1.9) && this.buf.length >= 3) {
      // an octave jump: trust it only when it repeats
      this.buf.push(f)
      if (this.buf.length > this.size) this.buf.shift()
      return last
    }
    this.buf.push(f)
    if (this.buf.length > this.size) this.buf.shift()
    return this.median()
  }
  median(): number {
    if (!this.buf.length) return 0
    const s = [...this.buf].sort((a, b) => a - b)
    return s[s.length >> 1]
  }
  reset() { this.buf = [] }
}
