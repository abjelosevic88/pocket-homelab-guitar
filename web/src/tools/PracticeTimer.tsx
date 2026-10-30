// "Practice without a tab": a stopwatch for scales, chords, improvising…
// that is saved to the practice log. It survives a reload or a trip to
// another page (the state lives in localStorage).
//
// With Pocket Time connected it is the shared timer instead (lib/timer.ts):
// the same timer as in Pocket Time, started and stopped here or there, and
// Pocket Time saves the practice here when it stops.
import { useEffect, useState } from 'react'
import { Field, Loading, useToast, errMsg } from '../components/ui'
import { Icon } from '../components/icons'
import { announceChange } from '../components/Layout'
import { TimerBusyBox, useTick } from '../components/SharedTimer'
import { TimerBusy, elapsedNow, startTimer, stopTimer, useSharedTimer } from '../lib/timer'
import { clock, minutes, saveFreePractice } from './common'

const KEY = 'pgt-timer'
export const WHAT = ['Scales', 'Chords', 'Improvising', 'Technique', 'Ear training', 'Theory', 'Other']

interface TimerState { title: string; startedAt: string; before: number; since: number /* epoch ms while running, 0 when paused */ }
const EMPTY: TimerState = { title: 'Scales', startedAt: '', before: 0, since: 0 }

function load(): TimerState { try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return EMPTY } }
const elapsed = (t: TimerState) => t.before + (t.since ? (Date.now() - t.since) / 1000 : 0)

/** Is the practice timer running (for the badge on the tools switch)? */
export function timerRunning(): boolean { return !!load().since }

export function PracticeTimer() {
  const shared = useSharedTimer()
  if (!shared.loaded) return <Loading />
  // a local timer already under way finishes as it began
  if (shared.connected && !load().startedAt) return <SharedFreeTimer />
  return <LocalTimer />
}

/** What are you practising? (the chips, shared by both timers) */
function WhatField({ title, setTitle, disabled }: { title: string; setTitle: (t: string) => void; disabled?: boolean }) {
  const [custom, setCustom] = useState(() => !WHAT.includes(title))
  return (
    <Field label="What are you practising?" group>
      <div className="chips gt-what">
        {WHAT.map(w => <button key={w} type="button" disabled={disabled} className={`chip ${!custom && title === w ? 'active' : ''}`} onClick={() => { setCustom(false); setTitle(w) }}>{w}</button>)}
        <button type="button" disabled={disabled} className={`chip ${custom ? 'active' : ''}`} onClick={() => { setCustom(true); setTitle('') }}>Something else…</button>
      </div>
      {custom && <input autoFocus value={title} disabled={disabled} maxLength={80} onChange={e => setTitle(e.target.value)} placeholder="For example: alternate picking, the solo from Hotel California" />}
    </Field>
  )
}

/** The free-practice timer as the shared timer in Pocket Time. */
function SharedFreeTimer() {
  const { toast } = useToast()
  const state = useSharedTimer()
  const [title, setTitleState] = useState(() => load().title)
  const setTitle = (t: string) => { setTitleState(t); localStorage.setItem(KEY, JSON.stringify({ ...load(), title: t })) }
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const run = state.running
  useTick(!!run)
  const mine = !!run && run.guitar && !run.tab_id
  const label = title.trim() || 'Free practice'

  const start = async (switchIt: boolean) => {
    setBusy(true)
    try { await startTimer({ title: label }, switchIt) } catch (e) { if (!(e instanceof TimerBusy)) toast(errMsg(e), 'err') } finally { setBusy(false) }
  }
  const stop = async () => {
    if (!run) return
    setBusy(true)
    try {
      const t = await stopTimer(run.id, run.guitar ? note.trim() : '')
      setNote('')
      if (t) toast(t.guitar ? `Stopped: ${minutes(t.elapsed_s)} of ${t.name.toLowerCase()}. Pocket Time saves it to your practice log.` : `Stopped: ${t.name}`)
      if (t?.guitar) window.setTimeout(announceChange, 4000)
    } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }

  return (
    <div className="gt-timer">
      <WhatField title={mine ? run.name : title} setTitle={setTitle} disabled={mine || busy} />
      <div className={`gt-clock tnum ${mine ? 'running' : ''}`} aria-live="off">{clock(mine ? elapsedNow(state) : 0)}</div>
      {run && !mine
        ? <div className="callout info"><Icon name="timer" size={15} /><div className="grow"><TimerBusyBox t={run} state={state} startLabel={`“${label}”`} onSwitch={() => start(true)} onStop={stop} onClose={() => {}} /></div></div>
        : <>
          <div className="gt-go-row">
            {mine
              ? <button type="button" className="btn lg gt-go" onClick={stop} disabled={busy}><Icon name="stop" size={18} strokeWidth={2.2} />Stop</button>
              : <button type="button" className="btn primary lg gt-go" onClick={() => start(false)} disabled={busy}><Icon name="play" size={18} strokeWidth={2.2} />Start</button>}
          </div>
          {mine && <div className="gt-finish">
            <Field label="Note (optional)"><input value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="What went well, what to work on next time" /></Field>
          </div>}
        </>}
      <p className="muted small gt-center">This is the same timer as in Pocket Time: start or stop it here or there. When it stops, the time is saved to your practice log. Practising a song from your library? Open it and use the timer there.</p>
    </div>
  )
}

/** The timer on its own (no Pocket Time): pause, continue, save. */
function LocalTimer() {
  const { toast } = useToast()
  const [t, setT] = useState<TimerState>(load)
  const [, tick] = useState(0)
  const [note, setNote] = useState('')
  const [custom, setCustom] = useState(() => !WHAT.includes(load().title))
  const [saving, setSaving] = useState(false)
  const save = (n: TimerState) => { setT(n); localStorage.setItem(KEY, JSON.stringify(n)) }
  useEffect(() => { if (!t.since) return; const id = window.setInterval(() => tick(x => x + 1), 250); return () => window.clearInterval(id) }, [t.since])

  const secs = elapsed(t)
  const running = !!t.since
  const started = !!t.startedAt
  const start = () => save({ ...t, startedAt: t.startedAt || new Date().toISOString(), since: Date.now() })
  const pause = () => save({ ...t, before: elapsed(t), since: 0 })
  const discard = () => { save({ ...EMPTY, title: t.title }); setNote('') }
  const finish = async () => {
    const dur = elapsed(t)
    if (dur < 60) { toast('Practise at least a minute before saving', 'err'); return }
    setSaving(true)
    try {
      await saveFreePractice(t.title.trim() || 'Practice', t.startedAt, dur, note.trim())
      save({ ...EMPTY, title: t.title })
      setNote('')
      announceChange()
      toast(`Saved: ${minutes(dur)} of ${t.title.trim().toLowerCase() || 'practice'}`)
    } catch (e) { toast(errMsg(e), 'err') } finally { setSaving(false) }
  }

  return (
    <div className="gt-timer">
      <Field label="What are you practising?" group>
        <div className="chips gt-what">
          {WHAT.map(w => <button key={w} type="button" className={`chip ${!custom && t.title === w ? 'active' : ''}`} onClick={() => { setCustom(false); save({ ...t, title: w }) }}>{w}</button>)}
          <button type="button" className={`chip ${custom ? 'active' : ''}`} onClick={() => { setCustom(true); save({ ...t, title: '' }) }}>Something else…</button>
        </div>
        {custom && <input autoFocus value={t.title} maxLength={80} onChange={e => save({ ...t, title: e.target.value })} placeholder="For example: alternate picking, the solo from Hotel California" />}
      </Field>

      <div className={`gt-clock tnum ${running ? 'running' : ''}`} aria-live="off">{clock(secs)}</div>

      <div className="gt-go-row">
        {running
          ? <button type="button" className="btn lg gt-go" onClick={pause}><Icon name="pause" size={18} strokeWidth={2.2} />Pause</button>
          : <button type="button" className="btn primary lg gt-go" onClick={start}><Icon name="play" size={18} strokeWidth={2.2} />{started ? 'Continue' : 'Start'}</button>}
      </div>

      {started && <div className="gt-finish">
        <Field label="Note (optional)"><input value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="What went well, what to work on next time" /></Field>
        <div className="row wrap gt-finish-btns">
          <button type="button" className="btn primary" onClick={finish} disabled={saving || secs < 60} title={secs < 60 ? 'Practise at least a minute first' : undefined}><Icon name="check" size={15} />Save to your practice log</button>
          <button type="button" className="btn ghost" onClick={discard} disabled={saving}>Throw away</button>
        </div>
      </div>}
      <p className="muted small gt-center">Practising a song from your library? Open it instead — the player logs your time by itself.</p>
    </div>
  )
}
