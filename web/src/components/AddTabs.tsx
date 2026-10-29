// "Add tabs": upload files, fetch one from Songsterr, or link a Pocket Files folder.
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import { isTabFile, TAB_ACCEPT, tabName } from '../lib/guitar'
import type { Tab, UploadResult } from '../lib/types'
import { Icon } from './icons'
import { Modal, Segmented, Spinner, useDebounce, useToast } from './ui'
import { Cover } from './TabCard'
import { tuningName } from '../player/music'

export type AddMode = 'upload' | 'songsterr' | 'folder'

/** Uploads files in batches of ten; returns everything that happened. */
export async function uploadTabs(files: File[], onProgress?: (done: number) => void): Promise<UploadResult> {
  const out: UploadResult = { added: [], existing: [], errors: [] }
  for (let i = 0; i < files.length; i += 10) {
    const fd = new FormData()
    for (const f of files.slice(i, i + 10)) fd.append('file', f)
    const res = await fetch(`${V1}/tabs`, { method: 'POST', body: fd, credentials: 'same-origin' })
    const j = await res.json().catch(() => ({}))
    if (res.status === 401) window.dispatchEvent(new CustomEvent('pgt:unauthorized'))
    if (j.added || j.errors) {
      out.added.push(...(j.added || [])); out.existing.push(...(j.existing || [])); out.errors.push(...(j.errors || []))
    } else {
      for (const f of files.slice(i, i + 10)) out.errors.push({ name: f.name, error: j.error || res.statusText })
    }
    onProgress?.(Math.min(files.length, i + 10))
  }
  return out
}

export function AddTabsModal({ onClose, onAdded, initial = 'upload', files: dropped }: { onClose: () => void; onAdded: (tabs: Tab[]) => void; initial?: AddMode; files?: File[] }) {
  const { settings } = useApp()
  const [mode, setMode] = useState<AddMode>(initial)
  return (
    <Modal title="Add tabs" onClose={onClose} size="lg">
      <Segmented<AddMode> className="add-modes" value={mode} onChange={setMode} options={[
        { value: 'upload', label: 'Upload files' },
        { value: 'songsterr', label: 'Songsterr', disabled: !settings?.songsterr_available, title: settings?.songsterr_available ? undefined : 'Needs the tab converter on this server' },
        { value: 'folder', label: 'From Pocket Files' },
      ]} />
      {mode === 'upload' && <UploadPane onAdded={onAdded} onClose={onClose} dropped={dropped} />}
      {mode === 'songsterr' && <SongsterrPane onAdded={onAdded} onClose={onClose} />}
      {mode === 'folder' && <FolderPane onClose={onClose} />}
    </Modal>
  )
}

function UploadPane({ onAdded, onClose, dropped }: { onAdded: (t: Tab[]) => void; onClose: () => void; dropped?: File[] }) {
  const { toast } = useToast()
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<UploadResult | null>(null)
  const started = useRef(false)

  const send = async (list: File[]) => {
    const files = list.filter(f => isTabFile(f.name))
    const skipped = list.length - files.length
    if (!files.length) { toast(skipped ? 'Those are not tab files (Guitar Pro, MusicXML or alphaTex).' : 'No files.', 'err'); return }
    setBusy({ done: 0, total: files.length })
    try {
      const r = await uploadTabs(files, done => setBusy({ done, total: files.length }))
      setResult(r)
      if (r.added.length) onAdded(r.added)
    } finally { setBusy(null) }
  }
  if (dropped?.length && !started.current) { started.current = true; setTimeout(() => send(dropped), 0) }

  if (result) {
    const one = result.added.length === 1 && !result.errors.length && !result.existing.length
    return (
      <div className="add-result">
        {result.added.length > 0 && <p><Icon name="check-circle" size={16} className="ok-ico" /> Added {result.added.length === 1 ? <b>{tabName(result.added[0])}</b> : <b>{result.added.length} songs</b>}.</p>}
        {result.existing.length > 0 && <p className="muted"><Icon name="info" size={15} /> Already in your library: {result.existing.map(t => tabName(t)).join(', ')}.</p>}
        {result.errors.length > 0 && <div className="callout warn"><Icon name="alert" size={15} /><div>{result.errors.map(e => <div key={e.name}><b>{e.name}</b>: {e.error}</div>)}</div></div>}
        <div className="row gap end">
          <button type="button" className="btn" onClick={() => setResult(null)}>Add more</button>
          {one ? <button type="button" className="btn primary" onClick={() => { onClose(); navigate(`/tab/${result.added[0].id}`) }}><Icon name="play" size={15} />Open it</button>
            : <button type="button" className="btn primary" onClick={onClose}>Done</button>}
        </div>
      </div>
    )
  }
  return (
    <div>
      <div className={`dropzone ${over ? 'over' : ''}`} onClick={() => !busy && input.current?.click()}
        onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); if (!busy) send(Array.from(e.dataTransfer.files)) }}>
        {busy ? <><Spinner size={22} /><div>Adding {busy.done} of {busy.total}…</div></>
          : <><Icon name="upload" size={28} /><div><b>Drop tab files here</b> or tap to choose</div><div className="muted small">Guitar Pro 3–8 (.gp, .gpx, .gp5, .gp4, .gp3), MusicXML and alphaTex. Several at once is fine.</div></>}
      </div>
      <input ref={input} type="file" multiple accept={TAB_ACCEPT} hidden onChange={e => { const l = Array.from(e.target.files || []); e.target.value = ''; send(l) }} />
    </div>
  )
}

interface SongsterrHit { id: number; title: string; artist: string; url: string; tracks: number; guitars: number; bass: boolean; drums: boolean; tuning: number[]; tab_id: number }
const SONGSTERR_URL = /^https?:\/\/(www\.)?songsterr\.com\/a\/wsa\//i

function hitMeta(h: SongsterrHit): string {
  const parts = [h.tuning.length ? tuningName([...h.tuning].reverse()) : '']
  const has = [h.guitars ? `${h.guitars} guitar${h.guitars === 1 ? '' : 's'}` : '', h.bass ? 'bass' : '', h.drums ? 'drums' : ''].filter(Boolean)
  if (has.length) parts.push(has.join(', '))
  return parts.filter(Boolean).join(' · ')
}

/** Search Songsterr (or paste a tab's address) and add songs one at a time. */
function SongsterrPane({ onAdded, onClose }: { onAdded: (t: Tab[]) => void; onClose: () => void }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const dq = useDebounce(q, 350)
  const isURL = SONGSTERR_URL.test(q.trim())
  const [hits, setHits] = useState<SongsterrHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  const [adding, setAdding] = useState<Record<string, 'busy' | number>>({}) // url → busy | the tab id once added
  const [errs, setErrs] = useState<Record<string, string>>({})

  useEffect(() => {
    const term = dq.trim()
    if (isURL || term.length < 2) { setHits(null); setSearchErr(''); return }
    let live = true
    setSearching(true)
    api.get<{ ok: boolean; error?: string; results: SongsterrHit[] }>(`${V1}/songsterr/search?q=${encodeURIComponent(term)}`)
      .then(r => { if (!live) return; setHits(r.results); setSearchErr(r.ok ? '' : r.error || 'Songsterr search failed') })
      .catch(e => { if (live) { setHits([]); setSearchErr((e as Error).message) } })
      .finally(() => { if (live) setSearching(false) })
    return () => { live = false }
  }, [dq, isURL])

  const add = async (url: string) => {
    setAdding(a => ({ ...a, [url]: 'busy' })); setErrs(e => ({ ...e, [url]: '' }))
    try {
      const r = await api.post<{ tab: Tab; existing: boolean }>(`${V1}/tabs/songsterr`, { url })
      setAdding(a => ({ ...a, [url]: r.tab.id }))
      if (!r.existing) onAdded([r.tab])
    } catch (e) {
      setAdding(a => { const n = { ...a }; delete n[url]; return n })
      setErrs(x => ({ ...x, [url]: e instanceof ApiError ? e.message : String(e) }))
    }
  }
  const open = (id: number) => { onClose(); navigate(`/tab/${id}`) }
  const action = (url: string, inLibrary: number) => {
    const st = adding[url]
    const id = typeof st === 'number' ? st : inLibrary
    if (id) return <button type="button" className="btn sm" onClick={() => open(id)}><Icon name="play" size={14} />{typeof st === 'number' ? 'Added · open' : 'In library · open'}</button>
    return <button type="button" className="btn sm primary" disabled={st === 'busy'} onClick={() => add(url)}>{st === 'busy' ? <><Spinner />Getting it…</> : <><Icon name="plus" size={14} />Add</>}</button>
  }

  return (
    <div className="ss-pane">
      <div className="search-box">
        <Icon name="search" size={16} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search Songsterr: a song or an artist, or paste a tab's address" autoFocus aria-label="Search Songsterr" />
        {searching && <Spinner />}
      </div>
      {isURL ? (
        <div className="ss-url">
          <span className="muted small grow">Get this tab from its address.</span>
          {action(q.trim(), 0)}
          {errs[q.trim()] && <div className="callout warn"><Icon name="alert" size={15} /><div>{errs[q.trim()]}</div></div>}
        </div>
      ) : hits === null ? (
        <p className="muted small ss-hint">Find a song on songsterr.com and add it with every track. Each song takes a few seconds to turn into a Guitar Pro file.</p>
      ) : (
        <>
          {searchErr && <div className="callout warn"><Icon name="alert" size={15} /><div>{searchErr}</div></div>}
          {!searchErr && hits.length === 0 && <p className="muted small ss-hint">Nothing found on Songsterr for that.</p>}
          <div className="ss-list">
            {hits.map(h => (
              <div key={h.id} className="ss-row">
                <Cover tab={{ id: h.id, title: h.title, artist: h.artist }} size={36} />
                <div className="ss-text">
                  <b className="ellipsis">{h.title}</b>
                  <span className="muted small ellipsis">{h.artist}{hitMeta(h) ? ` · ${hitMeta(h)}` : ''}</span>
                  {errs[h.url] && <span className="bad small">{errs[h.url]}</span>}
                </div>
                {action(h.url, h.tab_id)}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function FolderPane({ onClose }: { onClose: () => void }) {
  const { settings } = useApp()
  const connected = settings?.files_configured
  return (
    <div className="add-folder">
      <p>Keep your tabs in a folder in <b>Pocket Files</b> and they appear here by themselves: new files are added, changed ones are read again, every 15 minutes or when you press <i>Look for new tabs</i>.</p>
      {connected
        ? <p className="muted small">Pocket Files is connected{settings?.files_via === 'core' ? ' through Pocket Core' : ''}. Pick the folders under Settings → Tab folders.</p>
        : <p className="muted small">Pocket Files is not connected yet{settings?.files_detail ? `: ${settings.files_detail}` : ''}.</p>}
      <div className="row gap end">
        <Link to="/settings/folders" className="btn primary" onClick={onClose}><Icon name="folder" size={15} />Tab folders</Link>
      </div>
    </div>
  )
}
