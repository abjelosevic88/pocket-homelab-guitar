// "Add tabs": upload files, fetch one from Songsterr, or link a Pocket Files folder.
import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import { isTabFile, TAB_ACCEPT, tabName } from '../lib/guitar'
import type { Tab, UploadResult } from '../lib/types'
import { Icon } from './icons'
import { Modal, Segmented, Spinner, useToast } from './ui'

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
        { value: 'songsterr', label: 'From Songsterr', disabled: !settings?.songsterr_available, title: settings?.songsterr_available ? undefined : 'Needs the tab converter on this server' },
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

function SongsterrPane({ onAdded, onClose }: { onAdded: (t: Tab[]) => void; onClose: () => void }) {
  const navigate = useNavigate()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<{ tab: Tab; existing: boolean } | null>(null)
  const go = async () => {
    setBusy(true); setErr('')
    try {
      const r = await api.post<{ tab: Tab; existing: boolean }>(`${V1}/tabs/songsterr`, { url: url.trim() })
      setDone(r)
      if (!r.existing) onAdded([r.tab])
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)) } finally { setBusy(false) }
  }
  if (done) return (
    <div className="add-result">
      <p><Icon name="check-circle" size={16} className="ok-ico" /> {done.existing ? 'Already in your library' : 'Added'}: <b>{tabName(done.tab)}</b>.</p>
      <div className="row gap end">
        <button type="button" className="btn" onClick={() => { setDone(null); setUrl('') }}>Add another</button>
        <button type="button" className="btn primary" onClick={() => { onClose(); navigate(`/tab/${done.tab.id}`) }}><Icon name="play" size={15} />Open it</button>
      </div>
    </div>
  )
  return (
    <form onSubmit={e => { e.preventDefault(); if (url.trim() && !busy) go() }}>
      <p className="muted small">Paste the address of a tab on songsterr.com. It is turned into a Guitar Pro file with every track, which takes a few seconds.</p>
      <div className="row gap">
        <input className="grow" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.songsterr.com/a/wsa/…-tab-s12345" autoFocus inputMode="url" aria-label="Songsterr address" />
        <button type="submit" className="btn primary" disabled={!url.trim() || busy}>{busy ? <Spinner /> : <Icon name="download" size={15} />}Get tab</button>
      </div>
      {err && <div className="callout warn" style={{ marginTop: 12 }}><Icon name="alert" size={15} /><div>{err}</div></div>}
    </form>
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
