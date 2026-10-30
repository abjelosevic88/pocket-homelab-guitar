// The shared practice timer: with Pocket Time connected, the timer in Guitar
// is the person's one timer in Pocket Time. One store for the whole page:
// asked for every 20 s while the page is visible and on focus, refreshed
// after every start/stop. Guitar's server talks to Pocket Time; the browser
// never sees a token.
import { useEffect, useState } from 'react'
import { api, ApiError, V1 } from './api'

export interface SharedTimer {
  id: number
  name: string
  started_at: string
  elapsed_s: number
  app: string
  source: string
  started_in: string // "here", "Pocket Time", "Pocket Projects"…
  guitar: boolean    // guitar practice: a song here or free practice
  tab_id: number | null
  url: string        // a path here for guitar practice
}

export interface TimerState {
  loaded: boolean
  connected: boolean
  detail: string
  running: SharedTimer | null
  time_url: string
  at: number // when it was read (Date.now())
}

let state: TimerState = { loaded: false, connected: false, detail: '', running: null, time_url: '', at: 0 }
const subs = new Set<(s: TimerState) => void>()
let timer = 0
let inflight: Promise<void> | null = null
const POLL_MS = 20_000

function set(next: Partial<TimerState>) {
  state = { ...state, ...next, loaded: true, at: Date.now() }
  subs.forEach(f => f(state))
}

/** Ask Guitar (and through it Pocket Time) what is running now. */
export function refreshTimer(): Promise<void> {
  if (inflight) return inflight
  inflight = api.get<{ connected: boolean; detail?: string; running?: SharedTimer | null; time_url?: string }>(`${V1}/timer`)
    .then(r => set({ connected: r.connected, detail: r.detail || '', running: r.connected ? r.running || null : null, time_url: r.time_url || state.time_url }))
    .catch(() => { if (!state.loaded) set({ connected: false }) })
    .finally(() => { inflight = null })
  return inflight
}

function schedule() {
  window.clearTimeout(timer)
  if (!subs.size || document.visibilityState !== 'visible' || !state.connected) return
  timer = window.setTimeout(() => { refreshTimer().finally(schedule) }, POLL_MS)
}

function wake() {
  if (document.visibilityState === 'visible') refreshTimer().finally(schedule)
  else window.clearTimeout(timer)
}

/** The shared timer, kept fresh while anything on the page shows it. */
export function useSharedTimer(): TimerState {
  const [s, setS] = useState(state)
  useEffect(() => {
    const first = subs.size === 0
    subs.add(setS)
    if (first) {
      document.addEventListener('visibilitychange', wake)
      window.addEventListener('focus', wake)
    }
    if (first || !state.loaded) refreshTimer().finally(schedule)
    else setS(state)
    return () => {
      subs.delete(setS)
      if (!subs.size) {
        document.removeEventListener('visibilitychange', wake)
        window.removeEventListener('focus', wake)
        window.clearTimeout(timer)
      }
    }
  }, [])
  return s
}

/** Seconds on a running timer now. */
export function elapsedNow(s: TimerState): number {
  if (!s.running) return 0
  return s.running.elapsed_s + Math.max(0, (Date.now() - s.at) / 1000)
}

/** Another timer is in the way: what it is. */
export class TimerBusy extends Error {
  running: SharedTimer
  constructor(msg: string, running: SharedTimer) { super(msg); this.running = running }
}

type StartWhat = { tab_id: number } | { title: string }

/** Start the shared timer; throws TimerBusy when another one runs (unless switching). */
export async function startTimer(what: StartWhat, switchIt = false): Promise<SharedTimer> {
  try {
    const r = await api.post<{ running: SharedTimer; stopped: SharedTimer | null }>(`${V1}/timer/start`, { ...what, switch: switchIt })
    set({ running: r.running })
    schedule()
    return r.running
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data.running) {
      set({ running: e.data.running as SharedTimer })
      throw new TimerBusy(e.message, e.data.running as SharedTimer)
    }
    throw e
  }
}

/** Stop the shared timer, only if it is still the one shown. */
export async function stopTimer(onlyIf: number, note = ''): Promise<SharedTimer | null> {
  try {
    const r = await api.post<{ running: null; stopped: SharedTimer | null }>(`${V1}/timer/stop`, { only_if: onlyIf, note })
    set({ running: null })
    return r.stopped
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data.running) {
      set({ running: e.data.running as SharedTimer })
      throw new TimerBusy(e.message, e.data.running as SharedTimer)
    }
    throw e
  }
}

/** Where a timer was started, in plain words. */
export function startedIn(t: SharedTimer): string {
  return t.started_in === 'here' ? 'started here in Guitar' : `started in ${t.started_in}`
}
