// Cleans up what tab files carry that alphaTab would print on top of itself.
//
// - Section names: alphaTab draws "[marker] text". Songsterr exports put the
//   whole name in both ("[Intro] Intro", "[[A] Main Riff] [A] Main Riff").
// - Text on beats: performance notes ("Play rhythm parts with all
//   downstrokes…", "Original recording is at A435hz") sit on neighbouring
//   beats and are printed on one line, over each other. Long ones are taken
//   out of the tab and listed as "Notes in this file"; the tab keeps a small
//   numbered mark (※1) where each was. Short cues ("let ring") stay.
import type { AT } from './alphatab'

export interface FileNote { mark: string; text: string; bar: number; tracks: string[] }

const LONG = 22 // characters; longer text becomes a note

export function tidyScore(score: AT.model.Score): FileNote[] {
  for (const mb of score.masterBars) {
    const s = mb.section
    if (!s) continue
    const marker = (s.marker || '').trim(), text = (s.text || '').trim()
    const lead = /^\[([^\]]{1,12})\]\s*(.*)$/.exec(text)
    if (lead) { s.marker = lead[1]; s.text = lead[2] }
    else if (marker && (!text || text.toLowerCase().includes(marker.toLowerCase().replace(/^\[|\]$/g, '')))) { s.marker = ''; s.text = text || marker }
  }

  const notes: FileNote[] = []
  const byText = new Map<string, FileNote>()
  for (const track of score.tracks) {
    const trackName = (track.name || `Track ${track.index + 1}`).split(' | ')[0].trim()
    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          const texts = voice.beats.filter(b => b.text && b.text.trim())
          if (!texts.length) continue
          const marks: string[] = []
          const short: string[] = []
          for (const b of texts) {
            const t = b.text!.trim().replace(/\s+/g, ' ')
            if (t.length <= LONG) { short.push(t); continue }
            const key = t.toLowerCase()
            let n = byText.get(key)
            if (!n) { n = { mark: `\u0000${notes.length}`, text: t, bar: bar.index + 1, tracks: [] }; notes.push(n); byText.set(key, n) }
            n.bar = Math.min(n.bar, bar.index + 1)
            if (!n.tracks.includes(trackName)) n.tracks.push(trackName)
            marks.push(n.mark)
          }
          // one text per bar and voice: the cues, then the marks, on the first beat that had text
          for (const b of texts) b.text = null
          const joined = [...short, marks.join(' ')].filter(Boolean).join(' · ')
          texts[0].text = joined
        }
      }
    }
  }
  // number the marks in the order they appear in the song
  const order = [...notes].sort((a, b) => a.bar - b.bar || notes.indexOf(a) - notes.indexOf(b))
  const final = new Map(order.map((n, i) => [n.mark, `※${i + 1}`]))
  for (const track of score.tracks) for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const b of voice.beats) {
    if (b.text && b.text.includes('\u0000')) b.text = b.text.replace(/\u0000\d+/g, m => final.get(m) || m)
  }
  for (const n of order) n.mark = final.get(n.mark)!
  return order
}
