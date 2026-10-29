// The metronome engine: a look-ahead scheduler on the AudioContext clock
// (a timer wakes every 25 ms and books the clicks of the next 120 ms at exact
// audio times), a speed trainer, and the time spent playing along.
// One engine for the whole tools page, so it keeps ticking while you look at
// the tuner or the timer.

import { audioContext, scheduleClick, type ClickLevel, type ClickSound } from './audio'

export type Subdivision = 1 | 2 | 3 | 4
export interface Meter { id: string; label: string; beats: number; unit: 4 | 8; groups: number[] }

/** Beats of the bar that get the group accent (6/8 → 1 and 4). */
export const METERS: Meter[] = [
  { id: '2/4', label: '2/4', beats: 2, unit: 4, groups: [0] },
  { id: '3/4', label: '3/4', beats: 3, unit: 4, groups: [0] },
  { id: '4/4', label: '4/4', beats: 4, unit: 4, groups: [0] },
  { id: '5/4', label: '5/4', beats: 5, unit: 4, groups: [0, 3] },
  { id: '6/8', label: '6/8', beats: 6, unit: 8, groups: [0, 3] },
  { id: '7/8', label: '7/8', beats: 7, unit: 8, groups: [0, 2, 4] },
  { id: '12/8', label: '12/8', beats: 12, unit: 8, groups: [0, 3, 6, 9] },
]
export const meterById = (id: string) => METERS.find(m => m.id === id) || METERS[2]

export interface MetronomeConfig {
  bpm: number; meter: string; accent: boolean; sub: Subdivision; sound: ClickSound; volume: number
  trainer: boolean; trainerStart: number; trainerStep: number; trainerEvery: number; trainerTarget: number
}

const KEY = 'pgt-metronome'
export const DEFAULTS: MetronomeConfig = {
  bpm: 90, meter: '4/4', accent: true, sub: 1, sound: 'click', volume: 0.8,
  trainer: false, trainerStart: 70, trainerStep: 5, trainerEvery: 4, trainerTarget: 120,
}
export const clampBpm = (v: number) => Math.max(20, Math.min(300, Math.round(v)))

export function loadConfig(): MetronomeConfig {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return { ...DEFAULTS } }
}

export interface MetronomeState {
  running: boolean
  bpm: number
  beat: number          // the beat sounding now (0-based), -1 when stopped
  bar: number           // bars played since start
  barsToStep: number    // bars until the trainer speeds up (0 when it is off or done)
  playedS: number       // seconds played since the page opened (counts while running)
  firstStart: string    // when the counted time began (ISO), '' if never
}

type Listener = (s: MetronomeState) => void

class Engine {
  cfg: MetronomeConfig = loadConfig()
  private listeners = new Set<Listener>()
  private timer: number | null = null
  private nextTime = 0
  private tick = 0          // subdivision tick within the bar
  private bar = 0
  private barsAtBpm = 0
  private gain: GainNode | null = null
  private queue: { at: number; beat: number }[] = []
  private raf = 0
  private beatNow = -1
  private runningSince = 0
  private playedBefore = 0
  private firstStart = ''

  get running() { return this.timer !== null }

  state(): MetronomeState {
    const t = this.cfg.trainer && this.running && this.cfg.bpm < this.cfg.trainerTarget ? Math.max(1, this.cfg.trainerEvery - this.barsAtBpm) : 0
    return { running: this.running, bpm: this.cfg.bpm, beat: this.beatNow, bar: this.bar, barsToStep: t, playedS: this.played(), firstStart: this.firstStart }
  }

  played(): number { return this.playedBefore + (this.runningSince ? (performance.now() - this.runningSince) / 1000 : 0) }

  subscribe(l: Listener) { this.listeners.add(l); l(this.state()); return () => { this.listeners.delete(l) } }
  private emit() { const s = this.state(); this.listeners.forEach(l => l(s)) }

  set(patch: Partial<MetronomeConfig>) {
    this.cfg = { ...this.cfg, ...patch, bpm: clampBpm(patch.bpm ?? this.cfg.bpm) }
    if (this.gain) this.gain.gain.value = this.cfg.volume
    if (patch.bpm !== undefined) this.barsAtBpm = 0
    localStorage.setItem(KEY, JSON.stringify(this.cfg))
    this.emit()
  }

  start() {
    if (this.running) return
    const ac = audioContext()
    this.gain = ac.createGain()
    this.gain.gain.value = this.cfg.volume
    this.gain.connect(ac.destination)
    if (this.cfg.trainer) this.cfg = { ...this.cfg, bpm: clampBpm(this.cfg.trainerStart) }
    this.tick = 0; this.bar = 0; this.barsAtBpm = 0; this.queue = []
    this.nextTime = ac.currentTime + 0.08
    this.runningSince = performance.now()
    if (!this.firstStart) this.firstStart = new Date().toISOString()
    this.timer = window.setInterval(() => this.schedule(), 25)
    this.schedule()
    this.raf = requestAnimationFrame(this.draw)
    this.emit()
  }

  stop() {
    if (!this.running) return
    window.clearInterval(this.timer!)
    this.timer = null
    cancelAnimationFrame(this.raf)
    this.playedBefore = this.played()
    this.runningSince = 0
    const g = this.gain
    this.gain = null
    if (g) { try { g.gain.setTargetAtTime(0, audioContext().currentTime, 0.01); setTimeout(() => g.disconnect(), 200) } catch { /* closed */ } }
    this.beatNow = -1
    this.queue = []
    this.emit()
  }

  toggle() { if (this.running) this.stop(); else this.start() }

  /** The counted time was saved (or thrown away): start counting from zero. */
  resetPlayed() {
    this.playedBefore = 0
    this.runningSince = this.running ? performance.now() : 0
    this.firstStart = this.running ? new Date().toISOString() : ''
    this.emit()
  }

  private schedule() {
    const ac = audioContext()
    const m = meterById(this.cfg.meter)
    const sub = this.cfg.sub
    while (this.nextTime < ac.currentTime + 0.12) {
      const beat = Math.floor(this.tick / sub)
      const onBeat = this.tick % sub === 0
      let level: ClickLevel = 'sub'
      if (onBeat) level = beat === 0 && this.cfg.accent ? 'accent' : this.cfg.accent && m.groups.includes(beat) ? 'group' : 'beat'
      if (this.gain) scheduleClick(ac, this.gain, this.nextTime, this.cfg.sound, level)
      if (onBeat) this.queue.push({ at: this.nextTime, beat })
      // the beat unit: quarter notes at bpm; in x/8 meters each eighth is a beat at bpm
      this.nextTime += 60 / this.cfg.bpm / sub
      this.tick++
      if (this.tick >= m.beats * sub) {
        this.tick = 0
        this.bar++
        this.barsAtBpm++
        if (this.cfg.trainer && this.barsAtBpm >= this.cfg.trainerEvery && this.cfg.bpm < this.cfg.trainerTarget) {
          this.cfg = { ...this.cfg, bpm: clampBpm(Math.min(this.cfg.trainerTarget, this.cfg.bpm + this.cfg.trainerStep)) }
          this.barsAtBpm = 0
          localStorage.setItem(KEY, JSON.stringify(this.cfg))
        }
      }
    }
  }

  private lastEmit = 0
  private draw = () => {
    const ac = audioContext()
    let changed = false
    while (this.queue.length && this.queue[0].at <= ac.currentTime) {
      this.beatNow = this.queue.shift()!.beat
      changed = true
    }
    const now = performance.now()
    if (changed || now - this.lastEmit > 500) { this.lastEmit = now; this.emit() }
    if (this.running) this.raf = requestAnimationFrame(this.draw)
  }
}

export const metronome = new Engine()
