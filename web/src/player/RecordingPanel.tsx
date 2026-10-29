// The original recording: find the song in your Navidrome, link it to the
// tab, and play along with it at your practice speed.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import type { MusicSearch, MusicSong, Recording, Tab } from '../lib/types'
import { Segmented, Spinner, errMsg } from '../components/ui'
import { Icon } from '../components/icons'
import type { SoundMode } from './recording'
import { fmtTime } from './music'

export function RecordingPanel({ tab, setRecording, mode, setMode }: { tab: Tab; setRecording: (r: Recording | null) => void; mode: SoundMode; setMode: (m: SoundMode) => void }) {
  const rec = tab.recording
  const [q, setQ] = useState(`${tab.artist} ${tab.title}`.trim())
  const [res, setRes] = useState<MusicSearch | null>(null)
  const [busy, setBusy] = useState(false)
  const [searching, setSearching] = useState(!rec)

  const search = async (query = q) => {
    if (!query.trim()) return
    setBusy(true)
    try { setRes(await api.get<MusicSearch>(`${V1}/music/search?q=${encodeURIComponent(query.trim())}`)) } catch (e) { setRes({ ok: false, error: errMsg(e), songs: [] }) } finally { setBusy(false) }
  }
  useEffect(() => { if (searching && !res) search() }, [searching]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (s: MusicSong) => { setRecording({ id: s.id, title: s.title, artist: s.artist, album: s.album, duration: s.duration, offset_ms: 0 }); setSearching(false); setMode('both') }
  const nudge = (ms: number) => rec && setRecording({ ...rec, offset_ms: rec.offset_ms + ms })
  const notConnected = res?.not_connected

  return (
    <div className="pp-body">
      <div className="pp-block">
        <h3>Play along with the record</h3>
        <p className="muted small">Link the song from your Navidrome. It plays with the tab, at your practice speed, and keeps its pitch when slowed down.</p>
      </div>

      {rec && !searching && (
        <div className="pp-block">
          <div className="pp-rec">
            <span className="pp-rec-art"><Icon name="music" size={18} /></span>
            <span className="pp-rec-main"><b>{rec.title}</b><span className="muted small">{[rec.artist, rec.album].filter(Boolean).join(' · ')}{rec.duration ? ` · ${fmtTime(rec.duration * 1000)}` : ''}</span></span>
          </div>
          <Segmented size="sm" className="pp-full" label="What you hear" value={mode} onChange={setMode} options={[
            { value: 'tab', label: 'Tab sound', title: 'Only the tab’s own instruments' },
            { value: 'recording', label: 'Record', title: 'Only the recording; the cursor still follows' },
            { value: 'both', label: 'Both', title: 'The recording with the tab on top' },
          ]} />
          <div className="pp-offset">
            <span className="small">Line up <span className="muted">(the record starts</span> <b className="tnum">{(rec.offset_ms / 1000).toFixed(2)} s</b> <span className="muted">{rec.offset_ms >= 0 ? 'ahead' : 'behind'})</span></span>
            <div className="pp-row">
              <button type="button" className="btn sm" onClick={() => nudge(-1000)}>−1 s</button>
              <button type="button" className="btn sm" onClick={() => nudge(-100)}>−0.1</button>
              <button type="button" className="btn sm" onClick={() => nudge(100)}>+0.1</button>
              <button type="button" className="btn sm" onClick={() => nudge(1000)}>+1 s</button>
              <button type="button" className="btn ghost sm" disabled={!rec.offset_ms} onClick={() => setRecording({ ...rec, offset_ms: 0 })}>Reset</button>
            </div>
            <p className="muted small">If the record runs early, move it back; if it lags, move it forward. Most recordings need a small shift for the intro.</p>
          </div>
          <div className="pp-row">
            <button type="button" className="btn sm" onClick={() => { setSearching(true); setRes(null) }}><Icon name="search" size={14} />Another recording</button>
            <button type="button" className="btn ghost sm" onClick={() => { setRecording(null); setMode('tab') }}><Icon name="x" size={14} />Unlink</button>
          </div>
        </div>
      )}

      {searching && (
        <div className="pp-block">
          <form className="pp-row" onSubmit={e => { e.preventDefault(); search() }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Artist and song" aria-label="Search your music" />
            <button type="submit" className="btn sm" disabled={busy}>{busy ? <Spinner /> : <Icon name="search" size={14} />}Find</button>
          </form>
          {notConnected && (
            <div className="callout info small"><Icon name="info" size={15} /><div>{res?.error || 'Navidrome is not connected.'} <Link to="/settings/apps">Connect Navidrome in Settings → Connected apps</Link>.</div></div>
          )}
          {res && !res.ok && !notConnected && <p className="small" style={{ color: 'var(--danger)' }}>{res.error}</p>}
          {res?.ok && !(res.songs || []).length && <p className="muted small">Nothing found. Try only the song title.</p>}
          <ul className="pp-results">
            {(res?.songs || []).map(s => (
              <li key={s.id}><button type="button" onClick={() => pick(s)}>
                <span className="pp-rec-main"><b>{s.title}</b><span className="muted small">{[s.artist, s.album].filter(Boolean).join(' · ')}</span></span>
                <span className="muted small tnum">{fmtTime(s.duration * 1000)}</span>
              </button></li>
            ))}
          </ul>
          {rec && <button type="button" className="btn ghost sm" onClick={() => setSearching(false)}>Keep “{rec.title}”</button>}
        </div>
      )}
    </div>
  )
}
