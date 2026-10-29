// Small helpers shared by the tools, the practice page and the practice form.
import { api, V1 } from '../lib/api'
import type { PracticeInput, PracticeSession } from '../lib/types'

/** A Date as RFC 3339 with the local offset ("2026-10-29T08:30:00+01:00"). */
export function localISO(d: Date): string {
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
}

/** 75 → "1:15", 3725 → "1:02:05" (a running clock). */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/** Seconds as plain words: "45 min", "1 h 20 min", "under a minute". */
export function minutes(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (seconds > 0 && m === 0) return 'under a minute'
  const h = Math.floor(m / 60), r = m % 60
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${m} min`
}

/** Short number of minutes for charts and tiles. */
export const mins = (seconds: number) => Math.round(seconds / 60)

/** Save time practised without a tab (the timer, the metronome). */
export function saveFreePractice(title: string, startedAt: string, durationS: number, note = ''): Promise<PracticeSession> {
  const start = new Date(startedAt)
  const body: PracticeInput = {
    kind: 'free', title, started_at: localISO(start), ended_at: localISO(new Date(start.getTime() + durationS * 1000)),
    duration_s: Math.round(durationS), note,
  }
  return api.post<PracticeSession>(`${V1}/practice`, body)
}

/** Icons the tools need that the shared set does not have (same 24-grid stroke style). */
const P: Record<string, string> = {
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8',
  'mic-off': 'M2 2l20 20M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23M12 19v3M8 22h8',
  tuner: 'M12 3a9 9 0 0 0-9 9M12 3a9 9 0 0 1 9 9M12 12l4-5M5.6 7.6l1.4 1M18.4 7.6 17 8.6M12 3v2M3 18h18',
  metronome: 'M9 3h6l4 18H5L9 3zM7.5 15h9M12 15l5-9',
  hand: 'M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0',
  guitar: 'M14 10l6-6M18 2l4 4M10.5 13.5a2 2 0 1 0-2.83-2.83M7 9.5c-2.5-.5-4.5 1-4.5 3.5 0 1.6 1 2.6 2 3.1.3 1.4 1.4 3.4 4 3.4 2.5 0 4-2 3.5-4.5 1-.5 1.5-1.5 1.5-2.5L10 9c-1 0-2 .5-3 .5z',
}

export function ToolIcon({ name, size = 16, className = '' }: { name: keyof typeof P; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  )
}
