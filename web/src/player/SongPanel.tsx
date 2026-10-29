// About the song: where you are with it, notes, goal speed, the tracks in
// the file and where the file came from.
import { useEffect, useRef, useState } from 'react'
import type { Tab, TabStatus } from '../lib/types'
import { Field, Segmented, download } from '../components/ui'
import { Icon } from '../components/icons'
import { PIcon } from './icons'
import { fmtMinutes } from './music'

export const STATUS: { value: TabStatus; label: string; short: string }[] = [
  { value: 'to_learn', label: 'Want to learn', short: 'Want' },
  { value: 'learning', label: 'Learning', short: 'Learning' },
  { value: 'polishing', label: 'Polishing', short: 'Polishing' },
  { value: 'mastered', label: 'Can play it', short: 'Can play' },
]

export function SongPanel({ tab, patch, onPrint, todayS, sessionS }: { tab: Tab; patch: (p: Partial<Tab>) => void; onPrint: () => void; todayS: number; sessionS: number }) {
  const [notes, setNotes] = useState(tab.notes)
  const [tags, setTags] = useState(tab.tags)
  const notesRef = useRef(tab.notes)
  useEffect(() => { setNotes(tab.notes); setTags(tab.tags); notesRef.current = tab.notes }, [tab.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // notes save themselves a moment after you stop typing
  useEffect(() => {
    if (notes === notesRef.current) return
    const t = window.setTimeout(() => { notesRef.current = notes; patch({ notes }) }, 800)
    return () => window.clearTimeout(t)
  }, [notes]) // eslint-disable-line react-hooks/exhaustive-deps
  const num = (v: string, lo: number, hi: number) => { const n = parseInt(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo }

  return (
    <div className="pp-body">
      <div className="pp-block">
        <h3>Where you are</h3>
        <Segmented size="sm" className="pp-status" options={STATUS.map(s => ({ value: s.value, label: s.short, title: s.label }))} value={tab.status} onChange={v => patch({ status: v })} label="Status" />
        <div className="pp-stats small">
          <span><b className="tnum">{fmtMinutes(tab.practice_s + sessionS)}</b><span className="muted"> practised</span></span>
          <span><b className="tnum">{fmtMinutes(todayS)}</b><span className="muted"> today</span></span>
          <span><b className="tnum">{tab.best_speed || 0}%</b><span className="muted"> best speed</span></span>
        </div>
      </div>

      <div className="pp-block">
        <div className="pp-grid">
          <Field label="Difficulty">
            <span className="pp-stars" role="radiogroup" aria-label="Difficulty">
              {[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={tab.difficulty === n} aria-label={`${n} of 5`} className={n <= tab.difficulty ? 'on' : ''} onClick={() => patch({ difficulty: tab.difficulty === n ? 0 : n })}><Icon name="star" size={16} /></button>)}
            </span>
          </Field>
          <Field label="Goal speed"><span className="pp-unit"><input className="pp-num" inputMode="numeric" defaultValue={tab.goal_speed || 100} key={'g' + tab.id + tab.goal_speed} onBlur={e => { const v = num(e.target.value, 25, 200); if (v !== tab.goal_speed) patch({ goal_speed: v }) }} />%</span></Field>
          <Field label="Capo"><span className="pp-unit"><input className="pp-num" inputMode="numeric" defaultValue={tab.capo || 0} key={'c' + tab.id + tab.capo} onBlur={e => { const v = num(e.target.value, 0, 12); if (v !== tab.capo) patch({ capo: v }) }} />fret</span></Field>
        </div>
        <Field label="Tags" help="Separate with commas: riffs, acoustic, for the band">
          <input value={tags} onChange={e => setTags(e.target.value)} onBlur={() => { if (tags !== tab.tags) patch({ tags }) }} placeholder="riffs, acoustic" />
        </Field>
        <Field label="Notes">
          <textarea className="pp-notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Fingering, where you keep slipping, which pick, the tone…" rows={5} />
        </Field>
      </div>

      <div className="pp-block">
        <h3>In this file</h3>
        <dl className="pp-facts small">
          {tab.album && <><dt>Album</dt><dd>{tab.album}</dd></>}
          {tab.tabber && <><dt>Tab by</dt><dd>{tab.tabber}</dd></>}
          {tab.tempo > 0 && <><dt>Tempo</dt><dd className="tnum">{tab.tempo} bpm</dd></>}
          {tab.bars > 0 && <><dt>Length</dt><dd className="tnum">{tab.bars} bars{tab.duration_s ? ` · ${Math.floor(tab.duration_s / 60)}:${String(tab.duration_s % 60).padStart(2, '0')}` : ''}</dd></>}
          {tab.tuning && <><dt>Tuning</dt><dd>{tab.tuning}</dd></>}
          <dt>From</dt><dd>{tab.source_label || tab.source}{tab.source === 'songsterr' && tab.source_ref && <> · <a href={tab.source_ref} target="_blank" rel="noreferrer">open <Icon name="external" size={12} /></a></>}</dd>
        </dl>
        {tab.source_missing && <div className="callout warn small"><Icon name="alert" size={15} /><div>This file is no longer in its Pocket Files folder. The copy here still works; delete it from the library if you removed it on purpose.</div></div>}
        {tab.tracks.length > 0 && (
          <ul className="pp-tracks small">
            {tab.tracks.map(t => <li key={t.index}><span className="pp-tr-name">{t.name}</span><span className="muted">{t.drums ? 'Drums' : `${t.instrument}${t.strings ? ` · ${t.strings} strings · ${t.tuning}` : ''}`}</span></li>)}
          </ul>
        )}
        <div className="pp-row">
          <button type="button" className="btn sm" onClick={() => download(`/api/v1/tabs/${tab.id}/file`)}><Icon name="download" size={14} />Original file</button>
          <button type="button" className="btn sm" onClick={onPrint}><PIcon name="printer" size={14} />Print</button>
        </div>
      </div>
    </div>
  )
}
