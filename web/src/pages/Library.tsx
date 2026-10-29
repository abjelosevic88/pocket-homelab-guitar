// The library: every song, searchable and filterable, as cards or a list.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import { analyzePending } from '../lib/analyze'
import { STATUSES, tabName } from '../lib/guitar'
import type { Facets, Folder, Setlist, Tab, TabList, TabStatus } from '../lib/types'
import { Icon } from '../components/icons'
import { announceChange, openCreate, useOnChange } from '../components/Layout'
import { TabCard, TabRow } from '../components/TabCard'
import { Select } from '../components/Select'
import { Confirm, Empty, Field, Loading, type MenuItem, Modal, Segmented, Spinner, useDebounce, useToast } from '../components/ui'

const VIEW_KEY = 'pgt-library-view'
const SORTS = [
  { value: 'artist', label: 'Artist' }, { value: 'title', label: 'Title' }, { value: 'recent', label: 'Played lately' },
  { value: 'added', label: 'Newest' }, { value: 'practice', label: 'Most practised' },
]

export default function Library() {
  const { toast } = useToast()
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const [q, setQ] = useState(sp.get('q') || '')
  const dq = useDebounce(q, 200)
  const status = (sp.get('status') || '') as TabStatus | ''
  const fav = sp.get('favorite') === '1'
  const tuning = sp.get('tuning') || ''
  const tag = sp.get('tag') || ''
  const sort = sp.get('sort') || 'artist'
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem(VIEW_KEY) as 'grid' | 'list') || 'grid')
  const [list, setList] = useState<TabList | null>(null)
  const [facets, setFacets] = useState<Facets | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [syncing, setSyncing] = useState(false)
  const [edit, setEdit] = useState<Tab | null>(null)
  const [del, setDel] = useState<Tab | null>(null)
  const [addTo, setAddTo] = useState<Tab | null>(null)

  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }) }
  const load = useCallback(() => {
    const p = new URLSearchParams({ sort })
    if (dq.trim()) p.set('q', dq.trim())
    if (status) p.set('status', status)
    if (fav) p.set('favorite', '1')
    if (tuning) p.set('tuning', tuning)
    if (tag) p.set('tag', tag)
    api.get<TabList>(`${V1}/tabs?${p}`).then(setList).catch(e => toast(e.message, 'err'))
    api.get<Facets>(`${V1}/tabs/facets`).then(setFacets).catch(() => {})
  }, [dq, status, fav, tuning, tag, sort, toast])
  useEffect(load, [load])
  useOnChange(load)
  useEffect(() => { api.get<Folder[]>(`${V1}/folders`).then(setFolders).catch(() => {}) }, [])

  // read the tabs the browser has not seen yet, quietly, a few at a time
  useEffect(() => {
    if (!list) return
    analyzePending(list.tabs, t => setList(l => l && { ...l, tabs: l.tabs.map(x => x.id === t.id ? t : x) }))
  }, [list?.total]) // eslint-disable-line react-hooks/exhaustive-deps

  const patch = async (t: Tab, body: Partial<Tab>) => {
    try {
      const u = await api.put<Tab>(`${V1}/tabs/${t.id}`, body)
      setList(l => l && { ...l, tabs: l.tabs.map(x => x.id === u.id ? u : x) })
      if ('status' in body || 'favorite' in body) announceChange()
    } catch (e) { toast((e as Error).message, 'err') }
  }
  const syncAll = async () => {
    setSyncing(true)
    try {
      const r = await api.post<{ ok: boolean; result: { added: number; updated: number; missing: number }; errors?: string[] }>(`${V1}/folders/sync`)
      const n = r.result
      toast(r.ok ? (n.added || n.updated || n.missing ? `${n.added} new, ${n.updated} changed, ${n.missing} gone from the folder` : 'No new tabs in your folders') : (r.errors || []).join('; '), r.ok ? 'ok' : 'err')
      announceChange()
    } catch (e) { toast((e as Error).message, 'err') } finally { setSyncing(false) }
  }

  const menu = (t: Tab) => (): MenuItem[] => [
    { label: 'Open', icon: 'play', onSelect: () => navigate(`/tab/${t.id}`) },
    { label: 'Edit details…', icon: 'edit', onSelect: () => setEdit(t) },
    { label: 'Add to a setlist…', icon: 'list-music', onSelect: () => setAddTo(t) },
    'sep',
    { heading: 'Where you are with it' },
    ...STATUSES.map(s => ({ label: s.label, checked: t.status === s.id, onSelect: () => patch(t, { status: s.id }) })),
    'sep',
    { label: 'Download the file', icon: 'download', onSelect: () => { window.location.href = `${V1}/tabs/${t.id}/file?dl=1` } },
    { label: 'Remove from the library…', icon: 'trash', danger: true, onSelect: () => setDel(t) },
  ]

  const counts = facets?.status
  const chips: { id: string; label: string; n?: number }[] = [
    { id: '', label: 'All', n: facets?.total },
    ...STATUSES.map(s => ({ id: s.id, label: s.label, n: counts?.[s.id] })),
  ]
  const filtered = !!(dq || status || fav || tuning || tag)
  const tuningOpts = useMemo(() => (facets?.tunings || []).map(t => ({ value: t.name, label: `${t.name} (${t.count})` })), [facets])
  const tagOpts = useMemo(() => (facets?.tags || []).map(t => ({ value: t.name, label: `${t.name} (${t.count})` })), [facets])

  return (
    <div className="library">
      <div className="lib-toolbar">
        <div className="search-box grow">
          <Icon name="search" size={16} />
          <input value={q} onChange={e => { setQ(e.target.value); set('q', e.target.value) }} placeholder="Search songs, artists, tags…" aria-label="Search the library" />
          {q && <button type="button" className="btn ghost icon-only xs" aria-label="Clear" onClick={() => { setQ(''); set('q', '') }}><Icon name="x" size={14} /></button>}
        </div>
        <Select ariaLabel="Sort" value={sort} onChange={v => set('sort', v === 'artist' ? '' : v)} options={SORTS} className="lib-sort" />
        <Segmented<'grid' | 'list'> label="View" value={view} onChange={v => { setView(v); localStorage.setItem(VIEW_KEY, v) }} options={[{ value: 'grid', label: <Icon name="grid" size={15} />, title: 'Cards' }, { value: 'list', label: <Icon name="list" size={15} />, title: 'List' }]} />
        {folders.length > 0 && <button type="button" className="btn" onClick={syncAll} disabled={syncing} title="Look for new tabs in your Pocket Files folders">{syncing ? <Spinner /> : <Icon name="refresh" size={15} />}<span className="hide-phone">Look for new tabs</span></button>}
        <button type="button" className="btn primary hide-phone" onClick={() => openCreate('add')}><Icon name="plus" size={15} />Add tabs</button>
      </div>
      <div className="lib-filters">
        <div className="chips">
          {chips.map(c => <button key={c.id || 'all'} type="button" className={`chip ${status === c.id && !fav ? 'active' : ''}`} onClick={() => { const n = new URLSearchParams(sp); n.delete('favorite'); if (c.id) n.set('status', c.id); else n.delete('status'); setSp(n, { replace: true }) }}>{c.label}{c.n !== undefined && <span className="chip-n tnum">{c.n}</span>}</button>)}
          <button type="button" className={`chip ${fav ? 'active' : ''}`} onClick={() => set('favorite', fav ? '' : '1')}><Icon name="star" size={13} />Favourites{facets && <span className="chip-n tnum">{facets.favorites}</span>}</button>
        </div>
        <div className="row gap lib-selects">
          {tuningOpts.length > 1 && <Select ariaLabel="Tuning" value={tuning} onChange={v => set('tuning', v)} options={tuningOpts} placeholder="Any tuning" clearLabel="Any tuning" className="sm" />}
          {tagOpts.length > 0 && <Select ariaLabel="Tag" value={tag} onChange={v => set('tag', v)} options={tagOpts} placeholder="Any tag" clearLabel="Any tag" className="sm" />}
        </div>
      </div>

      {!list ? <Loading /> : list.tabs.length === 0 ? (
        filtered ? <Empty title="Nothing matches" icon="search">Try fewer words or another filter.</Empty> : (
          <Empty title="Your library is empty" icon="book-open">
            <p>Upload Guitar Pro, MusicXML or alphaTex files, point to a folder in Pocket Files, or paste a Songsterr address.</p>
            <div className="row gap center"><button type="button" className="btn primary" onClick={() => openCreate('add')}><Icon name="upload" size={15} />Upload tabs</button><button type="button" className="btn" onClick={() => openCreate('folder')}><Icon name="folder" size={15} />Use a folder</button></div>
          </Empty>
        )
      ) : view === 'grid' ? (
        <div className="tab-grid">{list.tabs.map(t => <TabCard key={t.id} tab={t} menu={menu(t)} onFavorite={x => patch(x, { favorite: !x.favorite })} />)}</div>
      ) : (
        <div className="tab-list card">{list.tabs.map(t => <TabRow key={t.id} tab={t} menu={menu(t)} onFavorite={x => patch(x, { favorite: !x.favorite })} />)}</div>
      )}
      {list && list.total > list.tabs.length && <p className="muted small center">Showing {list.tabs.length} of {list.total}. Search to narrow it down.</p>}

      {edit && <EditTabModal tab={edit} onClose={() => setEdit(null)} onSaved={u => { setEdit(null); setList(l => l && { ...l, tabs: l.tabs.map(x => x.id === u.id ? u : x) }); announceChange() }} />}
      {addTo && <AddToSetlistModal tab={addTo} onClose={() => setAddTo(null)} />}
      {del && <Confirm title="Remove this song?" confirmLabel="Remove"
        message={<>Remove <b>{tabName(del)}</b> from your library, with its sections. Your practice time stays in the log.{del.source === 'files' && !del.source_missing && <> The file stays in your Pocket Files folder, so it comes back with the next look for new tabs unless you delete it there.</>}</>}
        onCancel={() => setDel(null)}
        onConfirm={async () => { const t = del; setDel(null); try { await api.del(`${V1}/tabs/${t.id}`); toast('Removed'); announceChange() } catch (e) { toast((e as Error).message, 'err') } }} />}
    </div>
  )
}

export function EditTabModal({ tab, onClose, onSaved }: { tab: Tab; onClose: () => void; onSaved: (t: Tab) => void }) {
  const { toast } = useToast()
  const [f, setF] = useState({ title: tab.title, artist: tab.artist, album: tab.album, tags: tab.tags, status: tab.status, difficulty: tab.difficulty, capo: tab.capo, goal_speed: tab.goal_speed })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!f.title.trim()) { toast('A song needs a title', 'err'); return }
    setBusy(true)
    try { onSaved(await api.put<Tab>(`${V1}/tabs/${tab.id}`, f)) } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal title="Song details" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
      <form className="stack" onSubmit={e => { e.preventDefault(); save() }}>
        <Field label="Title"><input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} autoFocus /></Field>
        <div className="two-col">
          <Field label="Artist"><input value={f.artist} onChange={e => setF({ ...f, artist: e.target.value })} /></Field>
          <Field label="Album"><input value={f.album} onChange={e => setF({ ...f, album: e.target.value })} /></Field>
        </div>
        <Field label="Where you are with it"><Segmented value={f.status} onChange={v => setF({ ...f, status: v })} options={STATUSES.map(s => ({ value: s.id, label: s.short }))} /></Field>
        <div className="three-col">
          <Field label="Difficulty"><Select ariaLabel="Difficulty" value={String(f.difficulty)} onChange={v => setF({ ...f, difficulty: Number(v) || 0 })} options={[{ value: '0', label: 'Not rated' }, ...[1, 2, 3, 4, 5].map(n => ({ value: String(n), label: ['', 'Easy', 'Fair', 'Medium', 'Hard', 'Very hard'][n] }))]} /></Field>
          <Field label="Capo"><input type="number" min={0} max={24} value={f.capo} onChange={e => setF({ ...f, capo: Math.max(0, Math.min(24, Number(e.target.value) || 0)) })} /></Field>
          <Field label="Goal speed" help="Percent of the written tempo"><input type="number" min={10} max={300} step={5} value={f.goal_speed} onChange={e => setF({ ...f, goal_speed: Number(e.target.value) || 100 })} /></Field>
        </div>
        <Field label="Tags" help="Separate with commas, like: blues, fingerstyle"><input value={f.tags} onChange={e => setF({ ...f, tags: e.target.value })} /></Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

export function AddToSetlistModal({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const { toast } = useToast()
  const [lists, setLists] = useState<Setlist[] | null>(null)
  const [name, setName] = useState('')
  useEffect(() => { api.get<Setlist[]>(`${V1}/setlists`).then(setLists).catch(() => setLists([])) }, [])
  const add = async (l: Setlist) => {
    if (l.tab_ids.includes(tab.id)) { toast('Already in that setlist'); onClose(); return }
    try { await api.put(`${V1}/setlists/${l.id}`, { tab_ids: [...l.tab_ids, tab.id] }); toast(`Added to ${l.name}`); onClose() } catch (e) { toast((e as Error).message, 'err') }
  }
  const create = async () => {
    if (!name.trim()) return
    try { const l = await api.post<Setlist>(`${V1}/setlists`, { name: name.trim(), tab_ids: [tab.id] }); toast(`Added to ${l.name}`); onClose() } catch (e) { toast((e as Error).message, 'err') }
  }
  return (
    <Modal title="Add to a setlist" onClose={onClose} size="sm">
      {!lists ? <Loading /> : (
        <div className="stack">
          {lists.map(l => <button key={l.id} type="button" className="pick-row" onClick={() => add(l)}><Icon name="list-music" size={16} /><span className="grow">{l.name}</span><span className="muted small">{l.count} songs</span>{l.tab_ids.includes(tab.id) && <Icon name="check" size={15} />}</button>)}
          <form className="row gap" onSubmit={e => { e.preventDefault(); create() }}>
            <input className="grow" value={name} onChange={e => setName(e.target.value)} placeholder="A new setlist…" aria-label="New setlist name" autoFocus={lists.length === 0} />
            <button type="submit" className="btn primary" disabled={!name.trim()}>Create</button>
          </form>
        </div>
      )}
    </Modal>
  )
}
