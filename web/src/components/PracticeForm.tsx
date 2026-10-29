// Log a practice by hand (or change one): a song from the library or
// something else, when, how long, how fast, a note.
import { useEffect, useMemo, useState } from 'react'
import { api, V1 } from '../lib/api'
import { todayISO } from '../lib/format'
import type { PracticeInput, PracticeSession, TabList } from '../lib/types'
import { Select } from './Select'
import { Field, Modal, Segmented, errMsg, useToast } from './ui'
import { Icon } from './icons'
import { localISO } from '../tools/common'
import { WHAT } from '../tools/PracticeTimer'

const pad = (n: number) => String(n).padStart(2, '0')

export function PracticeModal({ onClose, onSaved, initial }: { onClose: () => void; onSaved: (p: PracticeSession) => void; initial?: Partial<PracticeSession> }) {
  const { toast } = useToast()
  const editing = !!initial?.id
  const start = initial?.started_at ? new Date(initial.started_at) : null
  const now = new Date()
  const [kind, setKind] = useState<'tab' | 'free'>(initial?.kind === 'free' || (editing && !initial?.tab_id) ? 'free' : 'tab')
  const [tabId, setTabId] = useState(initial?.tab_id ? String(initial.tab_id) : '')
  const [title, setTitle] = useState(initial?.kind === 'free' ? initial.title || '' : '')
  const [date, setDate] = useState(start ? `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}` : initial?.date || todayISO())
  const [time, setTime] = useState(start ? `${pad(start.getHours())}:${pad(start.getMinutes())}` : `${pad(Math.max(0, now.getHours() - 1))}:${pad(now.getMinutes())}`)
  const [mins, setMins] = useState(initial?.duration_s ? String(Math.max(1, Math.round(initial.duration_s / 60))) : '20')
  const [speed, setSpeed] = useState(initial?.speed ? String(initial.speed) : '')
  const [note, setNote] = useState(initial?.note || '')
  const [busy, setBusy] = useState(false)
  const [tabs, setTabs] = useState<TabList | null>(null)

  useEffect(() => { api.get<TabList>(`${V1}/tabs?sort=recent&limit=500`).then(setTabs).catch(() => setTabs({ tabs: [], total: 0 })) }, [])
  const options = useMemo(() => {
    const list = (tabs?.tabs || []).map(t => ({ value: String(t.id), label: t.title || t.file_name, hint: t.artist }))
    // a deleted song: keep its title visible
    if (tabId && !list.some(o => o.value === tabId) && initial?.title) list.unshift({ value: tabId, label: initial.title, hint: '' })
    return list
  }, [tabs, tabId, initial?.title])

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const m = Number(mins)
    if (kind === 'tab' && !tabId) { toast('Pick the song you practised, or choose “Something else”', 'err'); return }
    if (kind === 'free' && !title.trim()) { toast('Say what you practised', 'err'); return }
    if (!m || m < 1 || m > 600) { toast('Minutes are 1 to 600', 'err'); return }
    const when = new Date(`${date}T${time || '12:00'}`)
    if (Number.isNaN(when.getTime())) { toast('Check the date and time', 'err'); return }
    if (when.getTime() > Date.now() + 60_000) { toast('That time is still in the future', 'err'); return }
    const sp = speed ? Number(speed) : 0
    if (speed && (!sp || sp < 10 || sp > 300)) { toast('Speed is 10 to 300 percent', 'err'); return }
    const body: PracticeInput = {
      kind, tab_id: kind === 'tab' ? Number(tabId) : null, title: kind === 'free' ? title.trim() : undefined,
      started_at: localISO(when), ended_at: localISO(new Date(when.getTime() + m * 60000)), duration_s: Math.round(m * 60), speed: sp, note: note.trim(),
    }
    if (editing) { body.loops = initial?.loops; body.section_id = kind === 'tab' ? initial?.section_id ?? null : null }
    setBusy(true)
    try {
      const p = editing ? await api.put<PracticeSession>(`${V1}/practice/${initial!.id}`, body) : await api.post<PracticeSession>(`${V1}/practice`, body)
      toast(editing ? 'Practice changed' : 'Practice logged')
      onSaved(p)
    } catch (err) { toast(errMsg(err), 'err') } finally { setBusy(false) }
  }

  return (
    <Modal title={editing ? 'Change practice' : 'Log practice'} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="submit" form="gt-practice-form" className="btn primary" disabled={busy}><Icon name="check" size={15} />{editing ? 'Save' : 'Log it'}</button>
    </>}>
      <form id="gt-practice-form" className="stack" onSubmit={submit}>
        <Segmented<'tab' | 'free'> value={kind} onChange={setKind} label="What" options={[{ value: 'tab', label: 'A song' }, { value: 'free', label: 'Something else' }]} />
        {kind === 'tab'
          ? <Field label="Song" group>
              <Select value={tabId} onChange={setTabId} options={options} ariaLabel="Song" placeholder={tabs && !tabs.tabs.length ? 'No songs in your library yet' : 'Search your songs…'} />
            </Field>
          : <Field label="What did you practise?" group>
              <div className="chips">{WHAT.map(w => <button key={w} type="button" className={`chip ${title === w ? 'active' : ''}`} onClick={() => setTitle(w)}>{w}</button>)}</div>
              <input value={title} onChange={e => setTitle(e.target.value)} maxLength={80} placeholder="Scales, a chord change, a riff…" />
            </Field>}
        <div className="gt-form-grid">
          <Field label="Day"><input type="date" value={date} max={todayISO()} onChange={e => setDate(e.target.value)} required /></Field>
          <Field label="Started"><input type="time" value={time} onChange={e => setTime(e.target.value)} /></Field>
          <Field label="Minutes"><input inputMode="numeric" value={mins} onChange={e => setMins(e.target.value.replace(/\D/g, '').slice(0, 3))} required /></Field>
          <Field label="Top speed" help={kind === 'tab' ? 'Percent of the song’s tempo' : 'Optional'}><input inputMode="numeric" value={speed} onChange={e => setSpeed(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="100" /></Field>
        </div>
        <Field label="Note"><textarea rows={3} value={note} onChange={e => setNote(e.target.value)} maxLength={2000} placeholder="What went well, what to work on next time" /></Field>
      </form>
    </Modal>
  )
}
