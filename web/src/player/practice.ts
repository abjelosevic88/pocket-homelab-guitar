// The automatic practice log: counts the seconds a person actually plays this
// tab (short pauses of up to 20 s count too), and saves them as ONE practice
// session per page visit (the same external_id updates the same row): every
// minute while counting, and when the page is hidden or left.
//
// While the shared practice timer runs for guitar practice (Pocket Time,
// lib/timer.ts) the timer is the record, so this log counts nothing: what it
// had is saved, and after the timer stops it goes on as a new session.
import { useEffect, useRef, useState } from 'react'
import { api, V1 } from '../lib/api'
import type { PracticeInput, PracticeSession } from '../lib/types'
import type { TabEngine } from './engine'
import { localDate, localISO, uuid } from './music'

const GRACE_S = 20

export interface PracticeTimer {
  sessionS: number   // this visit
  todayS: number     // this tab today, this visit included
  loops: number
  /** Save what was counted so far (before the shared timer starts). */
  flush: () => Promise<void>
}

/** held = the shared timer is running for guitar practice since heldSince. */
export function usePracticeTimer(engine: TabEngine, tabId: number | null, title: string, sectionId: number | null, held = false, heldSince = ''): PracticeTimer {
  const [sessionS, setSessionS] = useState(0)
  const [baseToday, setBaseToday] = useState(0)
  const [loops, setLoops] = useState(0)
  const first = uuid()
  const ref = useRef({ id: first, ids: [first], started: '', seconds: 0, visit: 0, saved: -1, topSpeed: 0, loops: 0, lastActive: 0, pauseAt: 0, title, sectionId,
    held, save: (_beacon?: boolean) => Promise.resolve() })
  ref.current.title = title
  ref.current.sectionId = sectionId

  // what was already practised today on this tab (other visits, the timer)
  const loadToday = () => {
    if (!tabId) return
    const d = localDate()
    api.get<{ sessions: PracticeSession[] }>(`${V1}/practice?tab_id=${tabId}&from=${d}&to=${d}&limit=200`)
      .then(r => setBaseToday(r.sessions.filter(s => !ref.current.ids.includes(s.external_id)).reduce((a, s) => a + s.duration_s, 0)))
      .catch(() => {})
  }
  useEffect(loadToday, [tabId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tabId) return
    const r = ref.current
    const body = (): PracticeInput => ({
      tab_id: tabId, section_id: r.sectionId, title: r.title, started_at: r.started || localISO(), ended_at: localISO(),
      duration_s: r.seconds, speed: Math.round(r.topSpeed * 100), loops: r.loops, kind: 'tab', external_id: r.id,
    })
    r.save = (beacon = false) => {
      if (r.seconds < 5 || r.seconds === r.saved) return Promise.resolve()
      r.saved = r.seconds
      const b = body()
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(`${V1}/practice`, new Blob([JSON.stringify(b)], { type: 'application/json' }))
        return Promise.resolve()
      }
      return api.post(`${V1}/practice`, b).then(() => {}, () => { r.saved = -1 })
    }
    const offs = [
      engine.on('play', () => {
        if (r.held) return
        const now = Date.now()
        if (!r.started) r.started = localISO()
        // a short pause between plays counts as practice
        if (r.pauseAt && now - r.pauseAt <= GRACE_S * 1000) { const g = Math.round((now - r.pauseAt) / 1000); r.seconds += g; r.visit += g }
        r.pauseAt = 0
        r.topSpeed = Math.max(r.topSpeed, engine.state.get().speed)
      }),
      engine.on('pause', () => { if (!r.held) r.pauseAt = Date.now() }),
      engine.on('loopPass', () => { r.loops++; setLoops(r.loops) }),
    ]
    const tick = window.setInterval(() => {
      const st = engine.state.get()
      if (st.playing && !r.held) {
        r.seconds++
        r.visit++
        r.topSpeed = Math.max(r.topSpeed, st.speed)
        setSessionS(r.visit)
        if (r.seconds % 60 === 0) r.save()
      }
    }, 1000)
    const hide = () => { if (document.visibilityState === 'hidden') r.save(true) }
    const leave = () => r.save(true)
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    return () => {
      offs.forEach(o => o())
      window.clearInterval(tick)
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', leave)
      r.save(true)
    }
  }, [engine, tabId])

  // the shared timer starts: keep what came before it, then count nothing
  useEffect(() => {
    const r = ref.current
    if (r.held === held) return
    r.held = held
    if (held) {
      // seconds counted after the timer began (it was started elsewhere and
      // seen up to 20 s later) belong to the timer
      const since = Date.parse(heldSince)
      if (!Number.isNaN(since)) {
        const over = Math.min(Math.max(0, r.seconds - Math.max(r.saved, 0)), Math.max(0, Math.round((Date.now() - since) / 1000)))
        r.seconds -= over; r.visit -= over
        setSessionS(r.visit)
      }
      void r.save().then(() => {
        const next = uuid()
        Object.assign(r, { id: next, started: '', seconds: 0, saved: -1, topSpeed: 0, pauseAt: 0 })
        r.ids.push(next)
      })
      return
    }
    // the timer stopped: Pocket Time writes its practice here in a moment
    const a = window.setTimeout(loadToday, 4000)
    const b = window.setTimeout(loadToday, 15000)
    return () => { window.clearTimeout(a); window.clearTimeout(b) }
  }, [held]) // eslint-disable-line react-hooks/exhaustive-deps

  return { sessionS, todayS: baseToday + sessionS, loops, flush: () => ref.current.save() }
}

/** Keep the screen on while playing (phones on a music stand). */
export function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let alive = true
    const get = () => navigator.wakeLock.request('screen').then(l => { if (alive) lock = l; else l.release() }).catch(() => {})
    get()
    const again = () => { if (document.visibilityState === 'visible' && alive) get() }
    document.addEventListener('visibilitychange', again)
    return () => { alive = false; document.removeEventListener('visibilitychange', again); lock?.release().catch(() => {}) }
  }, [on])
}
