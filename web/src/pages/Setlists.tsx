// Setlists: songs in an order, to play through one after another.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import { fmtLength, tabName } from '../lib/guitar'
import type { Setlist, Tab, TabList } from '../lib/types'
import { Icon } from '../components/icons'
import { announceChange, openCreate, useCrumb, useOnChange } from '../components/Layout'
import { Cover, StatusChip, tabMeta } from '../components/TabCard'
import { Confirm, Empty, Field, Loading, Modal, useDebounce, useToast } from '../components/ui'

export function SetlistModal({ list, onClose, onSaved }: { list?: Setlist; onClose: () => void; onSaved: (l: Setlist) => void }) {
  const { toast } = useToast()
  const [name, setName] = useState(list?.name || '')
  const [note, setNote] = useState(list?.note || '')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!name.trim()) { toast('Give the setlist a name', 'err'); return }
    setBusy(true)
    try {
      onSaved(list ? await api.put<Setlist>(`${V1}/setlists/${list.id}`, { name, note }) : await api.post<Setlist>(`${V1}/setlists`, { name, note, tab_ids: [] }))
    } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal title={list ? 'Rename setlist' : 'New setlist'} onClose={onClose} size="sm" footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={save}>{list ? 'Save' : 'Create'}</button></>}>
      <form className="stack" onSubmit={e => { e.preventDefault(); save() }}>
        <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} placeholder="Sunday campfire" autoFocus /></Field>
        <Field label="Note" help="Optional, for yourself"><input value={note} onChange={e => setNote(e.target.value)} placeholder="Easy ones first" /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

export default function Setlists() {
  const [lists, setLists] = useState<Setlist[] | null>(null)
  const load = useCallback(() => { api.get<Setlist[]>(`${V1}/setlists`).then(setLists).catch(() => setLists([])) }, [])
  useEffect(load, [load])
  useOnChange(load)
  if (!lists) return <Loading />
  return (
    <div className="setlists">
      <div className="page-actions">
        <p className="muted">Songs in the order you want to play them: for a gig, a jam, or your warm-up. Play a setlist and the player moves on to the next song.</p>
        <button type="button" className="btn primary" onClick={() => openCreate('setlist')}><Icon name="plus" size={15} />New setlist</button>
      </div>
      {lists.length === 0 ? <Empty title="No setlists yet" icon="list-music">Make one, then add songs from the library or right here.</Empty> : (
        <div className="setlist-grid">
          {lists.map(l => (
            <Link key={l.id} to={`/setlists/${l.id}`} className="setlist-card card">
              <span className="setlist-ico"><Icon name="list-music" size={20} /></span>
              <span className="grow">
                <b className="ellipsis">{l.name}</b>
                <span className="muted small">{l.count} {l.count === 1 ? 'song' : 'songs'}{l.duration_s ? ` · ${fmtLength(l.duration_s)}` : ''}{l.note ? ` · ${l.note}` : ''}</span>
              </span>
              <Icon name="chevron-right" size={16} className="muted" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export function SetlistPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [list, setList] = useState<Setlist | null>(null)
  const [missing, setMissing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [rename, setRename] = useState(false)
  const [del, setDel] = useState(false)
  const drag = useRef<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  useCrumb(list?.name)
  const load = useCallback(() => { api.get<Setlist>(`${V1}/setlists/${id}`).then(setList).catch(() => setMissing(true)) }, [id])
  useEffect(load, [load])

  const save = async (ids: number[]) => {
    if (!list) return
    setList({ ...list, tabs: ids.map(i => list.tabs!.find(t => t.id === i)!).filter(Boolean), tab_ids: ids })
    try { setList(await api.put<Setlist>(`${V1}/setlists/${list.id}`, { tab_ids: ids })) } catch (e) { toast((e as Error).message, 'err'); load() }
  }
  const move = (from: number, to: number) => {
    if (!list || from === to || to < 0 || to >= list.tab_ids.length) return
    const ids = [...list.tab_ids]
    const [x] = ids.splice(from, 1)
    ids.splice(to, 0, x)
    save(ids)
  }

  if (missing) return <Empty title="This setlist is gone" icon="list-music"><Link to="/setlists" className="btn">All setlists</Link></Empty>
  if (!list) return <Loading />
  const tabs = list.tabs || []
  return (
    <div className="setlist-page">
      <div className="page-actions">
        <div className="grow">
          <h2 className="setlist-title">{list.name}</h2>
          <p className="muted small">{tabs.length} {tabs.length === 1 ? 'song' : 'songs'}{list.duration_s ? ` · about ${fmtLength(list.duration_s)} at full speed` : ''}{list.note ? ` · ${list.note}` : ''}</p>
        </div>
        <button type="button" className="btn" onClick={() => setRename(true)}><Icon name="edit" size={15} /><span className="hide-phone">Rename</span></button>
        <button type="button" className="btn ghost icon-only" title="Delete the setlist" aria-label="Delete the setlist" onClick={() => setDel(true)}><Icon name="trash" size={16} /></button>
        <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={15} />Add songs</button>
        <button type="button" className="btn primary" disabled={!tabs.length} onClick={() => navigate(`/tab/${tabs[0].id}?setlist=${list.id}`)}><Icon name="play" size={15} />Play</button>
      </div>
      {tabs.length === 0 ? <Empty title="No songs yet" icon="music"><button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} />Add songs</button></Empty> : (
        <ol className="setlist-items card">
          {tabs.map((t, i) => (
            <li key={t.id} className={`setlist-item ${over === i ? 'over' : ''}`} draggable
              onDragStart={e => { drag.current = i; e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={e => { if (drag.current === null) return; e.preventDefault(); setOver(i) }}
              onDragLeave={() => setOver(o => o === i ? null : o)}
              onDrop={e => { e.preventDefault(); if (drag.current !== null) move(drag.current, i); drag.current = null; setOver(null) }}
              onDragEnd={() => { drag.current = null; setOver(null) }}>
              <span className="grip" title="Drag to reorder"><Icon name="grip" size={16} /></span>
              <span className="setlist-n tnum">{i + 1}</span>
              <Link to={`/tab/${t.id}?setlist=${list.id}`} className="setlist-song">
                <Cover tab={t} size={34} />
                <span className="grow ellipsis"><b>{t.title || t.file_name}</b><span className="muted small block ellipsis">{[t.artist, tabMeta(t)].filter(Boolean).join(' · ')}</span></span>
              </Link>
              <StatusChip tab={t} />
              <span className="setlist-moves">
                <button type="button" className="btn ghost icon-only xs" aria-label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="chevron-up" size={15} /></button>
                <button type="button" className="btn ghost icon-only xs" aria-label="Move down" disabled={i === tabs.length - 1} onClick={() => move(i, i + 1)}><Icon name="chevron-down" size={15} /></button>
                <button type="button" className="btn ghost icon-only xs" aria-label={`Take ${tabName(t)} out`} title="Take out of the setlist" onClick={() => save(list.tab_ids.filter(x => x !== t.id))}><Icon name="x" size={15} /></button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {adding && <SongPicker have={list.tab_ids} onClose={() => setAdding(false)} onPick={t => save([...list.tab_ids, t.id])} />}
      {rename && <SetlistModal list={list} onClose={() => setRename(false)} onSaved={l => { setRename(false); setList(l); announceChange() }} />}
      {del && <Confirm title="Delete this setlist?" confirmLabel="Delete" message={<>The songs stay in your library.</>} onCancel={() => setDel(false)}
        onConfirm={async () => { setDel(false); try { await api.del(`${V1}/setlists/${list.id}`); announceChange(); navigate('/setlists') } catch (e) { toast((e as Error).message, 'err') } }} />}
    </div>
  )
}

function SongPicker({ have, onClose, onPick }: { have: number[]; onClose: () => void; onPick: (t: Tab) => void }) {
  const [q, setQ] = useState('')
  const dq = useDebounce(q, 150)
  const [tabs, setTabs] = useState<Tab[] | null>(null)
  const [added, setAdded] = useState<number[]>([])
  useEffect(() => { api.get<TabList>(`${V1}/tabs?sort=recent&limit=60${dq.trim() ? `&q=${encodeURIComponent(dq.trim())}` : ''}`).then(r => setTabs(r.tabs)).catch(() => setTabs([])) }, [dq])
  return (
    <Modal title="Add songs" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
      <div className="search-box"><Icon name="search" size={16} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search your library…" autoFocus aria-label="Search" /></div>
      <div className="pick-list">
        {!tabs ? <Loading /> : tabs.length === 0 ? <p className="muted center">No songs found.</p> : tabs.map(t => {
          const inList = have.includes(t.id) || added.includes(t.id)
          return (
            <button key={t.id} type="button" className="pick-row" disabled={inList} onClick={() => { onPick(t); setAdded(a => [...a, t.id]) }}>
              <Cover tab={t} size={30} /><span className="grow ellipsis"><b>{t.title || t.file_name}</b> <span className="muted">{t.artist}</span></span>
              {inList ? <Icon name="check" size={15} /> : <Icon name="plus" size={15} />}
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
