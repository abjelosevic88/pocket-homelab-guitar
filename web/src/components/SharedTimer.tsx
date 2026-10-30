// The shared practice timer's buttons: in the player header (start/stop for
// this song) and in the top bar (whatever is running, wherever it was
// started). Only shown with Pocket Time connected; without it Guitar works as
// before (the player logs your time by itself).
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './icons'
import { Popover, errMsg, rectOf, useToast, type Anchor, type ToastFn } from './ui'
import { announceChange } from './Layout'
import { clock, minutes } from '../tools/common'
import { TimerBusy, elapsedNow, startTimer, startedIn, stopTimer, useSharedTimer, type SharedTimer, type TimerState } from '../lib/timer'

/** Re-render every second while on. */
export function useTick(on: boolean) {
  const [, set] = useState(0)
  useEffect(() => { if (!on) return; const id = window.setInterval(() => set(x => x + 1), 1000); return () => window.clearInterval(id) }, [on])
}

/** Where to open a running timer: the song or the free timer here, else Pocket Time. */
function OpenIt({ t, state, onClose }: { t: SharedTimer; state: TimerState; onClose: () => void }) {
  if (t.guitar && t.url) return <Link to={t.url} className="btn sm" onClick={onClose}>Open it</Link>
  if (state.time_url) return <a href={state.time_url} className="btn sm" target="_blank" rel="noreferrer">Open Pocket Time</a>
  return null
}

/** What runs, with Stop and (when something else could start) "Stop it and start this". */
export function TimerBusyBox({ t, state, startLabel, onSwitch, onStop, onClose }: {
  t: SharedTimer; state: TimerState; startLabel?: string; onSwitch?: () => void; onStop: () => void; onClose: () => void
}) {
  return (
    <div className="st-busy stack">
      <p><b>Your timer is running:</b> {t.name} <span className="muted">· {clock(elapsedNow(state))}, {startedIn(t)}</span></p>
      <p className="muted small">One timer at a time: it is the same timer as in Pocket Time.</p>
      <div className="row wrap">
        {onSwitch && <button type="button" className="btn primary sm" onClick={onSwitch}><Icon name="play" size={14} />Stop it and start {startLabel || 'this'}</button>}
        <button type="button" className="btn sm" onClick={onStop}><Icon name="stop" size={14} />Stop it</button>
        <OpenIt t={t} state={state} onClose={onClose} />
      </div>
    </div>
  )
}

function stoppedToast(t: SharedTimer | null, toast: ToastFn) {
  if (!t) return
  toast(t.guitar ? `Stopped: ${minutes(t.elapsed_s)} of ${t.name}. Pocket Time saves it to your practice log.` : `Stopped: ${t.name} (${minutes(t.elapsed_s)})`)
  if (t.guitar) window.setTimeout(announceChange, 4000)
}

/** The player header's timer for one song. beforeStart saves the automatic log first. */
export function PlayerTimerButton({ tabId, label, beforeStart }: { tabId: number; label: string; beforeStart?: () => Promise<void> }) {
  const state = useSharedTimer()
  const { toast } = useToast()
  const [at, setAt] = useState<Anchor | null>(null)
  const [busy, setBusy] = useState(false)
  const run = state.running
  useTick(!!run)
  if (!state.connected) return null
  const here = !!run && run.guitar && run.tab_id === tabId

  const start = async (switchIt: boolean, el?: Element) => {
    setBusy(true)
    try {
      await beforeStart?.()
      await startTimer({ tab_id: tabId }, switchIt)
      setAt(null)
    } catch (e) {
      if (e instanceof TimerBusy) { if (el) setAt(rectOf(el)) } else toast(errMsg(e), 'err')
    } finally { setBusy(false) }
  }
  const stop = async (t: SharedTimer) => {
    setBusy(true)
    try { stoppedToast(await stopTimer(t.id), toast); setAt(null) } catch (e) { toast(errMsg(e), 'err') } finally { setBusy(false) }
  }

  return <>
    {here
      ? <button type="button" className="btn sm ph-timer on" disabled={busy} onClick={() => stop(run)} title="Stop the practice timer (the same timer as in Pocket Time)" aria-label={`Stop the practice timer, ${clock(elapsedNow(state))}`}>
        <span className="st-dot" /><span className="tnum">{clock(elapsedNow(state))}</span><Icon name="stop" size={13} />
      </button>
      : run
        ? <button type="button" className="btn ghost sm ph-timer other" disabled={busy} onClick={e => setAt(at ? null : rectOf(e.currentTarget))} title={`Your timer is running: ${run.name}`}>
          <Icon name="timer" size={15} /><span className="tnum">{clock(elapsedNow(state))}</span>
        </button>
        : <button type="button" className="btn ghost sm ph-timer" disabled={busy} onClick={e => start(false, e.currentTarget)} title="Start the practice timer — the same timer as in Pocket Time; it saves the time to your practice log when it stops">
          <Icon name="timer" size={15} /><span className="ph-tab-l">Timer</span>
        </button>}
    {at && run && !here && (
      <Popover anchor={at} onClose={() => setAt(null)} prefer="below" width={340} label="Your timer" className="st-pop">
        <TimerBusyBox t={run} state={state} startLabel={label ? `“${label}”` : 'this song'} onSwitch={() => start(true)} onStop={() => stop(run)} onClose={() => setAt(null)} />
      </Popover>
    )}
  </>
}

/** The top bar's view of a running timer (any app), with Stop. */
export function TopbarTimer() {
  const state = useSharedTimer()
  const { toast } = useToast()
  const run = state.running
  useTick(!!run)
  if (!state.connected || !run) return null
  const stop = async () => { try { stoppedToast(await stopTimer(run.id), toast) } catch (e) { toast(errMsg(e), 'err') } }
  const body = <><span className="st-dot" /><span className="tnum">{clock(elapsedNow(state))}</span><span className="st-name ellipsis">{run.name}</span></>
  const title = `Your timer: ${run.name}, ${startedIn(run)}`
  return (
    <span className="st-pill" role="group" aria-label="Your timer">
      {run.guitar && run.url ? <Link to={run.url} className="st-open" title={title}>{body}</Link>
        : state.time_url ? <a href={state.time_url} target="_blank" rel="noreferrer" className="st-open" title={title}>{body}</a>
          : <span className="st-open" title={title}>{body}</span>}
      <button type="button" className="btn ghost xs icon-only" onClick={stop} aria-label="Stop the timer" title="Stop the timer"><Icon name="stop" size={13} /></button>
    </span>
  )
}
