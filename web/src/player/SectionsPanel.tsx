// Sections: named loops of bars with their own practice speed and the speed
// trainer (start slow, step up after a few clean loops, stop at the goal).
import { useState } from 'react'
import { api, V1 } from '../lib/api'
import type { Section, Tab } from '../lib/types'
import { Confirm, Field, Menu, Switch, rectOf, useToast, errMsg, type Anchor } from '../components/ui'
import { Icon } from '../components/icons'
import { PIcon } from './icons'
import type { EngineState } from './engine'

export interface Trainer { on: boolean; start: number; step: number; every: number; target: number }

export const SECTION_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f59f00', '#d6336c', '#0c8599', '#5f3dc4']

export function SectionsPanel({ tab, sections, setSections, st, activeId, onActivate, onSelectBars, onClear, trainer, setTrainer, passes, aiPlan, aiReady }: {
  tab: Tab; sections: Section[]; setSections: (s: Section[]) => void; st: EngineState
  activeId: number | null; onActivate: (s: Section) => void; onSelectBars: (a: number, b: number) => void; onClear: () => void
  trainer: Trainer; setTrainer: (t: Trainer) => void; passes: number
  aiPlan: () => void; aiReady: { ready: boolean; detail: string } | null
}) {
  const { toast } = useToast()
  const bars = st.score?.masterBars.length || tab.bars || 1
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [menu, setMenu] = useState<{ s: Section; at: Anchor } | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
  const [del, setDel] = useState<Section | null>(null)
  const range = st.range

  const save = async () => {
    const a = range ? range.start + 1 : parseInt(from) || 0
    const b = range ? range.end + 1 : parseInt(to) || a
    if (a < 1 || b < a || b > bars) { toast(`Pick bars between 1 and ${bars}`, 'err'); return }
    const n = name.trim() || nextName(sections)
    try {
      const s = await api.post<Section>(`${V1}/tabs/${tab.id}/sections`, { name: n, start_bar: a, end_bar: b, goal_speed: tab.goal_speed || 100, color: SECTION_COLORS[sections.length % SECTION_COLORS.length] })
      setSections([...sections, s]); setName('')
      toast(`Saved “${s.name}”`)
    } catch (e) { toast(errMsg(e), 'err') }
  }
  const update = async (s: Section, patch: Partial<Section>) => {
    try { const u = await api.put<Section>(`${V1}/sections/${s.id}`, { ...s, ...patch }); setSections(sections.map(x => x.id === s.id ? u : x)) } catch (e) { toast(errMsg(e), 'err') }
  }
  const remove = async (s: Section) => {
    try { await api.del(`${V1}/sections/${s.id}`); setSections(sections.filter(x => x.id !== s.id)) } catch (e) { toast(errMsg(e), 'err') }
  }
  const num = (v: string, lo: number, hi: number, d: number) => { const n = parseInt(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

  return (
    <div className="pp-body">
      <div className="pp-block">
        <div className="pp-block-head"><h3>Loop</h3>{range && <button type="button" className="btn ghost sm" onClick={onClear} title="Clear the selection (Esc)">Clear</button>}</div>
        {range ? (
          <p className="muted small">Bars <b className="tnum">{range.start + 1}–{range.end + 1}</b> selected{st.looping ? ', looping' : ''}. Save it to come back to it.</p>
        ) : (
          <p className="muted small">Drag across the tab to select bars, or type them here.</p>
        )}
        {!range && (
          <div className="pp-row">
            <input className="pp-num" inputMode="numeric" placeholder="From" value={from} onChange={e => setFrom(e.target.value)} aria-label="First bar" />
            <span className="muted">to</span>
            <input className="pp-num" inputMode="numeric" placeholder="To" value={to} onChange={e => setTo(e.target.value)} aria-label="Last bar" />
            <button type="button" className="btn sm" disabled={!from} onClick={() => { const a = num(from, 1, bars, 1); onSelectBars(a - 1, num(to || from, a, bars, a) - 1) }}>Loop</button>
          </div>
        )}
        <div className="pp-row">
          <input value={name} onChange={e => setName(e.target.value)} placeholder={nextName(sections)} aria-label="Section name" onKeyDown={e => { if (e.key === 'Enter') save() }} />
          <button type="button" className="btn primary sm" disabled={!range && !from} onClick={save} title="Save the selected bars as a section (S)"><Icon name="plus" size={14} />Save</button>
        </div>
      </div>

      <div className="pp-block">
        <div className="pp-block-head"><h3>Sections</h3><span className="muted small tnum">{sections.length || ''}</span></div>
        {!sections.length && <p className="muted small">No sections yet. Save the riff you're working on, the solo, the tricky bridge — each keeps its own speed.</p>}
        <ul className="pp-sections">
          {sections.map((s, i) => {
            const pct = Math.min(100, Math.round((s.best_speed / Math.max(1, s.goal_speed || 100)) * 100))
            return (
              <li key={s.id} className={activeId === s.id ? 'active' : ''}>
                <button type="button" className="pp-sec" onClick={() => onActivate(s)} title={`Loop ${s.name}${i < 9 ? ` (${i + 1})` : ''}`}>
                  <span className="pp-sec-dot" style={{ background: s.color || SECTION_COLORS[i % SECTION_COLORS.length] }} />
                  <span className="pp-sec-main">
                    <span className="pp-sec-name">{renaming?.id === s.id ? (
                      <input autoFocus value={renaming.name} onClick={e => e.stopPropagation()} onChange={e => setRenaming({ id: s.id, name: e.target.value })}
                        onBlur={() => { if (renaming.name.trim() && renaming.name !== s.name) update(s, { name: renaming.name.trim() }); setRenaming(null) }}
                        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null) }} />
                    ) : s.name}</span>
                    <span className="pp-sec-sub muted small tnum">Bars {s.start_bar}–{s.end_bar} · best {s.best_speed || 0}% of {s.goal_speed || 100}%</span>
                    <span className="pp-meter" aria-hidden><span style={{ width: pct + '%' }} /></span>
                  </span>
                  {i < 9 && <kbd className="pp-key">{i + 1}</kbd>}
                </button>
                <button type="button" className="btn ghost icon-only sm" aria-label={`More for ${s.name}`} onClick={e => setMenu({ s, at: rectOf(e.currentTarget) })}><Icon name="more" size={16} /></button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className={`pp-block ${trainer.on ? '' : 'off'}`}>
        <div className="pp-block-head">
          <h3><PIcon name="speed" size={15} /> Speed trainer</h3>
          <Switch size="sm" checked={trainer.on} onChange={on => setTrainer({ ...trainer, on })} label="Speed trainer" />
        </div>
        <p className="muted small">Starts slow and speeds up by itself after every few loops, until your goal.</p>
        <div className="pp-grid">
          <Field label="Start at"><span className="pp-unit"><input className="pp-num" inputMode="numeric" value={trainer.start} onChange={e => setTrainer({ ...trainer, start: num(e.target.value, 25, 200, trainer.start) })} />%</span></Field>
          <Field label="Step up by"><span className="pp-unit"><input className="pp-num" inputMode="numeric" value={trainer.step} onChange={e => setTrainer({ ...trainer, step: num(e.target.value, 1, 50, trainer.step) })} />%</span></Field>
          <Field label="Every"><span className="pp-unit"><input className="pp-num" inputMode="numeric" value={trainer.every} onChange={e => setTrainer({ ...trainer, every: num(e.target.value, 1, 20, trainer.every) })} />loops</span></Field>
          <Field label="Up to"><span className="pp-unit"><input className="pp-num" inputMode="numeric" value={trainer.target} onChange={e => setTrainer({ ...trainer, target: num(e.target.value, 25, 200, trainer.target) })} />%</span></Field>
        </div>
        <p className="small tnum pp-trainer-state">{trainer.on
          ? (st.looping && st.range ? <>Now <b>{Math.round(st.speed * 100)}%</b> · loop {passes}{Math.round(st.speed * 100) < trainer.target ? <> · next step in {trainer.every - (passes % trainer.every)} {trainer.every - (passes % trainer.every) === 1 ? 'loop' : 'loops'}</> : <> · at your goal</>}</> : <span className="muted">Select bars or a section and press play.</span>)
          : <span className="muted">Off: the speed stays where you set it.</span>}</p>
      </div>

      <div className="pp-block">
        <button type="button" className="btn block" onClick={aiPlan} disabled={!!aiReady && !aiReady.ready} title={aiReady && !aiReady.ready ? (aiReady.detail || 'Set up AI in Settings → AI') : 'A short plan for this song (or the selected section) from your AI'}><PIcon name="wand" size={15} />Make me a practice plan</button>
        {aiReady && !aiReady.ready && <p className="muted small">Needs AI: Pocket AI through Pocket Core, or your own OpenAI key in Settings → AI.</p>}
      </div>

      {menu && <Menu anchor={menu.at} align="right" onClose={() => setMenu(null)} items={[
        { label: 'Loop this section', icon: 'repeat', onSelect: () => onActivate(menu.s) },
        { label: 'Rename', icon: 'edit', onSelect: () => setRenaming({ id: menu.s.id, name: menu.s.name }) },
        ...(range ? [{ label: `Set to bars ${range.start + 1}–${range.end + 1}`, icon: 'move', onSelect: () => update(menu.s, { start_bar: range.start + 1, end_bar: range.end + 1 }) }] : []),
        { label: 'Reset best speed', icon: 'undo', onSelect: () => update(menu.s, { best_speed: 0, speed: trainer.start }) },
        'sep',
        { heading: 'Colour' },
        { label: <span className="pp-swatches">{SECTION_COLORS.map(c => <span key={c} role="button" tabIndex={0} aria-label={`Colour ${c}`} className={`pp-swatch ${menu.s.color === c ? 'on' : ''}`} style={{ background: c }} onClick={e => { e.stopPropagation(); update(menu.s, { color: c }); setMenu(null) }} />)}</span> },
        'sep',
        { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDel(menu.s) },
      ]} />}
      {del && <Confirm title="Delete this section?" message={<>“{del.name}” and its best speed go. Your practice time stays.</>} confirmLabel="Delete" onCancel={() => setDel(null)} onConfirm={() => { remove(del); setDel(null) }} />}
    </div>
  )
}

function nextName(sections: Section[]) {
  for (let i = sections.length + 1; ; i++) { const n = `Part ${i}`; if (!sections.some(s => s.name === n)) return n }
}
