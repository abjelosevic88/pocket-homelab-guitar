// The tab player: one song, full screen. The score (alphaTab) in the middle,
// the transport along the bottom, the fretboard above it, and a panel for
// sections + the speed trainer, the song itself and the original recording
// (a side panel on desktop, a bottom sheet on phones).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import type { Analysis, PlayerPrefs, Recording, Section, Setlist, Tab } from '../lib/types'
import { Icon } from '../components/icons'
import { AskButton } from '../components/AskButton'
import { Loading, Menu, Modal, Popover, errMsg, modalOpen, rectOf, useIsMobile, useToast, type Anchor } from '../components/ui'
import { TabEngine, useEngineState, type ScoreColors, type ViewOptions } from '../player/engine'
import { analyse, mainTrack } from '../player/music'
import { Transport, type ViewPrefs } from '../player/Transport'
import { Fretboard } from '../player/Fretboard'
import { SectionsPanel, type Trainer } from '../player/SectionsPanel'
import { SongPanel, STATUS } from '../player/SongPanel'
import { RecordingPanel } from '../player/RecordingPanel'
import { usePracticeTimer, useWakeLock } from '../player/practice'
import { useRecordingSync, type SoundMode } from '../player/recording'
import { PIcon } from '../player/icons'

type PanelKind = 'sections' | 'song' | 'recording'
const PANEL_KEY = 'pgt-player-panel'
const TRAINER_KEY = 'pgt-trainer'
const SOUND_KEY = 'pgt-sound-'

export default function TabPage() {
  const { id } = useParams()
  const tabId = Number(id) || 0
  return <Player key={tabId} tabId={tabId} />
}

function Player({ tabId }: { tabId: number }) {
  const [sp] = useSearchParams()
  const setlistId = Number(sp.get('setlist')) || 0
  const navigate = useNavigate()
  const { settings, theme } = useApp()
  const { toast } = useToast()
  const mobile = useIsMobile()

  const engine = useMemo(() => new TabEngine(), [])
  useEffect(() => () => engine.destroy(), [engine])
  const st = useEngineState(engine)

  const [tab, setTab] = useState<Tab | null>(null)
  const tabRef = useRef<Tab | null>(null)
  tabRef.current = tab
  const [sections, setSections] = useState<Section[]>([])
  const sectionsRef = useRef<Section[]>([])
  sectionsRef.current = sections
  const [loadErr, setLoadErr] = useState('')
  const [setlist, setSetlist] = useState<Setlist | null>(null)
  const [prefs, setPrefs] = useState<PlayerPrefs | null>(null)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const scoreEl = useRef<HTMLDivElement>(null)
  const scrollEl = useRef<HTMLDivElement>(null)

  // ---- the panel ----
  const [panel, setPanelRaw] = useState<PanelKind | null>(() => {
    if (mobile) return null
    const v = localStorage.getItem(PANEL_KEY)
    return v === 'none' ? null : ((v as PanelKind) || 'sections')
  })
  const [sheetAt, setSheetAt] = useState<Anchor | null>(null)
  const setPanel = (p: PanelKind | null, el?: Element) => {
    setPanelRaw(p)
    if (mobile) setSheetAt(p ? (el ? rectOf(el) : { x: 0, y: 0, w: 0, h: 0 }) : null)
    else localStorage.setItem(PANEL_KEY, p || 'none')
  }

  // ---- defaults from Settings, overridden by the tab's own choices ----
  const s = settings
  const [autoScroll, setAutoScroll] = useState<boolean | null>(null)
  const view: ViewPrefs = {
    notation: prefs?.notation ?? s?.notation ?? 'tab',
    layout: prefs?.layout ?? s?.layout ?? 'page',
    zoom: prefs?.zoom ?? s?.zoom ?? 100,
    transpose: prefs?.transpose ?? 0,
    autoScroll: autoScroll ?? s?.auto_scroll ?? true,
    fretboard: prefs?.fretboard ?? s?.fretboard ?? true,
  }
  const tracks = prefs?.tracks?.length ? prefs.tracks : prefs?.track !== undefined ? [prefs.track] : null
  const colors = useScoreColors(theme, s?.score_colors ?? 'theme')
  const fullView = (): ViewOptions => ({ tracks: tracks || [0], notation: view.notation, layout: view.layout, zoom: view.zoom, transpose: view.transpose, autoScroll: view.autoScroll, colors })

  const [trainer, setTrainerRaw] = useState<Trainer>(() => {
    try { const t = JSON.parse(localStorage.getItem(TRAINER_KEY) || 'null'); if (t) return t } catch { /* fresh */ }
    return { on: false, start: s?.trainer_start || 60, step: s?.trainer_step || 5, every: s?.trainer_every || 2, target: s?.trainer_target || 100 }
  })
  const trainerRef = useRef(trainer)
  trainerRef.current = trainer
  const [passes, setPassesRaw] = useState(0)
  const passesRef = useRef(0)
  const setPasses = (n: number) => { passesRef.current = n; setPassesRaw(n) }
  const setTrainer = (t: Trainer) => {
    setTrainerRaw(t); localStorage.setItem(TRAINER_KEY, JSON.stringify(t))
    if (t.on && !trainer.on) { engine.setSpeed(t.start / 100); setPasses(0) }
  }
  const [activeId, setActiveId] = useState<number | null>(null)
  const activeRef = useRef<number | null>(null)
  activeRef.current = activeId
  const [sound, setSoundRaw] = useState<SoundMode>(() => (localStorage.getItem(SOUND_KEY + tabId) as SoundMode) || 'both')
  const setSound = (m: SoundMode) => { setSoundRaw(m); localStorage.setItem(SOUND_KEY + tabId, m) }

  // ---- load the tab, its file and (in a setlist) the list ----
  useEffect(() => {
    if (!settings) return
    let gone = false
    ;(async () => {
      try {
        const t = await api.get<Tab>(`${V1}/tabs/${tabId}`)
        if (gone) return
        setTab(t); setSections(t.sections || [])
        const p = t.player || {}
        setPrefs(p)
        const res = await fetch(`${V1}/tabs/${tabId}/file`, { credentials: 'same-origin', cache: 'no-cache' })
        if (!res.ok) throw new ApiError(res.status, res.status === 404 ? 'The file of this tab is missing.' : `The file could not be loaded (${res.status}).`)
        const buf = await res.arrayBuffer()
        if (gone || !scoreEl.current || !scrollEl.current) return
        const startTracks = p.tracks?.length ? p.tracks : p.track !== undefined ? [p.track] : [0]
        await engine.mount(scoreEl.current, scrollEl.current, { ...fullView(), notation: p.notation ?? settings.notation ?? 'tab', layout: p.layout ?? settings.layout ?? 'page', zoom: p.zoom ?? settings.zoom ?? 100, transpose: p.transpose ?? 0, tracks: startTracks }, buf)
        engine.setSpeed((p.speed ?? 100) / 100)
        engine.setMetronome(p.metronome ?? settings.metronome ?? false)
        engine.setCountIn(p.count_in ?? settings.count_in ?? false)
      } catch (e) {
        console.error('tab player:', e)
        if (!gone) setLoadErr(e instanceof ApiError && e.status === 404 && !String(e.message).includes('file') ? 'This tab is not in your library.' : errMsg(e))
      }
    })()
    return () => { gone = true }
  }, [tabId, !!settings]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!setlistId) return
    api.get<Setlist>(`${V1}/setlists/${setlistId}`).then(setSetlist).catch(() => setSetlist(null))
  }, [setlistId])

  // first open: the main guitar track, the mixer as saved, and tell the server what's in the file
  useEffect(() => {
    let analysed = false
    const offs = [
      engine.on('scoreLoaded', score => {
        const p = prefsRef.current || {}
        if (!p.tracks?.length && p.track === undefined) {
          const m = mainTrack(score)
          setPrefs(prev => ({ ...(prev || {}), track: m }))
        }
      }),
      engine.on('midiLoaded', endMs => {
        const p = prefsRef.current || {}
        for (const i of p.muted || []) engine.setMute(i, true)
        for (const i of p.solo || []) engine.setSolo(i, true)
        for (const [i, v] of Object.entries(p.volume || {})) engine.setTrackVolume(Number(i), v)
        const t = tabRef.current, score = engine.state.get().score
        if (t && score && !t.analyzed && !analysed) {
          analysed = true
          const a: Analysis = analyse(score, endMs)
          api.put<Tab>(`${V1}/tabs/${t.id}/analysis`, a).then(u => setTab(cur => cur ? { ...cur, ...u, sections: cur.sections } : u)).catch(() => {})
        }
      }),
    ]
    return () => offs.forEach(o => o())
  }, [engine])

  // view changes re-render the score
  const viewKey = JSON.stringify(fullView())
  useEffect(() => { engine.setView(fullView()) }, [viewKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- remember the tab's player choices (debounced) ----
  const lastSaved = useRef('')
  const persistKey = prefs && st.score ? JSON.stringify({
    ...prefs, speed: Math.round(st.speed * 100), metronome: st.metronome, count_in: st.countIn,
    muted: st.muted, solo: st.solo, volume: st.trackVolume,
  } satisfies PlayerPrefs) : ''
  useEffect(() => {
    if (!persistKey || !tab) return
    if (!lastSaved.current) { lastSaved.current = persistKey; return } // what was just loaded
    if (persistKey === lastSaved.current) return
    const t = window.setTimeout(() => {
      lastSaved.current = persistKey
      api.put(`${V1}/tabs/${tab.id}`, { player: JSON.parse(persistKey) }).catch(() => {})
    }, 1200)
    return () => window.clearTimeout(t)
  }, [persistKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const setView = (v: Partial<ViewPrefs>) => {
    const { autoScroll: as, ...rest } = v
    if (as !== undefined) setAutoScroll(as)
    if (Object.keys(rest).length) setPrefs(p => ({ ...(p || {}), ...rest }))
  }
  const setTracks = (t: number[]) => setPrefs(p => ({ ...(p || {}), tracks: t, track: t[0] }))

  // ---- saving song details ----
  const patch = useCallback(async (p: Partial<Tab>) => {
    const t = tabRef.current
    if (!t) return
    setTab({ ...t, ...p })
    try { const u = await api.put<Tab>(`${V1}/tabs/${t.id}`, p); setTab(cur => cur ? { ...cur, ...u, sections: cur.sections } : u) } catch (e) { toast(errMsg(e), 'err'); setTab(t) }
  }, [toast])
  const setRecording = (r: Recording | null) => patch({ recording: r })

  // ---- loops, sections and the speed trainer ----
  const lastRange = useRef('')
  useEffect(() => {
    const k = st.range ? `${st.range.start}-${st.range.end}` : ''
    if (k === lastRange.current) return
    lastRange.current = k
    setPasses(0)
    if (!st.range) { engine.setLooping(false); setActiveId(null); return }
    engine.setLooping(true)
    const a = sectionsRef.current.find(x => x.id === activeRef.current)
    if (!a || a.start_bar - 1 !== st.range.start || a.end_bar - 1 !== st.range.end) setActiveId(null)
  }, [st.range, engine])

  const activate = (sec: Section) => {
    activeRef.current = sec.id
    setActiveId(sec.id)
    lastRange.current = `${sec.start_bar - 1}-${sec.end_bar - 1}`
    engine.selectBars(sec.start_bar - 1, sec.end_bar - 1)
    engine.setLooping(true)
    if (trainerRef.current.on) engine.setSpeed(Math.max(trainerRef.current.start, sec.speed || 0) / 100)
    else if (sec.speed) engine.setSpeed(sec.speed / 100)
    setPasses(0)
    engine.seekBar(sec.start_bar - 1)
  }

  useEffect(() => {
    const offs = [
      engine.on('loopPass', speed => {
        const pct = Math.round(speed * 100)
        const tr = trainerRef.current
        const next = passesRef.current + 1
        passesRef.current = next
        setPasses(next)
        let newSpeed = pct
        if (tr.on && next % tr.every === 0 && pct < tr.target) {
          newSpeed = Math.min(tr.target, pct + tr.step)
          engine.setSpeed(newSpeed / 100)
          if (newSpeed >= tr.target) toast(`Speed trainer: up to your goal, ${newSpeed}%`)
        }
        const sec = sectionsRef.current.find(x => x.id === activeRef.current)
        if (sec && (pct > sec.best_speed || newSpeed !== sec.speed)) {
          const upd = { ...sec, best_speed: Math.max(sec.best_speed, pct), speed: newSpeed }
          sectionsRef.current = sectionsRef.current.map(x => x.id === sec.id ? upd : x)
          setSections(sectionsRef.current)
          api.put<Section>(`${V1}/sections/${sec.id}`, upd).catch(() => {})
        }
      }),
      engine.on('finished', speed => {
        const t = tabRef.current
        const pct = Math.round(speed * 100)
        if (t && pct > (t.best_speed || 0)) {
          patch({ best_speed: pct })
          toast(`Played the whole song at ${pct}%`)
        }
      }),
    ]
    return () => offs.forEach(o => o())
  }, [engine, patch, toast])

  const toggleLoop = () => {
    if (!st.range) { toast('Drag across bars in the tab to choose what to loop'); return }
    engine.setLooping(!st.looping)
  }
  const saveSelection = async () => {
    const t = tabRef.current
    if (!t || !st.range) return
    const n = `Part ${sections.length + 1}`
    try {
      const sec = await api.post<Section>(`${V1}/tabs/${t.id}/sections`, { name: n, start_bar: st.range.start + 1, end_bar: st.range.end + 1, goal_speed: t.goal_speed || 100 })
      setSections(l => [...l, sec]); setActiveId(sec.id)
      toast(`Saved “${n}”`)
      if (!mobile && panel !== 'sections') setPanel('sections')
    } catch (e) { toast(errMsg(e), 'err') }
  }

  // ---- AI practice plan ----
  const [aiReady, setAiReady] = useState<{ ready: boolean; detail: string } | null>(null)
  useEffect(() => { api.get<{ ready: boolean; detail: string }>(`${V1}/ai/status`).then(setAiReady).catch(() => setAiReady({ ready: false, detail: '' })) }, [])
  const [plan, setPlan] = useState<{ busy: boolean; text: string } | null>(null)
  const aiPlan = async () => {
    if (aiReady && !aiReady.ready) { toast(aiReady.detail || 'Set up AI in Settings → AI first', 'err'); return }
    setPlan({ busy: true, text: '' })
    try { const r = await api.post<{ text: string }>(`${V1}/ai/plan`, { tab_id: tabId, section_id: activeId }); setPlan({ busy: false, text: r.text }) } catch (e) { setPlan(null); toast(errMsg(e), 'err') }
  }

  // ---- practice, wake lock, recording ----
  const title = tab ? [tab.artist, tab.title].filter(Boolean).join(' – ') : ''
  const timer = usePracticeTimer(engine, tab ? tab.id : null, title, activeId)
  useWakeLock(st.playing && (s?.keep_awake ?? true))
  useRecordingSync(engine, tab?.recording ?? null, tab?.recording ? sound : 'tab')
  useEffect(() => { if (tab) document.title = `${tab.title || 'Tab'} · ${settings?.title || 'Pocket Guitar'}` }, [tab?.title]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- keyboard ----
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (t.closest('input, textarea, [contenteditable="true"]') || modalOpen() || document.querySelector('.menu, .sel-pop, .popover')) return
      const step = (s?.speed_step || 5) / 100
      const cur = engine.position.get().bar
      const take = () => e.preventDefault()
      switch (e.key) {
        case ' ': take(); (document.activeElement as HTMLElement | null)?.blur?.(); engine.playPause(); break
        case 'Escape': if (engine.state.get().range) engine.clearSelection(); else engine.stop(); break
        case 'l': case 'L': take(); toggleLoop(); break
        case '[': take(); engine.setSpeed(engine.state.get().speed - step); break
        case ']': take(); engine.setSpeed(engine.state.get().speed + step); break
        case 'm': case 'M': take(); engine.setMetronome(!engine.state.get().metronome); break
        case 'c': case 'C': take(); engine.setCountIn(!engine.state.get().countIn); break
        case 'f': case 'F': take(); setView({ fretboard: !view.fretboard }); break
        case 't': case 'T': take(); (document.querySelector('.transport [data-k="tracks"]') as HTMLElement | null)?.click(); break
        case 'ArrowLeft': take(); engine.seekBar(cur - 1); break
        case 'ArrowRight': take(); engine.seekBar(cur + 1); break
        case 'Home': take(); engine.stop(); break
        case 's': case 'S': take(); saveSelection(); break
        default:
          if (/^[1-9]$/.test(e.key)) { const sec = sections[Number(e.key) - 1]; if (sec) { take(); activate(sec) } }
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  // ---- setlist navigation ----
  const pos = setlist ? setlist.tab_ids.indexOf(tabId) : -1
  const prevId = setlist && pos > 0 ? setlist.tab_ids[pos - 1] : 0
  const nextId = setlist && pos >= 0 && pos < setlist.tab_ids.length - 1 ? setlist.tab_ids[pos + 1] : 0
  const goTab = (id: number) => navigate(`/tab/${id}?setlist=${setlistId}`)
  const back = () => navigate(setlistId ? `/setlists/${setlistId}` : '/library')

  const [moreAt, setMoreAt] = useState<Anchor | null>(null)
  const shown = tracks || [0]
  const fretTrack = shown.find(i => { const tr = st.score?.tracks[i]; return tr && !tr.staves[0]?.isPercussion && tr.staves[0]?.isStringed }) ?? shown[0]
  const statusLabel = tab ? STATUS.find(x => x.value === tab.status)?.label : ''

  const panelBody = tab && panel && (
    panel === 'sections' ? <SectionsPanel tab={tab} sections={sections} setSections={setSections} st={st} activeId={activeId} onActivate={activate}
      onSelectBars={(a, b) => { engine.selectBars(a, b); engine.setLooping(true) }} onClear={() => engine.clearSelection()}
      trainer={trainer} setTrainer={setTrainer} passes={passes} aiPlan={aiPlan} aiReady={aiReady} />
      : panel === 'song' ? <SongPanel tab={tab} patch={patch} onPrint={() => engine.print()} todayS={timer.todayS} sessionS={timer.sessionS} fileNotes={st.fileNotes} />
        : <RecordingPanel tab={tab} setRecording={setRecording} mode={sound} setMode={setSound} />
  )
  const panelTitle = panel === 'sections' ? 'Sections and loops' : panel === 'song' ? 'The song' : 'Original recording'
  const panelBtn = (k: PanelKind, icon: string, label: string, hint: string) => (
    <button type="button" className={`btn ghost ph-tab ${panel === k ? 'active' : ''}`} onClick={e => setPanel(panel === k ? null : k, e.currentTarget)} aria-pressed={panel === k} title={hint}>
      <PIcon name={icon} size={16} /><span className="ph-tab-l">{label}</span>
    </button>
  )

  if (loadErr) {
    return (
      <div className="player player-error">
        <header className="ph"><button type="button" className="btn ghost icon-only" onClick={back} aria-label="Back"><Icon name="chevron-left" size={20} /></button><div className="ph-title"><b>Tab</b></div><span className="spacer" /><AskButton /></header>
        <div className="player-msg"><Icon name="alert" size={22} /><h2>{loadErr}</h2><Link to="/library" className="btn">Back to the library</Link></div>
      </div>
    )
  }

  return (
    <div className={`player ${panel && !mobile ? 'with-panel' : ''} ${s?.score_colors === 'paper' ? 'paper' : ''}`}>
      <header className="ph">
        <button type="button" className="btn ghost icon-only" onClick={back} aria-label={setlistId ? 'Back to the setlist' : 'Back to the library'} title="Back"><Icon name="chevron-left" size={20} /></button>
        <div className="ph-title">
          <b className="ellipsis">{tab?.title || ' '}</b>
          <span className="ph-sub muted small ellipsis">{tab ? [tab.artist, statusLabel, tab.tuning && tab.tuning !== 'Standard' ? tab.tuning : '', tab.capo ? `capo ${tab.capo}` : ''].filter(Boolean).join(' · ') : ' '}</span>
        </div>
        {setlist && pos >= 0 && (
          <div className="ph-setlist" aria-label="Setlist">
            <button type="button" className="btn ghost icon-only sm" disabled={!prevId} onClick={() => goTab(prevId)} aria-label="Previous song" title="Previous song"><Icon name="chevron-left" size={16} /></button>
            <span className="small tnum" title={setlist.name}>{pos + 1} of {setlist.tab_ids.length}</span>
            <button type="button" className="btn ghost icon-only sm" disabled={!nextId} onClick={() => goTab(nextId)} aria-label="Next song" title="Next song"><Icon name="chevron-right" size={16} /></button>
          </div>
        )}
        <span className="spacer" />
        <button type="button" className={`btn ghost icon-only ph-fav ${tab?.favorite ? 'on' : ''}`} disabled={!tab} onClick={() => tab && patch({ favorite: !tab.favorite })} aria-pressed={!!tab?.favorite} aria-label="Favourite" title={tab?.favorite ? 'In your favourites' : 'Add to favourites'}><Icon name="star" size={18} /></button>
        <div className="ph-tabs" role="group" aria-label="Panels">
          {panelBtn('sections', 'bars', 'Sections', 'Sections, loops and the speed trainer')}
          {panelBtn('song', 'notes', 'Song', 'Status, notes and details')}
          {panelBtn('recording', 'record', 'Record', 'Play along with the original recording')}
        </div>
        <AskButton />
        <button type="button" className="btn ghost icon-only" onClick={e => setMoreAt(moreAt ? null : rectOf(e.currentTarget))} aria-label="More" title="More"><Icon name="more" size={18} /></button>
        {moreAt && <Menu anchor={moreAt} align="right" width={250} onClose={() => setMoreAt(null)} items={[
          { label: 'Download the original file', icon: 'download', onSelect: () => { const a = document.createElement('a'); a.href = `${V1}/tabs/${tabId}/file`; a.download = ''; document.body.appendChild(a); a.click(); a.remove() } },
          { label: 'Print', icon: 'file', onSelect: () => engine.print() },
          { label: 'Save selection as a section', icon: 'plus', hint: 'S', disabled: !st.range, onSelect: saveSelection },
          'sep',
          { label: 'Library', icon: 'grid', onSelect: () => navigate('/library') },
          ...(setlistId ? [{ label: 'This setlist', icon: 'list', onSelect: () => navigate(`/setlists/${setlistId}`) }] : []),
        ]} />}
      </header>

      <div className="player-main">
        <div className="score-wrap" ref={scrollEl}>
          {(st.phase === 'loading' || st.phase === 'idle') && <div className="score-loading"><Loading label="Opening the tab…" /></div>}
          {st.phase === 'error' && <div className="player-msg"><Icon name="alert" size={22} /><h2>{st.error}</h2><p className="muted">You can still download the original file from the ⋯ menu.</p></div>}
          <div className={`score ${st.phase === 'rendering' ? 'rendering' : ''}`} ref={scoreEl} />
        </div>
        {panel && !mobile && (
          <aside className="player-panel" aria-label={panelTitle}>
            <div className="pp-head"><h2>{panelTitle}</h2><button type="button" className="btn ghost icon-only sm" onClick={() => setPanel(null)} aria-label="Close the panel"><Icon name="x" size={16} /></button></div>
            {panelBody}
          </aside>
        )}
      </div>

      {view.fretboard && st.score && <Fretboard engine={engine} score={st.score} track={fretTrack} leftHanded={!!s?.left_handed} />}

      <div className="tp-wrap">
        {!st.playerReady && st.score && st.phase !== 'error' && <div className="tp-soundload small muted" aria-live="polite">Loading the instrument sounds… <span className="tnum">{Math.round(st.soundLoad * 100)}%</span></div>}
        <Transport engine={engine} st={st} speedStep={s?.speed_step || 5} tracks={shown} setTracks={setTracks} view={view} setView={setView}
          todayS={timer.todayS} onLoop={toggleLoop} hasRecording={!!tab?.recording} soundLabel={sound === 'recording' ? 'the record only' : sound === 'both' ? 'with the record' : 'tab sound'} />
      </div>

      {mobile && panel && sheetAt && (
        <Popover anchor={sheetAt} onClose={() => setPanel(null)} label={panelTitle} className="pp-sheet">
          <div className="pp-head"><h2>{panelTitle}</h2><button type="button" className="btn ghost icon-only sm" onClick={() => setPanel(null)} aria-label="Close"><Icon name="x" size={16} /></button></div>
          {panelBody}
        </Popover>
      )}
      {plan && (
        <Modal title="Practice plan" onClose={() => setPlan(null)} size="lg">
          {plan.busy ? <Loading label="Thinking about this song…" /> : <div className="ai-plan">{plan.text.split('\n').filter(l => l.trim()).map((l, i) => <p key={i}>{l}</p>)}</div>}
        </Modal>
      )}
    </div>
  )
}

function readColors(): ScoreColors {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  return { main: v('--text'), secondary: v('--muted'), staff: v('--border-strong'), bar: v('--muted'), barNumber: v('--faint'), info: v('--text') }
}

/** Score colours from the app's own tokens, re-read when the theme changes. */
function useScoreColors(theme: string, mode: 'theme' | 'paper'): ScoreColors | null {
  const [c, setC] = useState<ScoreColors | null>(() => (mode === 'paper' ? null : readColors()))
  useEffect(() => {
    if (mode === 'paper') { setC(null); return }
    // a frame later the new data-theme tokens are in place
    const r = requestAnimationFrame(() => setC(prev => { const n = readColors(); return JSON.stringify(n) === JSON.stringify(prev) ? prev : n }))
    return () => cancelAnimationFrame(r)
  }, [theme, mode])
  return c
}
