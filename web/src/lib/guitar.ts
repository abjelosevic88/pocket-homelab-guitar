// Shared words and helpers for songs, statuses and practice time.
import type { Tab, TabStatus } from './types'

export const STATUSES: { id: TabStatus; label: string; short: string; icon: string }[] = [
  { id: 'to_learn', label: 'Want to learn', short: 'To learn', icon: 'bookmark' },
  { id: 'learning', label: 'Learning', short: 'Learning', icon: 'book-open' },
  { id: 'polishing', label: 'Polishing', short: 'Polishing', icon: 'sparkles' },
  { id: 'mastered', label: 'Can play it', short: 'Can play', icon: 'check-circle' },
]
export const statusLabel = (s: TabStatus) => STATUSES.find(x => x.id === s)?.label || s

/** "Artist – Title", or the title alone. */
export const tabName = (t: Pick<Tab, 'title' | 'artist' | 'file_name'>) => t.artist && t.title ? `${t.artist} – ${t.title}` : t.title || t.file_name

/** 75 → "1 h 15 min", 12 → "12 min", 0.4 → "<1 min". */
export function fmtMinutes(min: number): string {
  if (min > 0 && min < 1) return '<1 min'
  const m = Math.round(min)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `${h} h ${r} min` : `${h} h`
}
export const fmtSeconds = (s: number) => fmtMinutes(s / 60)

/** 125 → "2:05" (song length). */
export function fmtLength(s: number): string {
  if (!s) return ''
  const m = Math.floor(s / 60), r = Math.round(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}

export const FORMAT_NAME: Record<string, string> = { gp: 'Guitar Pro 7/8', gpx: 'Guitar Pro 6', gp5: 'Guitar Pro 5', gp4: 'Guitar Pro 4', gp3: 'Guitar Pro 3', musicxml: 'MusicXML', alphatex: 'alphaTex' }

export const TAB_ACCEPT = '.gp,.gp3,.gp4,.gp5,.gpx,.gp7,.gp8,.xml,.musicxml,.mxl,.tex,.atex,.alphatex'
export const isTabFile = (name: string) => /\.(gp[345x78]?|xml|musicxml|mxl|a?tex|alphatex)$/i.test(name)

/** A soft colour per song for its cover tile (stable by id). */
export function tabHue(t: Pick<Tab, 'id' | 'artist' | 'title'>): number {
  const s = (t.artist || '') + (t.title || '') + t.id
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

/** Two letters for a song's cover tile. */
export function tabInitials(t: Pick<Tab, 'title' | 'artist'>): string {
  const w = (t.title || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean)
  return ((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toUpperCase()
}
