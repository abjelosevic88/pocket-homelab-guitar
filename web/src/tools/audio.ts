// Shared Web Audio for the tools: one AudioContext, a plucked-string voice
// (Karplus-Strong, rendered once per pitch and cached) and the metronome clicks.

let ctx: AudioContext | null = null

/** The tools' AudioContext, created on first use (after a tap, so browsers allow sound). */
export function audioContext(): AudioContext {
  if (!ctx || ctx.state === 'closed') {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new AC({ latencyHint: 'interactive' })
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

const plucks = new Map<string, AudioBuffer>()

/** A plucked string at this frequency: noise through a tuned delay line that loses energy each pass. */
function pluckBuffer(ac: AudioContext, freq: number): AudioBuffer {
  const key = `${ac.sampleRate}:${freq.toFixed(2)}`
  const cached = plucks.get(key)
  if (cached) return cached
  const sr = ac.sampleRate
  const seconds = freq < 100 ? 3.2 : 2.6
  const len = Math.floor(sr * seconds)
  const buf = ac.createBuffer(1, len, sr)
  const out = buf.getChannelData(0)
  // the loop delays by n − ½ samples (the two-tap average) plus an all-pass
  // for the fraction that keeps the pitch exact
  const period = sr / freq
  const n = Math.floor(period + 0.5)
  const frac = period + 0.5 - n
  const c = (1 - frac) / (1 + frac)
  const ring = new Float32Array(n)
  // a softened noise burst (a pick, not a hammer)
  let prev = 0
  for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; prev = prev * 0.45 + w * 0.55; ring[i] = prev }
  const decay = freq < 100 ? 0.9985 : 0.996
  let idx = 0, apX = 0, apY = 0
  for (let i = 0; i < len; i++) {
    const cur = ring[idx]
    const next = ring[(idx + 1) % n]
    const lp = decay * 0.5 * (cur + next)
    const y = c * lp + apX - c * apY
    apX = lp; apY = y
    ring[idx] = y
    idx = (idx + 1) % n
    out[i] = cur
  }
  // fade the tail so it never clicks
  const fade = Math.floor(sr * 0.08)
  for (let i = 0; i < fade; i++) out[len - 1 - i] *= i / fade
  // normalise
  let peak = 0
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0) for (let i = 0; i < len; i++) out[i] = (out[i] / peak) * 0.8
  plucks.set(key, buf)
  return buf
}

let lastPluck: { src: AudioBufferSourceNode; gain: GainNode } | null = null

/** Play a reference string. A new pluck stops the previous one, like a fretting hand would. */
export function pluck(freq: number, volume = 0.8) {
  const ac = audioContext()
  if (lastPluck) {
    const { src, gain } = lastPluck
    gain.gain.setTargetAtTime(0, ac.currentTime, 0.03)
    src.stop(ac.currentTime + 0.2)
  }
  const src = ac.createBufferSource()
  src.buffer = pluckBuffer(ac, freq)
  const gain = ac.createGain()
  gain.gain.value = volume
  // a gentle body resonance
  const body = ac.createBiquadFilter()
  body.type = 'lowpass'
  body.frequency.value = Math.min(9000, freq * 14)
  src.connect(body).connect(gain).connect(ac.destination)
  src.start()
  lastPluck = { src, gain }
  src.onended = () => { if (lastPluck?.src === src) lastPluck = null }
}

// ---- metronome sounds ----

export type ClickSound = 'click' | 'wood' | 'beep'
export type ClickLevel = 'accent' | 'beat' | 'group' | 'sub'

let noise: AudioBuffer | null = null
function noiseBuffer(ac: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === ac.sampleRate) return noise
  const len = Math.floor(ac.sampleRate * 0.05)
  noise = ac.createBuffer(1, len, ac.sampleRate)
  const d = noise.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return noise
}

/** Schedule one click at an exact AudioContext time. */
export function scheduleClick(ac: AudioContext, dest: AudioNode, at: number, sound: ClickSound, level: ClickLevel) {
  const loud = level === 'accent' ? 1 : level === 'beat' ? 0.72 : level === 'group' ? 0.85 : 0.38
  const g = ac.createGain()
  g.connect(dest)
  if (sound === 'beep') {
    const o = ac.createOscillator()
    o.type = 'sine'
    o.frequency.value = level === 'accent' ? 1320 : level === 'sub' ? 660 : 880
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(loud * 0.6, at + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07)
    o.connect(g)
    o.start(at)
    o.stop(at + 0.09)
    return
  }
  if (sound === 'wood') {
    const src = ac.createBufferSource()
    src.buffer = noiseBuffer(ac)
    const bp = ac.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = level === 'accent' ? 1900 : level === 'sub' ? 1100 : 1400
    bp.Q.value = 9
    g.gain.setValueAtTime(loud * 2.2, at)
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.045)
    src.connect(bp).connect(g)
    src.start(at)
    src.stop(at + 0.05)
    return
  }
  // click: a short tone with a noisy attack
  const o = ac.createOscillator()
  o.type = 'triangle'
  o.frequency.value = level === 'accent' ? 2000 : level === 'sub' ? 1100 : 1500
  g.gain.setValueAtTime(0, at)
  g.gain.linearRampToValueAtTime(loud * 0.75, at + 0.001)
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.035)
  o.connect(g)
  o.start(at)
  o.stop(at + 0.05)
}
