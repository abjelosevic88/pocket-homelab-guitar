// The practice timer: counts the seconds a person actually plays this tab
// (short pauses of up to 20 s count too), and saves them as ONE practice
// session per page visit (the same external_id updates the same row): every
// minute while counting, and when the page is hidden or left.
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
}

export function usePracticeTimer(engine: TabEngine, tabId: number | null, title: string, sectionId: number | null): PracticeTimer {
  const [sessionS, setSessionS] = useState(0)
  const [baseToday, setBaseToday] = useState(0)
  const [loops, setLoops] = useState(0)
  const ref = useRef({ id: uuid(), started: '', seconds: 0, saved: -1, topSpeed: 0, loops: 0, lastActive: 0, pauseAt: 0, title, sectionId })
  ref.current.title = title
  ref.current.sectionId = sectionId

  // what was already practised today on this tab (other visits)
  useEffect(() => {
    if (!tabId) return
    const d = localDate()
    api.get<{ sessions: PracticeSession[] }>(`${V1}/practice?tab_id=${tabId}&from=${d}&to=${d}&limit=200`)
      .then(r => setBaseToday(r.sessions.filter(s => s.external_id !== ref.current.id).reduce((a, s) => a + s.duration_s, 0)))
      .catch(() => {})
  }, [tabId])

  useEffect(() => {
    if (!tabId) return
    const r = ref.current
    const body = (): PracticeInput => ({
      tab_id: tabId, section_id: r.sectionId, title: r.title, started_at: r.started || localISO(), ended_at: localISO(),
      duration_s: r.seconds, speed: Math.round(r.topSpeed * 100), loops: r.loops, kind: 'tab', external_id: r.id,
    })
    const save = (beacon = false) => {
      if (r.seconds < 5 || r.seconds === r.saved) return
      r.saved = r.seconds
      const b = body()
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(`${V1}/practice`, new Blob([JSON.stringify(b)], { type: 'application/json' }))
        return
      }
      api.post(`${V1}/practice`, b).catch(() => { r.saved = -1 })
    }
    const offs = [
      engine.on('play', () => {
        const now = Date.now()
        if (!r.started) r.started = localISO()
        // a short pause between plays counts as practice
        if (r.pauseAt && now - r.pauseAt <= GRACE_S * 1000) r.seconds += Math.round((now - r.pauseAt) / 1000)
        r.pauseAt = 0
        r.topSpeed = Math.max(r.topSpeed, engine.state.get().speed)
      }),
      engine.on('pause', () => { r.pauseAt = Date.now() }),
      engine.on('loopPass', () => { r.loops++; setLoops(r.loops) }),
    ]
    const tick = window.setInterval(() => {
      const st = engine.state.get()
      if (st.playing) {
        r.seconds++
        r.topSpeed = Math.max(r.topSpeed, st.speed)
        setSessionS(r.seconds)
        if (r.seconds % 60 === 0) save()
      }
    }, 1000)
    const hide = () => { if (document.visibilityState === 'hidden') save(true) }
    const leave = () => save(true)
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    return () => {
      offs.forEach(o => o())
      window.clearInterval(tick)
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', leave)
      save(true)
    }
  }, [engine, tabId])

  return { sessionS, todayS: baseToday + sessionS, loops }
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
