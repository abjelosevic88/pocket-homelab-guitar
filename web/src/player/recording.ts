// Playing the original recording along with the tab: the song streams from
// the person's Navidrome through the app, starts where the tab cursor is,
// follows the tab's speed (pitch kept) and is pulled back in line when it
// drifts. alphaTab reports wall-clock time at the current speed, so the song
// position is time × speed + the offset the person set.
import { useEffect, useRef } from 'react'
import { V1 } from '../lib/api'
import type { Recording } from '../lib/types'
import type { TabEngine } from './engine'

export type SoundMode = 'tab' | 'recording' | 'both'

export function useRecordingSync(engine: TabEngine, rec: Recording | null, mode: SoundMode) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const active = !!rec && mode !== 'tab'

  useEffect(() => {
    if (!rec || !active) { engine.setSynthAudible(true); return }
    const a = new Audio()
    a.preload = 'auto'
    a.src = `${V1}/music/stream/${encodeURIComponent(rec.id)}`
    ;(a as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true
    audio.current = a
    engine.setSynthAudible(mode === 'both')
    const target = () => (engine.nowMs() * engine.state.get().speed + rec.offset_ms) / 1000
    const align = () => {
      const t = target()
      if (t < 0) { a.pause(); return }
      if (Number.isFinite(a.duration) && t > a.duration) { a.pause(); return }
      a.currentTime = t
    }
    const start = () => { a.playbackRate = engine.state.get().speed; align(); a.play().catch(() => {}) }
    const offs = [
      engine.on('play', start),
      engine.on('pause', () => a.pause()),
      engine.on('seek', () => { if (!a.paused || engine.state.get().playing) align() }),
      engine.on('loopPass', () => align()),
      engine.state.subscribe(() => { const sp = engine.state.get().speed; if (a.playbackRate !== sp) a.playbackRate = sp }),
    ]
    // drift correction: the score clock leads; nudge the song when it is off by more than a beat-ish
    const t = window.setInterval(() => {
      if (!engine.state.get().playing) return
      const want = target()
      if (want < 0) return
      if (a.paused && want >= 0 && (!Number.isFinite(a.duration) || want < a.duration)) { a.currentTime = want; a.play().catch(() => {}); return }
      if (Math.abs(a.currentTime - want) > 0.25) a.currentTime = want
    }, 500)
    if (engine.state.get().playing) start()
    return () => { offs.forEach(o => o()); window.clearInterval(t); a.pause(); a.removeAttribute('src'); a.load(); audio.current = null; engine.setSynthAudible(true) }
  }, [engine, rec?.id, rec?.offset_ms, active, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  return audio
}
