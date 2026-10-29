// The transport bar along the bottom and its pop-ups: speed, tracks (show,
// mute, solo, volume) and view (notation, layout, zoom, transpose).
import { useState } from 'react'
import { Popover, Segmented, Switch, rectOf, type Anchor, useIsMobile } from '../components/ui'
import { Icon } from '../components/icons'
import type { Notation, ScoreLayout } from '../lib/types'
import { PIcon } from './icons'
import { type EngineState, type TabEngine, usePosition } from './engine'
import { fmtMinutes, fmtTime, instrumentName, isGuitarLike, lowToHigh, tuningName } from './music'

export interface ViewPrefs { notation: Notation; layout: ScoreLayout; zoom: number; transpose: number; autoScroll: boolean; fretboard: boolean }

type Pop = { kind: 'speed' | 'tracks' | 'view' | 'more'; at: Anchor } | null

export function Transport({ engine, st, speedStep, tracks, setTracks, view, setView, todayS, onLoop, hasRecording, soundLabel }: {
  engine: TabEngine; st: EngineState; speedStep: number
  tracks: number[]; setTracks: (t: number[]) => void
  view: ViewPrefs; setView: (v: Partial<ViewPrefs>) => void
  todayS: number; onLoop: () => void; hasRecording: boolean; soundLabel: string
}) {
  const mobile = useIsMobile()
  const [pop, setPop] = useState<Pop>(null)
  const open = (kind: NonNullable<Pop>['kind']) => (e: React.MouseEvent<HTMLElement>) => setPop(pop?.kind === kind ? null : { kind, at: rectOf(e.currentTarget) })
  const ready = st.playerReady && st.phase !== 'error' && !!st.score
  const pct = Math.round(st.speed * 100)
  const step = (d: number) => engine.setSpeed(st.speed + (d * speedStep) / 100)
  const loopLabel = st.range ? `${st.range.start + 1}–${st.range.end + 1}` : 'Loop'

  return (
    <div className="transport" role="toolbar" aria-label="Playback">
      <div className="tp-group">
        <button type="button" className="btn ghost icon-only tp-btn" onClick={() => engine.stop()} disabled={!ready} title="Back to the start (Home)" aria-label="Back to the start"><PIcon name="skip-start" size={18} /></button>
        <button type="button" className={`tp-play ${st.playing ? 'on' : ''}`} onClick={() => engine.playPause()} disabled={!ready} title={st.playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={st.playing ? 'Pause' : 'Play'}>
          <Icon name={st.playing ? 'pause' : 'play'} size={22} strokeWidth={2.2} />
        </button>
        <Clock engine={engine} st={st} />
      </div>

      <div className="tp-group tp-mid">
        <button type="button" className={`btn ghost tp-btn tp-loop ${st.looping ? 'active' : ''}`} onClick={onLoop} disabled={!ready} title={st.range ? 'Loop the selected bars (L)' : 'Select bars in the tab to loop them (L)'} aria-pressed={st.looping}>
          <Icon name="repeat" size={16} /><span className="tnum tp-loop-t">{loopLabel}</span>
        </button>
        <div className="tp-speed" role="group" aria-label="Speed">
          <button type="button" className="btn ghost icon-only tp-btn" onClick={() => step(-1)} disabled={!st.score || pct <= 25} title="Slower ([)" aria-label="Slower"><Icon name="minus" size={16} /></button>
          <button type="button" className={`btn ghost tp-speed-v tnum ${pct !== 100 ? 'changed' : ''}`} onClick={open('speed')} title="Speed" aria-haspopup="dialog">{pct}%</button>
          <button type="button" className="btn ghost icon-only tp-btn" onClick={() => step(1)} disabled={!st.score || pct >= 200} title="Faster (])" aria-label="Faster"><Icon name="plus" size={16} /></button>
        </div>
        {!mobile && <>
          <button type="button" className={`btn ghost icon-only tp-btn ${st.countIn ? 'active' : ''}`} onClick={() => engine.setCountIn(!st.countIn)} title={`Count in before playing (C) — ${st.countIn ? 'on' : 'off'}`} aria-pressed={st.countIn}><PIcon name="count-in" size={18} /></button>
          <button type="button" className={`btn ghost icon-only tp-btn ${st.metronome ? 'active' : ''}`} onClick={() => engine.setMetronome(!st.metronome)} title={`Metronome (M) — ${st.metronome ? 'on' : 'off'}`} aria-pressed={st.metronome}><PIcon name="metronome" size={18} /></button>
        </>}
      </div>

      <div className="tp-group tp-right">
        {!mobile && <>
          <button type="button" className="btn ghost tp-btn" data-k="tracks" onClick={open('tracks')} disabled={!st.score} title="Tracks: show, mute, solo, volume (T)" aria-haspopup="dialog"><Icon name="sliders" size={16} /><span>Tracks</span></button>
          <button type="button" className="btn ghost tp-btn" onClick={open('view')} disabled={!st.score} title="How the tab looks" aria-haspopup="dialog"><PIcon name="view" size={16} /><span>View</span></button>
          <button type="button" className={`btn ghost icon-only tp-btn ${view.fretboard ? 'active' : ''}`} onClick={() => setView({ fretboard: !view.fretboard })} title="Fretboard (F)" aria-pressed={view.fretboard}><PIcon name="fretboard" size={18} /></button>
          <span className="tp-today small tnum" title="Practised on this song today (counts while it plays)"><Icon name="clock" size={14} />{fmtMinutes(todayS)}</span>
        </>}
        {mobile && <button type="button" className="btn ghost icon-only tp-btn" onClick={open('more')} aria-label="More controls" title="More"><Icon name="more" size={18} /></button>}
      </div>

      {pop?.kind === 'speed' && (
        <Popover anchor={pop.at} onClose={() => setPop(null)} prefer="below" width={300} label="Speed">
          <SpeedBox engine={engine} st={st} speedStep={speedStep} />
        </Popover>
      )}
      {pop?.kind === 'tracks' && (
        <Popover anchor={pop.at} onClose={() => setPop(null)} prefer="below" width={380} label="Tracks">
          <TracksBox engine={engine} st={st} tracks={tracks} setTracks={setTracks} />
        </Popover>
      )}
      {pop?.kind === 'view' && (
        <Popover anchor={pop.at} onClose={() => setPop(null)} prefer="below" width={320} label="View">
          <ViewBox view={view} setView={setView} />
        </Popover>
      )}
      {pop?.kind === 'more' && (
        <Popover anchor={pop.at} onClose={() => setPop(null)} label="More controls">
          <div className="tp-sheet">
            <div className="tp-sheet-row">
              <button type="button" className={`btn ${st.countIn ? 'active-soft' : ''}`} onClick={() => engine.setCountIn(!st.countIn)} aria-pressed={st.countIn}><PIcon name="count-in" size={16} />Count-in {st.countIn ? 'on' : 'off'}</button>
              <button type="button" className={`btn ${st.metronome ? 'active-soft' : ''}`} onClick={() => engine.setMetronome(!st.metronome)} aria-pressed={st.metronome}><PIcon name="metronome" size={16} />Metronome {st.metronome ? 'on' : 'off'}</button>
              <button type="button" className={`btn ${view.fretboard ? 'active-soft' : ''}`} onClick={() => setView({ fretboard: !view.fretboard })} aria-pressed={view.fretboard}><PIcon name="fretboard" size={16} />Fretboard</button>
            </div>
            <p className="small muted tnum tp-sheet-today"><Icon name="clock" size={13} />{fmtMinutes(todayS)} on this song today{hasRecording ? ` · ${soundLabel}` : ''}</p>
            <h4>Speed</h4><SpeedBox engine={engine} st={st} speedStep={speedStep} />
            <h4>Tracks</h4><TracksBox engine={engine} st={st} tracks={tracks} setTracks={setTracks} />
            <h4>View</h4><ViewBox view={view} setView={setView} />
          </div>
        </Popover>
      )}
    </div>
  )
}

/** Time and bar — fixed-width digits, updated four times a second. */
function Clock({ engine, st }: { engine: TabEngine; st: EngineState }) {
  const p = usePosition(engine)
  const bars = p.bars || st.score?.masterBars.length || 0
  return (
    <div className="tp-clock tnum" aria-live="off">
      <span className="tp-time">{fmtTime(p.time)}<span className="muted"> / {fmtTime(p.end)}</span></span>
      <span className="tp-bar muted small">Bar {bars ? p.bar + 1 : '–'}<span className="tp-bars"> of {bars || '–'}</span></span>
    </div>
  )
}

function SpeedBox({ engine, st, speedStep }: { engine: TabEngine; st: EngineState; speedStep: number }) {
  const pct = Math.round(st.speed * 100)
  return (
    <div className="pop-pad">
      <div className="sp-head"><span className="sp-v tnum">{pct}%</span>{st.score && st.score.tempo > 0 && <span className="muted small tnum">{Math.round(st.score.tempo * st.speed)} bpm</span>}</div>
      <input type="range" className="sp-range" min={25} max={200} step={Math.max(1, speedStep)} value={pct} onChange={e => engine.setSpeed(Number(e.target.value) / 100)} aria-label="Speed in percent" />
      <div className="sp-presets">
        {[50, 60, 70, 80, 90, 100, 120].map(v => <button key={v} type="button" className={`chip ${pct === v ? 'active' : ''}`} onClick={() => engine.setSpeed(v / 100)}>{v}%</button>)}
      </div>
      <p className="muted small">Slow down without changing the pitch of the tab. [ and ] step by {speedStep}%.</p>
    </div>
  )
}

function TracksBox({ engine, st, tracks, setTracks }: { engine: TabEngine; st: EngineState; tracks: number[]; setTracks: (t: number[]) => void }) {
  const score = st.score
  if (!score) return null
  const toggleShown = (i: number) => {
    const s = new Set(tracks)
    if (s.has(i)) { if (s.size > 1) s.delete(i) } else s.add(i)
    setTracks([...s].sort((a, b) => a - b))
  }
  return (
    <div className="pop-pad tr-box">
      <div className="tr-master">
        <Icon name="volume" size={16} />
        <input type="range" min={0} max={1} step={0.05} value={st.volume} onChange={e => engine.setVolume(Number(e.target.value))} aria-label="Volume" />
      </div>
      <ul className="tr-list">
        {score.tracks.map(t => {
          const shown = tracks.includes(t.index)
          const sub = isGuitarLike(t) ? `${instrumentName(t)} · ${tuningName(lowToHigh(t.staves[0]))}` : instrumentName(t)
          const muted = st.muted.includes(t.index), solo = st.solo.includes(t.index)
          return (
            <li key={t.index} className={shown ? 'shown' : ''}>
              <button type="button" className="tr-name" onClick={() => setTracks([t.index])} title="Show only this track">
                <b>{t.name || instrumentName(t)}</b><span className="muted small">{sub}</span>
              </button>
              <div className="tr-ctl">
                <button type="button" className={`tr-tg ${shown ? 'on' : ''}`} onClick={() => toggleShown(t.index)} title={shown ? 'Hide from the tab' : 'Show it too'} aria-pressed={shown}><Icon name={shown ? 'eye' : 'eye-off'} size={14} /></button>
                <button type="button" className={`tr-tg ${muted ? 'on warn' : ''}`} onClick={() => engine.setMute(t.index, !muted)} title="Mute" aria-pressed={muted}>M</button>
                <button type="button" className={`tr-tg ${solo ? 'on' : ''}`} onClick={() => engine.setSolo(t.index, !solo)} title="Solo: hear only this" aria-pressed={solo}>S</button>
                <input type="range" min={0} max={1} step={0.05} value={st.trackVolume[t.index] ?? 1} onChange={e => engine.setTrackVolume(t.index, Number(e.target.value))} aria-label={`Volume of ${t.name}`} />
              </div>
            </li>
          )
        })}
      </ul>
      <p className="muted small">Click a name to show only that track; the eye shows several together.</p>
    </div>
  )
}

function ViewBox({ view, setView }: { view: ViewPrefs; setView: (v: Partial<ViewPrefs>) => void }) {
  return (
    <div className="pop-pad vw-box">
      <label className="vw-label">Notation</label>
      <Segmented size="sm" className="pp-full" value={view.notation} onChange={v => setView({ notation: v })} label="Notation" options={[{ value: 'tab', label: 'Tab' }, { value: 'both', label: 'Tab + notes' }, { value: 'score', label: 'Notes' }]} />
      <label className="vw-label">Layout</label>
      <Segmented size="sm" className="pp-full" value={view.layout} onChange={v => setView({ layout: v })} label="Layout" options={[{ value: 'page', label: 'Page' }, { value: 'horizontal', label: 'One long line' }]} />
      <div className="vw-row">
        <span>Size</span>
        <div className="vw-step">
          <button type="button" className="btn icon-only sm" disabled={view.zoom <= 50} onClick={() => setView({ zoom: Math.max(50, view.zoom - 10) })} aria-label="Smaller"><PIcon name="zoom-out" size={15} /></button>
          <span className="tnum">{view.zoom}%</span>
          <button type="button" className="btn icon-only sm" disabled={view.zoom >= 200} onClick={() => setView({ zoom: Math.min(200, view.zoom + 10) })} aria-label="Larger"><PIcon name="zoom-in" size={15} /></button>
        </div>
      </div>
      <div className="vw-row">
        <span>Transpose <span className="muted small">(display)</span></span>
        <div className="vw-step">
          <button type="button" className="btn icon-only sm" disabled={view.transpose <= -12} onClick={() => setView({ transpose: view.transpose - 1 })} aria-label="Down a semitone"><Icon name="minus" size={15} /></button>
          <span className="tnum">{view.transpose > 0 ? '+' : ''}{view.transpose}</span>
          <button type="button" className="btn icon-only sm" disabled={view.transpose >= 12} onClick={() => setView({ transpose: view.transpose + 1 })} aria-label="Up a semitone"><Icon name="plus" size={15} /></button>
        </div>
      </div>
      <div className="vw-row"><span>Follow the music</span><Switch size="sm" checked={view.autoScroll} onChange={v => setView({ autoScroll: v })} label="Follow the music" /></div>
      <div className="vw-row"><span>Fretboard</span><Switch size="sm" checked={view.fretboard} onChange={v => setView({ fretboard: v })} label="Fretboard" /></div>
    </div>
  )
}
