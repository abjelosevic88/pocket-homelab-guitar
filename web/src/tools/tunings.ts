// Notes and tunings for the tuner (strings listed low to high).

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']

/** MIDI number of a note like "E2", "Eb4", "F#3". */
export function midiOf(note: string): number {
  const m = /^([A-G])([#b♯♭]?)(-?\d)$/.exec(note.trim())
  if (!m) return 0
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as 'C']
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0
  return (Number(m[3]) + 1) * 12 + base + acc
}

export function freqOfMidi(midi: number, a4 = 440): number { return a4 * Math.pow(2, (midi - 69) / 12) }
export function midiOfFreq(freq: number, a4 = 440): number { return 69 + 12 * Math.log2(freq / a4) }

/** "E", 2 for MIDI 40; flats when the tuning is written with flats. */
export function noteName(midi: number, flats = false): { name: string; octave: number } {
  const m = Math.round(midi)
  const pc = ((m % 12) + 12) % 12
  return { name: (flats ? FLAT_NAMES : NOTE_NAMES)[pc], octave: Math.floor(m / 12) - 1 }
}

export interface Tuning { id: string; name: string; group: string; strings: string[]; flats?: boolean }

export const TUNINGS: Tuning[] = [
  { id: 'standard', name: 'Standard (E A D G B E)', group: 'Guitar', strings: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  { id: 'drop-d', name: 'Drop D', group: 'Guitar', strings: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  { id: 'eb', name: 'E♭ standard (half step down)', group: 'Guitar', strings: ['Eb2', 'Ab2', 'Db3', 'Gb3', 'Bb3', 'Eb4'], flats: true },
  { id: 'd-standard', name: 'D standard (whole step down)', group: 'Guitar', strings: ['D2', 'G2', 'C3', 'F3', 'A3', 'D4'] },
  { id: 'drop-c', name: 'Drop C', group: 'Guitar', strings: ['C2', 'G2', 'C3', 'F3', 'A3', 'D4'] },
  { id: 'dadgad', name: 'DADGAD', group: 'Guitar', strings: ['D2', 'A2', 'D3', 'G3', 'A3', 'D4'] },
  { id: 'open-g', name: 'Open G', group: 'Guitar', strings: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'] },
  { id: 'open-d', name: 'Open D', group: 'Guitar', strings: ['D2', 'A2', 'D3', 'F#3', 'A3', 'D4'] },
  { id: 'open-e', name: 'Open E', group: 'Guitar', strings: ['E2', 'B2', 'E3', 'G#3', 'B3', 'E4'] },
  { id: 'seven', name: '7-string standard (B)', group: 'Guitar', strings: ['B1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  { id: 'bass4', name: 'Bass, 4 strings (E A D G)', group: 'Bass', strings: ['E1', 'A1', 'D2', 'G2'] },
  { id: 'bass5', name: 'Bass, 5 strings (B E A D G)', group: 'Bass', strings: ['B0', 'E1', 'A1', 'D2', 'G2'] },
  { id: 'ukulele', name: 'Ukulele (G C E A)', group: 'Other', strings: ['G4', 'C4', 'E4', 'A4'] },
  { id: 'chromatic', name: 'Chromatic (any note)', group: 'Other', strings: [] },
]

export function tuningById(id: string): Tuning { return TUNINGS.find(t => t.id === id) || TUNINGS[0] }

/** The string of a tuning closest to a pitch (in semitones), with its index. */
export function nearestString(t: Tuning, midi: number): { index: number; midi: number } | null {
  if (!t.strings.length) return null
  let best = -1, bestD = Infinity, bestM = 0
  t.strings.forEach((s, i) => {
    const m = midiOf(s)
    const d = Math.abs(m - midi)
    if (d < bestD) { bestD = d; best = i; bestM = m }
  })
  // more than a fourth away from every string: probably not tuning this instrument
  return bestD > 5 ? null : { index: best, midi: bestM }
}

/** "E2" → "E" + subscript-free octave label for buttons. */
export function stringLabel(note: string): { name: string; octave: string } {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(note)
  if (!m) return { name: note, octave: '' }
  return { name: m[1] + (m[2] === '#' ? '♯' : m[2] === 'b' ? '♭' : ''), octave: m[3] }
}
