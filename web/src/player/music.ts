// Music helpers: note and tuning names, instrument names, and what the page
// reports back to the server about a file after reading it (the analysis).
import type { AT } from './alphatab'
import type { Analysis, TabTrack } from '../lib/types'

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
export const noteName = (midi: number) => NAMES[((midi % 12) + 12) % 12]
export const noteWithOctave = (midi: number) => noteName(midi) + (Math.floor(midi / 12) - 1)

/** Tuning as MIDI notes, lowest string first (alphaTab lists the highest first). */
export function lowToHigh(staff: AT.model.Staff): number[] { return [...staff.tuning].reverse() }

const SHAPES: { name: (low: number) => string; low?: number; steps: number[] }[] = [
  { name: l => (l === 40 ? 'Standard' : `${noteName(l)} Standard`), steps: [5, 5, 5, 4, 5] },
  { name: l => `Drop ${noteName(l)}`, steps: [7, 5, 5, 4, 5] },
  { name: () => 'DADGAD', low: 38, steps: [7, 5, 5, 2, 5] },
  { name: () => 'Open G', low: 38, steps: [5, 7, 5, 4, 3] },
  { name: () => 'Open D', low: 38, steps: [7, 5, 4, 3, 5] },
  { name: () => 'Open E', low: 40, steps: [7, 5, 4, 3, 5] },
  { name: () => 'Open C', low: 36, steps: [7, 5, 7, 5, 4] },
  { name: l => (l === 35 ? '7-string Standard' : `7-string ${noteName(l)} Standard`), steps: [5, 5, 5, 5, 4, 5] },
  { name: l => `7-string Drop ${noteName(l)}`, steps: [7, 5, 5, 5, 4, 5] },
  { name: l => (l === 30 ? '8-string Standard' : `8-string ${noteName(l)} Standard`), steps: [5, 5, 5, 5, 5, 4, 5] },
  { name: l => (l === 28 ? 'Bass Standard' : `Bass ${noteName(l)} Standard`), steps: [5, 5, 5] },
  { name: l => `Bass Drop ${noteName(l)}`, steps: [7, 5, 5] },
  { name: l => (l === 23 ? '5-string Bass' : `5-string Bass ${noteName(l)}`), steps: [5, 5, 5, 5] },
]

/** A plain tuning name: "Standard", "Drop D", "Eb Standard", "DADGAD" — or the notes. */
export function tuningName(notesLowHigh: number[]): string {
  if (!notesLowHigh.length) return ''
  const steps = notesLowHigh.slice(1).map((n, i) => n - notesLowHigh[i])
  const low = notesLowHigh[0]
  for (const s of SHAPES) {
    if (s.steps.length === steps.length && s.steps.every((v, i) => v === steps[i]) && (s.low === undefined || s.low === low)) return s.name(low)
  }
  return notesLowHigh.map(noteName).join(' ')
}

const GUITARS = ['Nylon guitar', 'Steel guitar', 'Jazz guitar', 'Clean guitar', 'Muted guitar', 'Overdriven guitar', 'Distortion guitar', 'Guitar harmonics']
const BASSES = ['Acoustic bass', 'Fingered bass', 'Picked bass', 'Fretless bass', 'Slap bass', 'Slap bass', 'Synth bass', 'Synth bass']
const FAMILIES = ['Piano', 'Chromatic percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass', 'Reed', 'Pipe', 'Synth lead', 'Synth pad', 'Synth effects', 'Ethnic', 'Percussive', 'Sound effects']

export function instrumentName(track: AT.model.Track): string {
  if (track.isPercussion || track.staves[0]?.isPercussion) return 'Drums'
  const p = track.playbackInfo.program
  if (p >= 24 && p <= 31) return GUITARS[p - 24]
  if (p >= 32 && p <= 39) return BASSES[p - 32]
  if (p === 29 || p === 30) return 'Electric guitar'
  return FAMILIES[Math.floor(p / 8)] || 'Instrument'
}

/** A fretted track: guitars, basses, banjo and friends (not a piano or a voice that happens to have a tab staff). */
export function isGuitarLike(track: AT.model.Track): boolean {
  const st = track.staves[0]
  if (!st || st.isPercussion || !st.isStringed || !st.tuning.length) return false
  const p = track.playbackInfo.program
  return (p >= 24 && p <= 39) || (p >= 104 && p <= 107) || /guitar|bass|banjo|ukulele|mandolin/i.test(track.name)
}

export function trackInfo(track: AT.model.Track): TabTrack {
  const st = track.staves[0]
  const drums = !!(track.isPercussion || st?.isPercussion)
  const strings = !drums && st?.isStringed ? st.tuning.length : 0
  return {
    index: track.index, name: track.name || instrumentName(track), instrument: instrumentName(track),
    strings, tuning: strings ? lowToHigh(st).map(noteName).join(' ') : '', drums,
  }
}

/** The track a guitarist most likely wants first: the first guitar, else the first stringed track. */
export function mainTrack(score: AT.model.Score): number {
  const guitar = score.tracks.find(t => isGuitarLike(t) && t.playbackInfo.program >= 24 && t.playbackInfo.program <= 31)
  return (guitar || score.tracks.find(isGuitarLike) || score.tracks[0])?.index ?? 0
}

/** A real name, not the placeholders files carry ("-", "Unknown", "untitled"). */
function meta(v: string | undefined): string | undefined {
  const t = (v || '').replace(/\uFFFD/g, '').trim()
  if (!t || /^[-–—_.?\s]+$/.test(t) || /^(unknown|untitled|none|n\/a)$/i.test(t)) return undefined
  return t
}

export function analyse(score: AT.model.Score, durationMs: number): Analysis {
  const main = score.tracks[mainTrack(score)]
  return {
    title: meta(score.title),
    artist: meta(score.artist),
    album: meta(score.album),
    tabber: meta(score.tab),
    tempo: Math.round(score.tempo || 0),
    bars: score.masterBars.length,
    duration_s: Math.round(durationMs / 1000),
    tracks: score.tracks.map(trackInfo),
    tuning: main && isGuitarLike(main) ? tuningName(lowToHigh(main.staves[0])) : '',
  }
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
export function fmtMinutes(sec: number): string {
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

/** Local time with offset, the form the server stores ("2026-10-29T08:15:00+01:00"). */
export function localISO(d = new Date()): string {
  const off = -d.getTimezoneOffset()
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`
}
export function localDate(d = new Date()): string { return localISO(d).slice(0, 10) }

export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'x'.repeat(32).replace(/x/g, () => Math.floor(Math.random() * 16).toString(16))
}
