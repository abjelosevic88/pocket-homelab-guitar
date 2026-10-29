import { AskButton } from '../components/AskButton'
import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import type { APIToken, ConnMode, FilesBrowse, FilesSpace, Folder, Habit, HabitRule, Settings as SettingsT, User } from '../lib/types'
import { DATE_FORMATS, TIME_FORMATS, fmtBytes, fmtDateTime, type DateFormat, type TimeFormat } from '../lib/format'
import { Avatar, Confirm, CoreHint, Field, Loading, Modal, Segmented, SettingRow, Switch, Tabs, useAsync, useIsMobile, useToast } from '../components/ui'
import { Icon } from '../components/icons'
import { Select } from '../components/Select'
import { ShortcutsSheet } from '../components/ShortcutsSheet'
import { PocketModelSelect } from '../components/PocketModelSelect'

type TabId = 'general' | 'player' | 'folders' | 'reminders' | 'apps' | 'ai' | 'profile' | 'people' | 'tokens' | 'data' | 'about'

const TABS: { id: TabId; label: string; icon: string; sub: string }[] = [
  { id: 'general', label: 'General', icon: 'target', sub: 'Your daily practice goal and how dates look.' },
  { id: 'player', label: 'Player', icon: 'sliders', sub: 'How songs look and play when you open them, and the speed trainer.' },
  { id: 'folders', label: 'Tab folders', icon: 'folder', sub: 'Folders in Pocket Files whose tabs appear in your library, and where new tabs are saved.' },
  { id: 'reminders', label: 'Reminders', icon: 'bell', sub: 'A nudge at the times you choose, your streak in the evening and the weekly report.' },
  { id: 'apps', label: 'Connected apps', icon: 'layers', sub: 'Pocket Files (your tab folders), Pocket Habits (a day’s practice ticks a habit) and the original recordings from Navidrome.' },
  { id: 'ai', label: 'AI', icon: 'sparkles', sub: 'Who writes practice plans and answers questions: Pocket AI through Core, or your own OpenAI key.' },
  { id: 'profile', label: 'Profile', icon: 'user', sub: 'Your name, email and password.' },
  { id: 'people', label: 'People', icon: 'users', sub: 'Everyone who has an account on this box.' },
  { id: 'tokens', label: 'API & shortcuts', icon: 'key', sub: 'Personal tokens for Homepage widgets, Siri Shortcuts and scripts.' },
  { id: 'data', label: 'Backup & data', icon: 'database', sub: 'Download the database, export or import your practice.' },
  { id: 'about', label: 'About', icon: 'info', sub: 'Version, numbers and the server.' },
]

export default function Settings() {
  const { tab: raw } = useParams()
  const navigate = useNavigate()
  const mobile = useIsMobile()
  const tab: TabId = TABS.find(t => t.id === raw)?.id || 'general'
  const current = TABS.find(t => t.id === tab)!
  const go = (id: TabId) => navigate(`/settings/${id}`, { replace: true })
  useEffect(() => { document.querySelector('.set-content')?.scrollTo({ top: 0 }) }, [tab])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, .menu, .sel-pop')) navigate('/') }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [navigate])
  return (
    <div className="set-page">
      <header className="set-header">
        <button type="button" className="btn ghost icon-only" aria-label="Back" title="Back (esc)" onClick={() => navigate('/')}><Icon name="chevron-left" size={18} /></button>
        <img src="/favicon.svg" alt="" width={24} height={24} className="set-logo" />
        <h1>Settings</h1>
        <span style={{ flex: 1 }} />
        <AskButton />
      </header>
      {mobile && <div className="set-tabs-mobile"><Tabs tabs={TABS.map(t => ({ id: t.id, label: t.label, icon: t.icon }))} value={tab} onChange={go} /></div>}
      <div className="set-body">
        {!mobile && (
          <nav className="set-nav" aria-label="Settings sections">
            {TABS.map(t => (
              <button key={t.id} type="button" className={`set-nav-item ${t.id === tab ? 'active' : ''}`} aria-current={t.id === tab ? 'page' : undefined} onClick={() => go(t.id)}>
                <Icon name={t.icon} size={16} />{t.label}
              </button>
            ))}
          </nav>
        )}
        <main className="set-content">
          <div className="set-inner" key={tab}>
            <div className="set-title"><h2>{current.label}</h2><p>{current.sub}</p></div>
            {tab === 'general' && <General />}
            {tab === 'player' && <Player />}
            {tab === 'folders' && <Folders />}
            {tab === 'reminders' && <Reminders />}
            {tab === 'apps' && <Integrations />}
            {tab === 'ai' && <AITab />}
            {tab === 'profile' && <Profile />}
            {tab === 'people' && <Users />}
            {tab === 'tokens' && <Tokens />}
            {tab === 'data' && <Data />}
            {tab === 'about' && <About />}
          </div>
        </main>
      </div>
    </div>
  )
}

function Section({ title, sub, icon, actions, children }: { title: React.ReactNode; sub?: React.ReactNode; icon?: string; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="set-section">
      <div className="set-section-head">
        {icon && <span className="set-app-ico"><Icon name={icon} size={17} /></span>}
        <div className="grow"><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
        {actions && <div className="row">{actions}</div>}
      </div>
      {children && <div className="set-section-body">{children}</div>}
    </section>
  )
}

function useSettingsForm() {
  const { settings, setSettings, user } = useApp()
  const { toast } = useToast()
  const [f, setF] = useState<SettingsT | null>(settings)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!f && settings) setF(settings) }, [settings]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (patch?: Partial<SettingsT>) => {
    if (!f) return
    setBusy(true)
    try { const s = await api.put<SettingsT>(`${V1}/settings`, { ...f, ...patch }); setSettings(s); setF(s); toast('Saved') } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return { f, setF, save, busy, isAdmin: user?.role === 'admin' }
}

function useTester() {
  const [test, setTest] = useState<Record<string, string>>({})
  const run = async (which: string, url: string, key: string, extra: Record<string, string> = {}) => {
    setTest(t => ({ ...t, [which]: 'testing…' }))
    try { const r = await api.post<{ ok: boolean; message?: string; error?: string }>(`${V1}/integrations/test`, { which, url, key, ...extra }); setTest(t => ({ ...t, [which]: r.ok ? `✓ ${r.message}` : `✕ ${r.error}` })) } catch (e) { setTest(t => ({ ...t, [which]: `✕ ${(e as Error).message}` })) }
  }
  const status = (which: string) => <span className={`small ${test[which]?.startsWith('✓') ? 'ok' : test[which]?.startsWith('✕') ? 'bad' : 'muted'}`}>{test[which]}</span>
  return { run, status }
}

const DAYS: [number, string][] = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [7, 'Sunday']]
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))

function General() {
  const { f, setF, save, busy, isAdmin } = useSettingsForm()
  if (!f) return <Loading />
  return (
    <div className="stack loose">
      <Section title="Goal" icon="target">
        <SettingRow title="Minutes a day" help="Your daily goal: the ring on Home and goal days in your practice. 0 = any playing counts."><input type="number" min={0} max={600} value={f.daily_goal_min} onChange={e => setF({ ...f, daily_goal_min: Number(e.target.value) })} className="set-time" /></SettingRow>
        <SettingRow title="Days a week" help="How many goal days a week you aim for."><input type="number" min={0} max={7} value={f.weekly_goal_days} onChange={e => setF({ ...f, weekly_goal_days: Number(e.target.value) })} className="set-time" /></SettingRow>
      </Section>
      <Section title="Dates" icon="calendar">
        <SettingRow title="Week starts on"><Segmented size="sm" value={f.week_start} onChange={v => setF({ ...f, week_start: v })} options={[{ value: 1, label: 'Monday' }, { value: 6, label: 'Saturday' }, { value: 7, label: 'Sunday' }]} /></SettingRow>
        <SettingRow title="Date format"><Select ariaLabel="Date format" value={f.date_format} onChange={v => setF({ ...f, date_format: v as DateFormat })} options={DATE_FORMATS.map(d => ({ value: d.id, label: d.label }))} /></SettingRow>
        <SettingRow title="Time format"><Select ariaLabel="Time format" value={f.time_format} onChange={v => setF({ ...f, time_format: v as TimeFormat })} options={TIME_FORMATS.map(d => ({ value: d.id, label: d.label }))} /></SettingRow>
        {isAdmin && <SettingRow title="App title" help="Shown in the sidebar for everyone on this box."><input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></SettingRow>}
      </Section>
      <div className="row"><button type="button" className="btn primary" onClick={() => save()} disabled={busy}>Save changes</button></div>
    </div>
  )
}

function Player() {
  const { f, setF, save, busy } = useSettingsForm()
  if (!f) return <Loading />
  return (
    <div className="stack loose">
      <Section title="How songs look" icon="music" sub="What a song shows when you open it the first time. Change it in the player and that song keeps your choice.">
        <SettingRow title="Notation"><Segmented size="sm" value={f.notation} onChange={v => setF({ ...f, notation: v })} options={[{ value: 'tab', label: 'Tab' }, { value: 'both', label: 'Tab and notes' }, { value: 'score', label: 'Notes' }]} /></SettingRow>
        <SettingRow title="Layout" help="Pages scroll down; one line scrolls sideways like a ticker."><Segmented size="sm" value={f.layout} onChange={v => setF({ ...f, layout: v })} options={[{ value: 'page', label: 'Pages' }, { value: 'horizontal', label: 'One line' }]} /></SettingRow>
        <SettingRow title="Size"><div className="row"><input type="range" min={50} max={200} step={10} value={f.zoom} onChange={e => setF({ ...f, zoom: Number(e.target.value) })} aria-label="Size" /><span className="tnum small">{f.zoom}%</span></div></SettingRow>
        <SettingRow title="Colours in dark mode" help="Light notes on dark, like the rest of the app, or always black on white like paper."><Segmented size="sm" value={f.score_colors} onChange={v => setF({ ...f, score_colors: v })} options={[{ value: 'theme', label: 'Follow the app' }, { value: 'paper', label: 'Paper' }]} /></SettingRow>
        <SettingRow title="Follow the cursor" help="The page scrolls along while a song plays."><Switch checked={f.auto_scroll} onChange={v => setF({ ...f, auto_scroll: v })} label="Follow the cursor" /></SettingRow>
        <SettingRow title="Fretboard" help="A fretboard under the tab showing the notes being played."><Switch checked={f.fretboard} onChange={v => setF({ ...f, fretboard: v })} label="Fretboard" /></SettingRow>
        <SettingRow title="Left-handed fretboard"><Switch checked={f.left_handed} onChange={v => setF({ ...f, left_handed: v })} label="Left-handed" /></SettingRow>
      </Section>
      <Section title="Playing" icon="play">
        <SettingRow title="Count-in" help="One bar of clicks before the song starts."><Switch checked={f.count_in} onChange={v => setF({ ...f, count_in: v })} label="Count-in" /></SettingRow>
        <SettingRow title="Metronome" help="Clicks along with the song."><Switch checked={f.metronome} onChange={v => setF({ ...f, metronome: v })} label="Metronome" /></SettingRow>
        <SettingRow title="Speed step" help="How much slower or faster the − and + buttons go (and the [ and ] keys)."><div className="row"><input type="number" min={1} max={25} value={f.speed_step} onChange={e => setF({ ...f, speed_step: Number(e.target.value) })} className="set-time" /><span className="muted small">%</span></div></SettingRow>
        <SettingRow title="Keep the screen on" help="While a song plays."><Switch checked={f.keep_awake} onChange={v => setF({ ...f, keep_awake: v })} label="Keep awake" /></SettingRow>
      </Section>
      <Section title="Speed trainer" icon="trending-up" sub="Loop a part and let it get faster by itself: it starts slow, and after a few clean loops it speeds up, until it reaches your goal. These are the starting values for new sections.">
        <SettingRow title="Start at"><div className="row"><input type="number" min={10} max={200} step={5} value={f.trainer_start} onChange={e => setF({ ...f, trainer_start: Number(e.target.value) })} className="set-time" /><span className="muted small">% of the tempo</span></div></SettingRow>
        <SettingRow title="Speed up by"><div className="row"><input type="number" min={1} max={25} value={f.trainer_step} onChange={e => setF({ ...f, trainer_step: Number(e.target.value) })} className="set-time" /><span className="muted small">%</span></div></SettingRow>
        <SettingRow title="After every"><div className="row"><input type="number" min={1} max={20} value={f.trainer_every} onChange={e => setF({ ...f, trainer_every: Number(e.target.value) })} className="set-time" /><span className="muted small">loops</span></div></SettingRow>
        <SettingRow title="Up to"><div className="row"><input type="number" min={10} max={200} step={5} value={f.trainer_target} onChange={e => setF({ ...f, trainer_target: Number(e.target.value) })} className="set-time" /><span className="muted small">%</span></div></SettingRow>
      </Section>
      <div className="row"><button type="button" className="btn primary" onClick={() => save()} disabled={busy}>Save changes</button></div>
    </div>
  )
}

function Folders() {
  const { f, save } = useSettingsForm()
  const { toast } = useToast()
  const { data: folders, reload } = useAsync(() => api.get<Folder[]>(`${V1}/folders`), [])
  const [pick, setPick] = useState(false)
  const [syncing, setSyncing] = useState<number | null>(null)
  const [unlink, setUnlink] = useState<Folder | null>(null)
  useEffect(() => {
    if (!folders?.some(x => x.syncing)) return
    const t = setTimeout(reload, 2000)
    return () => clearTimeout(t)
  }, [folders, reload])
  if (!f) return <Loading />
  const coreOn = f.core_configured && f.core_registered !== false
  const connected = f.files_configured && f.files_mode !== 'off'
  const sync = async (x: Folder) => {
    setSyncing(x.id)
    try {
      const r = await api.post<{ ok: boolean; error?: string; result?: { added: number; updated: number; missing: number; files: number } }>(`${V1}/folders/${x.id}/sync`)
      if (r.ok && r.result) toast(`${r.result.files} tab files: ${r.result.added} new, ${r.result.updated} changed, ${r.result.missing} gone`)
      else toast(r.error || 'failed', 'err')
      reload()
    } catch (e) { toast((e as Error).message, 'err') } finally { setSyncing(null) }
  }
  return (
    <div className="stack loose">
      <Section title="Your tab folders in Pocket Files" icon="folder" actions={connBadge(f.files_mode === 'core' && !coreOn ? 'off' : f.files_mode, f.files_via)}
        sub="Every tab file in these folders (and the folders inside them) appears in your library. New files are added and changed ones are read again every 15 minutes; a file you delete there stays here, marked as gone, with its practice. Guitar keeps its own copy of each tab, so songs open even when Pocket Files is away.">
        {!connected && <div className="callout info"><Icon name="info" size={15} /><div>Connect Pocket Files first, under <Link to="/settings/apps">Connected apps</Link>{f.files_detail ? ` (${f.files_detail})` : ''}.{!coreOn && <CoreHint />}</div></div>}
        {folders && folders.length > 0 && (
          <div className="folder-list">
            {folders.map(x => (
              <div key={x.id} className="folder-row">
                <Icon name="folder" size={18} />
                <div className="grow">
                  <b>{x.label || x.path}</b>
                  <div className="muted small">{x.space_name}{x.path} · {x.syncing ? 'reading…' : `${x.tab_count} tabs`}{x.last_sync_at ? ` · looked ${fmtDateTime(x.last_sync_at)}` : ''}</div>
                  {x.last_error && <div className="bad small">{x.last_error}</div>}
                </div>
                {f.save_folder_id === x.id && <span className="badge ok" title="New tabs are saved here">new tabs go here</span>}
                <button type="button" className="btn sm" onClick={() => sync(x)} disabled={syncing === x.id || x.syncing}>{syncing === x.id ? 'Looking…' : 'Look now'}</button>
                <button type="button" className="btn ghost sm danger-text" onClick={() => setUnlink(x)}>Unlink</button>
              </div>
            ))}
          </div>
        )}
        {folders && folders.length === 0 && connected && <p className="muted small">No folders yet.</p>}
        <div className="row"><button type="button" className="btn primary" disabled={!connected} onClick={() => setPick(true)}><Icon name="folder-plus" size={15} />Add a folder</button></div>
      </Section>
      <Section title="Where new tabs are saved" icon="upload" sub="Uploads and tabs from Songsterr can go into one of your folders, so the folder keeps every tab you have. Otherwise they are kept in Pocket Guitar only.">
        <Select ariaLabel="Where new tabs go" value={String(f.save_folder_id || 0)} onChange={v => save({ save_folder_id: Number(v) })}
          options={[{ value: '0', label: 'Only in Pocket Guitar' }, ...(folders || []).map(x => ({ value: String(x.id), label: `${x.space_name}${x.path}` }))]} />
      </Section>
      {pick && <FolderPicker onClose={() => setPick(false)} onAdded={() => { setPick(false); reload() }} />}
      {unlink && <UnlinkFolder folder={unlink} onClose={() => setUnlink(null)} onDone={() => { setUnlink(null); reload() }} />}
    </div>
  )
}

function UnlinkFolder({ folder, onClose, onDone }: { folder: Folder; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast()
  const go = async (keep: boolean) => {
    try { await api.del(`${V1}/folders/${folder.id}${keep ? '?keep=1' : ''}`); toast('Folder unlinked'); onDone() } catch (e) { toast((e as Error).message, 'err') }
  }
  return (
    <Modal title="Unlink this folder?" onClose={onClose} size="sm" footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn danger" onClick={() => go(false)}>Remove its songs</button>
      <button type="button" className="btn primary" onClick={() => go(true)}>Keep its songs</button>
    </>}>
      <p>Pocket Guitar stops looking at <b>{folder.space_name}{folder.path}</b>. Nothing is deleted in Pocket Files.</p>
      <p className="muted small">Keep its songs: they stay in your library with their sections and practice. Remove: the {folder.tab_count} songs from this folder leave the library (their practice time stays in the log).</p>
    </Modal>
  )
}

function FolderPicker({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { toast } = useToast()
  const { data: spaces } = useAsync(() => api.get<{ ok: boolean; error?: string; spaces: FilesSpace[] }>(`${V1}/files/spaces`), [])
  const [space, setSpace] = useState('')
  const [path, setPath] = useState('/')
  const [browse, setBrowse] = useState<FilesBrowse | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!space && spaces?.spaces?.length) setSpace(spaces.spaces[0].id) }, [spaces, space])
  useEffect(() => {
    if (!space) return
    setBrowse(null)
    api.get<FilesBrowse>(`${V1}/files/browse?space=${encodeURIComponent(space)}&path=${encodeURIComponent(path)}`).then(setBrowse).catch(e => setBrowse({ ok: false, error: e.message, space, path, folders: [], tab_files: 0, writable: false }))
  }, [space, path])
  const up = path === '/' ? null : path.replace(/\/[^/]+$/, '') || '/'
  const add = async () => {
    setBusy(true)
    try { await api.post(`${V1}/folders`, { space, path }); toast('Folder added: reading its tabs now'); onAdded() } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal title="Pick a folder in Pocket Files" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy || !browse?.ok} onClick={add}>Use this folder</button></>}>
      {!spaces ? <Loading /> : !spaces.ok ? <p className="bad small">{spaces.error}</p> : (
        <div className="stack">
          {spaces.spaces.length > 1 && <Select ariaLabel="Place" value={space} onChange={v => { setSpace(v); setPath('/') }} options={spaces.spaces.map(s => ({ value: s.id, label: s.name, hint: s.kind === 'mount' ? 'server folder' : s.kind === 'share' ? 'shared with you' : undefined }))} />}
          <div className="picker-path"><Icon name="folder" size={15} /><b className="ellipsis">{spaces.spaces.find(s => s.id === space)?.name}{path}</b>{browse?.ok && <span className="muted small">{browse.tab_files} tab files here</span>}</div>
          <div className="pick-list">
            {up !== null && <button type="button" className="pick-row" onClick={() => setPath(up)}><Icon name="chevron-left" size={15} /><span className="grow">Up one folder</span></button>}
            {!browse ? <Loading /> : !browse.ok ? <p className="bad small">{browse.error}</p> : browse.folders.length === 0 ? <p className="muted small">No folders inside.</p>
              : browse.folders.map(x => <button key={x.path} type="button" className="pick-row" onClick={() => setPath(x.path)}><Icon name="folder" size={15} /><span className="grow ellipsis">{x.name}</span><Icon name="chevron-right" size={14} className="muted" /></button>)}
          </div>
          <p className="muted small">Tabs in folders inside this one are included too.</p>
        </div>
      )}
    </Modal>
  )
}

function Reminders() {
  const { f, setF, save, busy } = useSettingsForm()
  const { toast } = useToast()
  const { run, status } = useTester()
  const [add, setAdd] = useState('18:00')
  if (!f) return <Loading />
  const weekly = async () => { try { const r = await api.post<{ ok: boolean; sent?: boolean; error?: string; report?: string }>(`${V1}/notify/weekly`); if (r.ok) toast(r.sent ? 'Weekly report sent' : 'Report ready (no push URL): ' + (r.report || '').split('\n')[0]); else toast(r.error || 'failed', 'err') } catch (e) { toast((e as Error).message, 'err') } }
  const toggleDay = (d: number) => { const s = String(d); setF({ ...f, reminder_days: f.reminder_days.includes(s) ? f.reminder_days.replace(s, '') : [...f.reminder_days, s].sort().join('') }) }
  const addTime = () => { if (/^\d{2}:\d{2}$/.test(add) && !f.reminder_times.includes(add)) setF({ ...f, reminder_times: [...f.reminder_times, add].sort() }) }
  return (
    <div className="stack loose">
      <Section title="Push" icon="bell" actions={<span className={`badge ${f.notify_configured ? 'ok' : ''}`}>{f.notify_configured ? 'on' : 'not set'}</span>}
        sub={<>Where reminders go: an Apprise gateway (<code>…/notify/&lt;key&gt;</code>), an ntfy topic URL, or any webhook that takes JSON.</>}>
        <SettingRow title="URL" stack><input value={f.notify_url} onChange={e => setF({ ...f, notify_url: e.target.value })} placeholder="http://apprise:8000/notify/guitar" /></SettingRow>
        <SettingRow title="Format"><Segmented value={f.notify_format} onChange={v => setF({ ...f, notify_format: v })} options={[{ value: 'apprise', label: 'Apprise' }, { value: 'ntfy', label: 'ntfy' }, { value: 'json', label: 'JSON' }]} size="sm" /></SettingRow>
      </Section>
      <Section title="Practice reminders" icon="clock" sub="Server time. The reminder names the song you are learning.">
        <SettingRow title="At" stack>
          <div className="row wrap">
            {f.reminder_times.map(t => <span key={t} className="chip time-chip">{t}<button type="button" aria-label={`Remove ${t}`} onClick={() => setF({ ...f, reminder_times: f.reminder_times.filter(x => x !== t) })}><Icon name="x" size={12} /></button></span>)}
            {f.reminder_times.length === 0 && <span className="muted small">No reminders.</span>}
            <input type="time" value={add} onChange={e => setAdd(e.target.value)} className="set-time" aria-label="Reminder time" />
            <button type="button" className="btn sm" onClick={addTime} disabled={f.reminder_times.length >= 6}><Icon name="plus" size={13} />Add</button>
          </div>
        </SettingRow>
        <SettingRow title="On" stack>
          <div className="row wrap">{DAYS.map(([d, l]) => <button key={d} type="button" className={`chip day-chip ${f.reminder_days.includes(String(d)) ? 'on' : ''}`} onClick={() => toggleDay(d)}>{l.slice(0, 3)}</button>)}</div>
        </SettingRow>
        <SettingRow title="Skip when done" help="No reminder once today’s goal is reached."><Switch checked={f.reminder_skip_done} onChange={v => setF({ ...f, reminder_skip_done: v })} label="Skip when done" /></SettingRow>
      </Section>
      <Section title="Other pushes" icon="flame">
        <SettingRow title="Streak at risk" help="One evening nudge when you have a streak and have not played yet today.">
          <div className="row"><Switch checked={f.notify_streak} onChange={v => setF({ ...f, notify_streak: v })} label="Streak nudge" />{f.notify_streak && <Select ariaLabel="Streak hour" value={String(f.streak_hour)} onChange={v => setF({ ...f, streak_hour: Number(v) })} options={HOURS} />}</div>
        </SettingRow>
        <SettingRow title="Weekly report" help="Minutes, days and what you played most.">
          <div className="row wrap"><Switch checked={f.notify_weekly} onChange={v => setF({ ...f, notify_weekly: v })} label="Weekly report" />{f.notify_weekly && <><Select ariaLabel="Weekly day" value={String(f.weekly_day)} onChange={v => setF({ ...f, weekly_day: Number(v) })} options={DAYS.map(([d, l]) => ({ value: String(d), label: l }))} /><Select ariaLabel="Weekly hour" value={String(f.weekly_hour)} onChange={v => setF({ ...f, weekly_hour: Number(v) })} options={HOURS} /></>}</div>
        </SettingRow>
      </Section>
      <div className="row wrap">
        <button type="button" className="btn primary" onClick={() => save()} disabled={busy}>Save changes</button>
        <button type="button" className="btn" onClick={() => run('notify', f.notify_url, '', { format: f.notify_format })} disabled={!f.notify_url}><Icon name="mail" size={15} />Send a test</button>
        <button type="button" className="btn" onClick={weekly}><Icon name="chart" size={15} />Send the weekly report now</button>
        {status('notify')}
      </div>
    </div>
  )
}

function Integrations() {
  const { f, setF, save, busy } = useSettingsForm()
  const { run, status } = useTester()
  const { toast } = useToast()
  const { data: rules, reload } = useAsync(() => api.get<HabitRule[]>(`${V1}/rules`), [])
  const [edit, setEdit] = useState<HabitRule | null | 'new'>(null)
  if (!f) return <Loading />
  const coreOn = f.core_configured && f.core_registered !== false
  const eff = (m: ConnMode): ConnMode => !coreOn && m === 'core' ? 'off' : m
  const toggleRule = async (r: HabitRule) => { try { await api.put(`${V1}/rules/${r.id}`, { ...r, enabled: !r.enabled }); reload() } catch (e) { toast((e as Error).message, 'err') } }
  const delRule = async (r: HabitRule) => { try { await api.del(`${V1}/rules/${r.id}`); reload() } catch (e) { toast((e as Error).message, 'err') } }
  const musicMode = eff(f.music_mode)
  return (
    <div className="stack loose">
      <div className="callout info"><Icon name="info" size={15} /><div>These connections are yours. Through <b>Pocket Core</b> Guitar acts as you in your own Pocket apps with nothing to paste (switch it off for yourself in Pocket Core → Settings → Apps acting for me); <b>Direct</b> uses a URL and an API token you enter.{!coreOn && <CoreHint />}</div></div>
      <Section title="Pocket Files — your tab folders" icon="folder" actions={connBadge(eff(f.files_mode), f.files_via)}
        sub="Point to the folders where your tabs live and they appear in the library; new tabs can be saved there too. Pick the folders under Tab folders.">
        <Connection app="Pocket Files" mode={f.files_mode} via={f.files_via} detail={f.files_detail} core={coreOn} hasToken={!!f.files_token}
          onMode={m => save({ files_mode: m })} onDisconnect={() => save({ files_url: '', files_token: '' })}
          test={<><button type="button" className="btn sm" onClick={() => run('files', f.files_url, f.files_token)}>Test connection</button>{status('files')}</>}
          direct={<div className="two-col tight">
            <Field label="URL" help="Inside Docker use http://host.docker.internal:PORT or the service name."><input value={f.files_url} onChange={e => setF({ ...f, files_url: e.target.value })} placeholder="http://host.docker.internal:8187" /></Field>
            <Field label="App password" help="Pocket Files → Settings → App passwords"><input value={f.files_token} onChange={e => setF({ ...f, files_token: e.target.value })} autoComplete="off" /></Field>
          </div>} />
        {eff(f.files_mode) !== 'off' && <div className="row"><Link to="/settings/folders" className="btn sm"><Icon name="folder" size={14} />Tab folders</Link></div>}
      </Section>
      <Section title="Pocket Habits — tick a habit for you" icon="habit" actions={connBadge(eff(f.habits_mode), f.habits_via)}
        sub="When a day’s guitar practice reaches the minutes you set, the habit you choose (“Practise guitar”) is ticked, so its streak keeps itself.">
        <Connection app="Pocket Habits" mode={f.habits_mode} via={f.habits_via} detail={f.habits_detail} core={coreOn} hasToken={!!f.habits_token}
          onMode={m => save({ habits_mode: m })} onDisconnect={() => save({ habits_url: '', habits_token: '' })}
          test={<><button type="button" className="btn sm" onClick={() => run('habits', f.habits_url, f.habits_token)}>Test connection</button>{status('habits')}</>}
          direct={<div className="two-col tight">
            <Field label="URL" help="Inside Docker use http://host.docker.internal:PORT or the service name."><input value={f.habits_url} onChange={e => setF({ ...f, habits_url: e.target.value })} placeholder="http://host.docker.internal:8169" /></Field>
            <Field label="API token" help="Pocket Habits → Settings → API tokens"><input value={f.habits_token} onChange={e => setF({ ...f, habits_token: e.target.value })} autoComplete="off" /></Field>
          </div>} />
        {eff(f.habits_mode) !== 'off' && <div className="mt stack">
          <div className="row"><h4 className="grow">Rules</h4><button type="button" className="btn sm" onClick={() => setEdit('new')}><Icon name="plus" size={14} />Add a rule</button></div>
          {rules && rules.length === 0 && <p className="muted small">No rules yet: nothing is ticked automatically.</p>}
          {rules?.map(r => <div key={r.id} className={`rule ${r.enabled ? '' : 'off'}`}><Switch checked={r.enabled} onChange={() => toggleRule(r)} label="Enabled" size="sm" /><span className="grow">{r.min_minutes ? `${r.min_minutes}+ min of guitar in a day` : 'Any guitar practice in a day'} → <b>{r.habit_name || `habit #${r.habit_id}`}</b></span><button type="button" className="btn ghost sm" onClick={() => setEdit(r)}>Edit</button><button type="button" className="btn ghost sm danger-text" onClick={() => delRule(r)}>Remove</button></div>)}
          {rules && rules.length > 0 && <p className="muted small">Checked right after you practise and every five minutes for the last week.</p>}
        </div>}
      </Section>
      <Section title="The original recording — Navidrome" icon="headphones" actions={musicMode === 'off' ? <span className="badge">off</span> : <span className="badge ok">{musicMode === 'core' ? 'Pocket Core' : 'direct'}</span>}
        sub="Link a song to its recording in your own Navidrome and play along with the record at your practice speed, with the tab cursor following. Guitar streams it through itself, so the password never reaches the browser.">
        <div className="conn-block">
          <div className="conn-mode">
            <Segmented size="sm" value={musicMode} onChange={m => save({ music_mode: m as ConnMode })} options={[
              { value: 'core', label: 'Pocket Core', title: coreOn ? 'Your own Navidrome login from Pocket Core (My logins)' : 'Needs Pocket Core: there is none on this box', disabled: !coreOn },
              { value: 'direct', label: 'Direct' }, { value: 'off', label: 'Off' }]} />
          </div>
          <div className={`conn-status ${musicMode === 'off' ? '' : 'ok'}`}><span className="dot" />{musicMode === 'off' ? 'Off: songs play with the tab’s own sound only.' : musicMode === 'core' ? 'Your own Navidrome login from Pocket Core (Core → My logins → Navidrome). Use Test to check it.' : 'Your Navidrome address, user and password.'}</div>
          {musicMode === 'direct' && <div className="three-col tight">
            <Field label="URL"><input value={f.music_url} onChange={e => setF({ ...f, music_url: e.target.value })} placeholder="http://host.docker.internal:4533" /></Field>
            <Field label="User"><input value={f.music_user} onChange={e => setF({ ...f, music_user: e.target.value })} autoComplete="off" /></Field>
            <Field label="Password"><input type="password" value={f.music_password} onChange={e => setF({ ...f, music_password: e.target.value })} autoComplete="new-password" /></Field>
          </div>}
          {musicMode !== 'off' && <div className="row wrap"><button type="button" className="btn sm" onClick={() => musicMode === 'direct' ? run('music', f.music_url, f.music_password, { user: f.music_user }) : run('music', '', '')}>Test connection</button>{status('music')}</div>}
        </div>
      </Section>
      <Section title="Other Pocket apps" icon="layers" sub="Guitar offers your practice to the rest of the box through Pocket Core: Pocket Day writes it into your journal, Pocket Calendar can show it on the calendar, and a lesson app could log practice here. Your song notes never leave this app.">
        <dl className="set-dl">
          <div><dt>guitar:read</dt><dd className="muted">Songs and where you are with them, practice time, streaks and setlists — without your notes.</dd></div>
          <div><dt>guitar:write</dt><dd className="muted">Log practice done elsewhere; only what that app logged itself can be changed by it.</dd></div>
        </dl>
      </Section>
      <div className="row"><button type="button" className="btn primary" onClick={() => save()} disabled={busy}>Save changes</button></div>
      {edit && <RuleModal rule={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload() }} />}
    </div>
  )
}

function RuleModal({ rule, onClose, onSaved }: { rule?: HabitRule; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast()
  const { data } = useAsync(() => api.get<{ connected: boolean; detail?: string; habits: Habit[] }>(`${V1}/habits/list`), [])
  const [f, setF] = useState({ min_minutes: String(rule?.min_minutes ?? 15), habit_id: rule?.habit_id || 0, habit_name: rule?.habit_name || '' })
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true)
    const body = { min_minutes: Number(f.min_minutes) || 0, habit_id: f.habit_id, habit_name: f.habit_name, enabled: rule?.enabled ?? true }
    try { if (rule) await api.put(`${V1}/rules/${rule.id}`, body); else await api.post(`${V1}/rules`, body); onSaved() } catch (err) { toast((err as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal title={rule ? 'Edit rule' : 'Tick a habit when…'} onClose={onClose} size="sm">
      <form onSubmit={save} className="grid" style={{ gap: 14 }}>
        <Field label="I play at least (minutes in a day)" help="0 = any practice that day."><input type="number" min={0} max={600} value={f.min_minutes} onChange={e => setF({ ...f, min_minutes: e.target.value })} /></Field>
        <Field group label="Tick this habit">
          {!data ? <Loading /> : !data.connected ? <p className="bad small">{data.detail}</p> :
            <Select ariaLabel="Habit" value={f.habit_id ? String(f.habit_id) : ''} onChange={v => { const h = data.habits.find(x => String(x.id) === v); setF({ ...f, habit_id: Number(v), habit_name: h?.name || '' }) }} options={data.habits.map(h => ({ value: String(h.id), label: h.name }))} placeholder="Choose a habit…" />}
        </Field>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.habit_id}>Save</button></div>
      </form>
    </Modal>
  )
}

function AITab() {
  const { f, setF, save, busy } = useSettingsForm()
  const { run, status } = useTester()
  const { data: ai } = useAsync(() => api.get<{ ready: boolean; provider: string; detail: string }>(`${V1}/ai/status`), [])
  if (!f) return <Loading />
  const coreOn = f.core_configured && f.core_registered !== false
  const shown = !coreOn && f.ai_provider === 'pocket' ? 'openai' : (f.ai_provider || 'auto')
  return (
    <div className="stack loose">
      <Section title="What the AI does" icon="sparkles" sub="Writes a practice plan for a song (which parts, at what speed, for how long) and answers questions about your playing, from your own songs and practice log. Nothing is sent unless you press the button.">
        {ai && (ai.ready ? <p className="muted small row" style={{ gap: 6 }}><Icon name="sparkles" size={13} />{ai.provider === 'pocket' ? 'Pocket AI' : 'Your OpenAI key'} is ready.</p>
          : <div className="callout info"><Icon name="info" size={15} /><div>No AI connected{ai.detail ? ` (${ai.detail})` : ''}.{!coreOn && <CoreHint />}</div></div>)}
      </Section>
      <Section title="Provider" icon="sparkles">
        <div className="grid" style={{ gap: 12 }}>
          <Field group label="Who writes" help="Automatic prefers your enabled Pocket AI connection; without one it uses your OpenAI settings.">
            <Select ariaLabel="AI provider" value={shown} onChange={v => setF({ ...f, ai_provider: v as SettingsT['ai_provider'] })} options={[{ value: 'auto', label: coreOn ? 'Automatic — prefer Pocket AI' : 'Automatic' }, { value: 'pocket', label: 'Pocket AI', disabled: !coreOn, hint: coreOn ? undefined : 'needs Pocket Core' }, { value: 'openai', label: 'OpenAI / compatible API' }]} />
          </Field>
          {!coreOn && <CoreHint />}
          {coreOn && shown !== 'openai' && <PocketModelSelect value={f.ai_pocket_model || ''} onChange={v => setF({ ...f, ai_pocket_model: v })} />}
          {(shown === 'openai' || (!coreOn && shown === 'auto')) && <>
            <Field label="OpenAI API key" help="platform.openai.com → API keys. Stored on the server; shown masked."><input value={f.openai_api_key} onChange={e => setF({ ...f, openai_api_key: e.target.value })} autoComplete="off" placeholder="sk-…" /></Field>
            <div className="two-col tight">
              <Field label="Model" help="Default gpt-4o-mini."><input value={f.openai_model} onChange={e => setF({ ...f, openai_model: e.target.value })} placeholder="gpt-4o-mini" /></Field>
              <Field label="Base URL (optional)" help="Ollama, LM Studio, OpenRouter…"><input value={f.openai_base_url} onChange={e => setF({ ...f, openai_base_url: e.target.value })} placeholder="https://api.openai.com/v1" /></Field>
            </div>
          </>}
        </div>
      </Section>
      <div className="row wrap">
        <button type="button" className="btn primary" onClick={() => save()} disabled={busy}>Save changes</button>
        {(shown === 'openai' || (!coreOn && shown === 'auto')) && <><button type="button" className="btn" onClick={() => run('openai', f.openai_base_url, f.openai_api_key)} disabled={!f.openai_api_key}>Test the OpenAI key</button>{status('openai')}</>}
      </div>
    </div>
  )
}

function Connection({ app, mode: saved, via, detail, core, onMode, onDisconnect, hasToken, test, direct }: {
  app: string; mode: ConnMode; via: string; detail: string; core: boolean; onMode: (m: ConnMode) => void; onDisconnect: () => void
  hasToken: boolean; test: React.ReactNode; direct: React.ReactNode
}) {
  const [advanced, setAdvanced] = useState(saved === 'direct')
  const mode: ConnMode = !core && saved === 'core' ? 'off' : saved
  const ok = via !== '' && mode !== 'off'
  const showDirect = !core || mode === 'direct' || advanced
  const line = mode === 'off' ? `Off: Guitar does not talk to ${app}.`
    : mode === 'core' ? (ok ? `Connected through Pocket Core, as you${detail ? ` (${detail})` : ''}. Nothing to fill in; switch it off for yourself in Pocket Core → Settings → Apps acting for me.` : `Not connected: ${detail}.`)
    : (ok ? `Direct connection with your own ${app} URL and token; use Test connection to check it.` : `Not connected: ${detail || 'add the URL and a token'}.`)
  return (
    <div className="conn-block">
      <div className="conn-mode">
        <Segmented size="sm" value={mode} onChange={m => onMode(m as ConnMode)} options={[
          { value: 'core', label: 'Pocket Core', title: core ? 'Through Pocket Core: per person, nothing to paste' : 'Needs Pocket Core: there is none on this box', disabled: !core },
          ...(showDirect ? [{ value: 'direct', label: 'Direct', title: 'Your own URL and API token' }] : []),
          { value: 'off', label: 'Off' },
        ]} />
        {!showDirect && <button type="button" className="conn-advanced" onClick={() => setAdvanced(true)}>Advanced: connect directly with a URL and key</button>}
      </div>
      <div className={`conn-status ${mode === 'off' ? '' : ok ? 'ok' : 'bad'}`}><span className="dot" />{line}</div>
      {mode === 'direct' && <>
        {direct}
        <div className="row wrap">{test}{hasToken && <button type="button" className="btn sm ghost danger-text" onClick={onDisconnect} title="Remove the saved URL and token">Disconnect</button>}</div>
      </>}
      {mode === 'core' && <div className="row wrap">{test}</div>}
    </div>
  )
}

const connBadge = (mode: ConnMode, via: string) => mode === 'off' ? <span className="badge">off</span>
  : via ? <span className="badge ok">{via === 'core' ? 'Pocket Core' : 'direct'}</span>
  : <span className="badge warn">not connected</span>

function Users() {
  const { user, users, reloadMeta, status } = useApp()
  const { toast } = useToast()
  const [edit, setEdit] = useState<Partial<User> | null>(null)
  const [del, setDel] = useState<User | null>(null)
  const isAdmin = user?.role === 'admin'
  const run = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); await reloadMeta(); toast(msg) } catch (e) { toast((e as Error).message, 'err') } }
  return (
    <Section title="People on this box" actions={isAdmin && <button type="button" className="btn primary sm" onClick={() => setEdit({ role: 'member' })}><Icon name="plus" size={14} />Add person</button>}
      sub="Everyone signs in with their own account and has their own songs, practice and connections. Admins manage accounts; they do not see anyone else’s songs or practice.">
      <div className="set-people">
        {users.map(u => (
          <div key={u.id} className="set-person">
            <Avatar name={u.name} email={u.email} size={34} />
            <div className="grow">
              <div className="set-person-name">{u.name || <span className="muted">—</span>}{u.id === user?.id && <span className="badge">you</span>}{u.role === 'admin' && <span className="badge accent">admin</span>}</div>
              <div className="muted small ellipsis">{u.email}</div>
            </div>
            {isAdmin && <span className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn ghost sm" onClick={() => setEdit(u)}>Edit</button>{u.id !== user?.id && <button type="button" className="btn ghost sm danger-text" onClick={() => setDel(u)}>Remove</button>}</span>}
          </div>
        ))}
      </div>
      {status?.auth_mode !== 'local' && <p className="muted small mt">Auth mode is <code>{status?.auth_mode}</code>: users are created automatically on first visit; passwords are not used here.</p>}
      {edit && <UserModal user={edit} local={status?.auth_mode === 'local'} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reloadMeta() }} />}
      {del && <Confirm confirmLabel="Remove" title={`Remove ${del.name || del.email}?`} message="Their account is deleted together with their songs and their whole practice log." onCancel={() => setDel(null)} onConfirm={() => { const d = del; setDel(null); run(() => api.del(`${V1}/users/${d.id}`), 'User removed') }} />}
    </Section>
  )
}

function UserModal({ user, local, onClose, onSaved }: { user: Partial<User>; local: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast()
  const [f, setF] = useState({ name: user.name || '', email: user.email || '', password: '', role: user.role || 'member' })
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true)
    try { if (user.id) await api.put(`${V1}/users/${user.id}`, f); else await api.post(`${V1}/users`, f); toast(user.id ? 'User saved' : 'User added'); onSaved() } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <Modal title={user.id ? 'Edit person' : 'Add a person'} onClose={onClose} size="sm">
      <form onSubmit={save} className="grid" style={{ gap: 14 }}>
        <Field label="Name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus required maxLength={60} /></Field>
        <Field label="Email" help="Used to sign in."><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required /></Field>
        {local && <Field label={user.id ? 'New password (leave empty to keep)' : 'Password'} help="At least 8 characters."><input type="password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} minLength={user.id ? 0 : 8} required={!user.id} autoComplete="new-password" /></Field>}
        <Field group label="Role"><Segmented value={f.role} onChange={v => setF({ ...f, role: v })} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} /></Field>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{user.id ? 'Save' : 'Add person'}</button></div>
      </form>
    </Modal>
  )
}

function Profile() {
  const { user, setUser, status } = useApp()
  const { toast } = useToast()
  const [f, setF] = useState({ name: user?.name || '', email: user?.email || '', current_password: '', new_password: '' })
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true)
    try { setUser(await api.put(`${V1}/auth/me`, f)); setF(x => ({ ...x, current_password: '', new_password: '' })); toast('Profile saved') } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <form onSubmit={save} className="stack loose">
      <div className="set-profile">
        <Avatar name={user?.name} email={user?.email} size={56} />
        <div className="grow"><h3>{user?.name || user?.email}</h3><p className="muted small">{user?.email} · {user?.role}</p></div>
      </div>
      <Section title="You">
        <div className="stack">
          <Field label="Name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
        </div>
      </Section>
      {status?.auth_mode === 'local' && <Section title="Password" sub="Leave empty to keep the current one."><div className="stack">
        <Field label="Current password"><input type="password" value={f.current_password} onChange={e => setF({ ...f, current_password: e.target.value })} autoComplete="current-password" /></Field>
        <Field label="New password" help="At least 8 characters."><input type="password" value={f.new_password} onChange={e => setF({ ...f, new_password: e.target.value })} autoComplete="new-password" /></Field>
      </div></Section>}
      <div className="row"><button className="btn primary" disabled={busy}>Save changes</button></div>
    </form>
  )
}

function Tokens() {
  const { toast } = useToast()
  const { settings } = useApp()
  const { data, reload } = useAsync(() => api.get<APIToken[]>(`${V1}/tokens`), [])
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState('')
  const [del, setDel] = useState<APIToken | null>(null)
  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    try { const r = await api.post<{ token: string }>(`${V1}/tokens`, { name: name || 'token' }); setFresh(r.token); setName(''); reload() } catch (e) { toast((e as Error).message, 'err') }
  }
  const base = settings?.base_url || window.location.origin
  return (
    <div className="stack loose">
      <Section title="Personal tokens" icon="key" sub={<>Use as <code>Authorization: Bearer &lt;token&gt;</code>. A token acts as you: it can read and change everything, feed a Homepage widget (<code>GET /api/v1/dashboard</code>) or log a sit from a Shortcut. See <code>docs/api.md</code>.</>}>
        <form onSubmit={create} className="row mb"><input value={name} onChange={e => setName(e.target.value)} placeholder="Token name (e.g. Homepage)" /><button className="btn primary"><Icon name="plus" size={15} />Create</button></form>
        {fresh && <div className="set-fresh mb"><div className="row"><Icon name="check-circle" size={16} /><b>Copy it now — it is shown once.</b></div><pre className="mono">{fresh}</pre></div>}
        {data && data.length > 0 ? (
          <table className="table compact">
            <thead><tr><th>Name</th><th>Prefix</th><th>Last used</th><th>Created</th><th /></tr></thead>
            <tbody>{data.map(t => <tr key={t.id}><td>{t.name}</td><td className="mono">{t.prefix}…</td><td className="muted">{t.last_used_at ? fmtDateTime(t.last_used_at) : 'never'}</td><td className="muted">{fmtDateTime(t.created_at)}</td><td className="right"><button type="button" className="btn ghost sm danger-text" onClick={() => setDel(t)}>Revoke</button></td></tr>)}</tbody>
          </table>
        ) : <p className="muted">No tokens yet.</p>}
        {del && <Confirm confirmLabel="Revoke" title={`Revoke “${del.name}”?`} message="Anything using this token stops working immediately." onCancel={() => setDel(null)} onConfirm={async () => { await api.del(`${V1}/tokens/${del.id}`); setDel(null); reload() }} />}
      </Section>
      <Section title="Endpoints" icon="code" sub={<>At <code>{base}/api/v1</code>.</>}>
        <dl className="set-dl">
          <div><dt><code>POST /practice</code></dt><dd className="muted"><code>{'{"title":"Scales","started_at":"2026-10-29T18:00:00+01:00","duration_s":900}'}</code> — log practice (a Siri Shortcut after a lesson).</dd></div>
          <div><dt><code>POST /tabs</code></dt><dd className="muted">Upload tab files (multipart, field <code>file</code>).</dd></div>
          <div><dt><code>GET /dashboard</code></dt><dd className="muted">Today’s minutes, goal, streak, songs — for Homepage.</dd></div>
          <div><dt><code>GET /stats?from=&to=</code></dt><dd className="muted">Everything on the Practice page.</dd></div>
          <div><dt><code>GET /day/YYYY-MM-DD</code></dt><dd className="muted">One day’s practice — what Pocket Day reads.</dd></div>
          <div><dt><code>GET /overlay?from=&to=</code></dt><dd className="muted">Practice per day — for Pocket Calendar.</dd></div>
        </dl>
      </Section>
    </div>
  )
}

function Data() {
  const { toast } = useToast()
  const { user } = useApp()
  const [busy, setBusy] = useState(false)
  const importJSON = async (file: File) => {
    setBusy(true)
    try { const r = await api.post<Record<string, number>>(`${V1}/import`, JSON.parse(await file.text())); toast('Imported: ' + (Object.entries(r).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new')); window.dispatchEvent(new CustomEvent('pgt:changed')) } catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
  }
  return (
    <div className="stack loose">
      {user?.role === 'admin' && <Section title="Database backup" icon="database" sub="The whole box, every account — admins only.">
        <p className="muted">A consistent copy of the SQLite database (<code>VACUUM INTO</code>). Restore by stopping the app and replacing <code>pocket-guitar.db</code> in the data directory.</p>
        <a className="btn primary" href={`${V1}/backup`}><Icon name="download" size={15} />Download database</a>
      </Section>}
      <Section title="Export & import" icon="archive" sub="Everything of yours as one JSON file (your songs with their files, sections, notes, practice, setlists and habit rules), or your practice as a CSV. Importing the same file twice adds nothing; imported practice does not tick habits again.">
        <div className="row wrap"><a className="btn" href={`${V1}/export.json`}><Icon name="download" size={15} />Export JSON</a><a className="btn" href={`${V1}/export.csv`}><Icon name="download" size={15} />Practice CSV</a><label className="btn"><Icon name="upload" size={15} />{busy ? 'Importing…' : 'Import JSON…'}<input type="file" accept="application/json,.json" hidden onChange={e => e.target.files?.[0] && importJSON(e.target.files[0])} /></label></div>
      </Section>
    </div>
  )
}

function About() {
  const { data, error } = useAsync(() => api.get<Record<string, unknown>>(`${V1}/settings/system`), [])
  const [keys, setKeys] = useState(false)
  if (error) return <div className="callout danger"><Icon name="alert" size={15} /><span>{error}</span></div>
  if (!data) return <Loading />
  const counts = (data.counts || {}) as Record<string, number>
  const core = (data.core || {}) as { configured?: boolean; registered?: boolean; url?: string; error?: string }
  const tiles: [string, number | undefined, string][] = [['Songs', counts.tabs, 'music'], ['Sections', counts.sections, 'repeat'], ['Practice sessions', counts.practice, 'clock'], ['Setlists', counts.setlists, 'list-music']]
  const rows: [string, React.ReactNode][] = [
    ['Version', <code key="v">{String(data.version)}</code>],
    ['Uptime', String(data.uptime)],
    ['Runtime', `${String(data.go)} · ${String(data.os)}/${String(data.arch)}`],
    ['Time zone', String(data.timezone)],
    ['Sign-in', String(data.auth_mode)],
    ['Pocket Core', core.configured ? (core.registered ? <span key="c" className="ok">connected · {core.url}</span> : <span key="c" className="bad">{core.error || 'not registered yet'}</span>) : <span key="c" className="muted">not configured</span>],
    ['Database', <span key="db"><code>{String(data.db_path)}</code> · {fmtBytes(Number(data.db_bytes))}</span>],
    ['People', `${counts.users ?? 0} accounts on this box`],
  ]
  return (
    <div className="stack loose">
      <div className="set-about-hero">
        <img src="/favicon.svg" alt="" width={48} height={48} />
        <div>
          <h3>Pocket Guitar</h3>
          <p className="muted small">Your guitar tabs and practice: a tab player with loops, a speed trainer, a live fretboard and the original recording to play along with; a library fed from your Pocket Files folders; a practice log with streaks and statistics; a tuner and a metronome. One binary, one SQLite file, one volume.</p>
        </div>
      </div>
      <div className="set-stats">
        {tiles.map(([label, n, icon]) => (
          <div key={label} className="set-stat"><Icon name={icon} size={16} /><span className="set-stat-n tnum">{(n ?? 0).toLocaleString()}</span><span className="set-stat-l">{label}</span></div>
        ))}
      </div>
      <Section title="This server">
        <dl className="set-dl">
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </Section>
      <div className="row wrap">
        <button type="button" className="btn" onClick={() => setKeys(true)}><Icon name="keyboard" size={15} />Keyboard shortcuts</button>
        <Link className="btn" to="/milestones"><Icon name="trophy" size={15} />Milestones</Link>
        <a className="btn" href="https://github.com/abjelosevic88/pocket-homelab-guitar" target="_blank" rel="noreferrer"><Icon name="external" size={15} />Project on GitHub</a>
      </div>
      <p className="muted small">Open source (MIT). Part of the Pocket apps: Pocket Core connects them — Habits, Health, Day, Calendar and more. Not medical advice; if you are struggling, talk to someone you trust or a professional.</p>
      {keys && <ShortcutsSheet onClose={() => setKeys(false)} />}
    </div>
  )
}
