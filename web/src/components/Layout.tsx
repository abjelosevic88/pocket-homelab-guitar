// The app shell: sidebar, top bar, search palette, shortcuts — the Pocket Calendar layout.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import type { Dashboard } from '../lib/types'
import { Icon } from './icons'
import { Sidebar } from './Sidebar'
import { CommandPalette, type PaletteCommand } from './CommandPalette'
import { ShortcutsSheet } from './ShortcutsSheet'
import { PracticeModal } from './PracticeForm'
import { AddTabsModal, type AddMode } from './AddTabs'
import { SetlistModal } from '../pages/Setlists'
import { Avatar, type Anchor, type MenuItem, Menu, MenuButton, modalOpen, rectOf, useIsMobile, useMediaQuery } from './ui'
import { AskButton } from './AskButton'
import { TopbarTimer } from './SharedTimer'

const SIDEBAR_KEY = 'pgt-sidebar'

/** Something was added or changed from the shell (or a page): the counts and the pages reload. */
export const announceChange = () => window.dispatchEvent(new CustomEvent('pgt:changed'))
export function useOnChange(cb: () => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    const h = () => ref.current()
    window.addEventListener('pgt:changed', h)
    return () => window.removeEventListener('pgt:changed', h)
  }, [])
}

/** The page's own name for the top bar breadcrumb. */
const CrumbCtx = createContext<(t: string) => void>(() => {})
export function useCrumb(title: string | undefined) {
  const set = useContext(CrumbCtx)
  useEffect(() => { set(title || ''); return () => set('') }, [title, set])
}

/** The dashboard numbers (today, streak, counts) for every page that wants them. */
const CountsCtx = createContext<Dashboard | null>(null)
export const useCounts = () => useContext(CountsCtx)

export type CreateKind = 'add' | 'songsterr' | 'folder' | 'practice' | 'setlist' | 'tuner' | 'metronome'

/** Open a create action from anywhere (a page's button). */
export const openCreate = (k: CreateKind) => window.dispatchEvent(new CustomEvent('pgt:create', { detail: { kind: k } }))

/** The add menu: the sidebar's "Add" button and the phone's + button. */
export function createItems(onCreate: (k: CreateKind) => void, songsterr: boolean): MenuItem[] {
  return [
    { label: 'Upload tab files…', icon: 'upload', hint: 'N', onSelect: () => onCreate('add') },
    { label: 'Search Songsterr…', icon: 'search', disabled: !songsterr, onSelect: () => onCreate('songsterr') },
    { label: 'From a Pocket Files folder…', icon: 'folder', onSelect: () => onCreate('folder') },
    'sep',
    { label: 'Log practice', icon: 'clock', hint: 'L', onSelect: () => onCreate('practice') },
    { label: 'New setlist', icon: 'list-music', onSelect: () => onCreate('setlist') },
    'sep',
    { label: 'Tuner', icon: 'gauge', hint: 'T', onSelect: () => onCreate('tuner') },
    { label: 'Metronome', icon: 'metronome', hint: 'M', onSelect: () => onCreate('metronome') },
  ]
}

export default function Layout() {
  const navigate = useNavigate()
  const loc = useLocation()
  const { settings } = useApp()
  const [sp, setSp] = useSearchParams()
  const mobile = useIsMobile()
  const narrow = useMediaQuery('(max-width: 1099px)')
  const drawer = mobile || narrow
  const [sidebarOpen, setSidebarOpen] = useState(() => !drawer && localStorage.getItem(SIDEBAR_KEY) !== '0')
  useEffect(() => { setSidebarOpen(!drawer && localStorage.getItem(SIDEBAR_KEY) !== '0') }, [drawer])
  const drawerOpenedAt = useRef(0)
  const toggleSidebar = () => setSidebarOpen(o => { drawerOpenedAt.current = performance.now(); const n = !o; if (!drawer) localStorage.setItem(SIDEBAR_KEY, n ? '1' : '0'); return n })
  const closeDrawer = () => { if (drawer) setSidebarOpen(false) }
  useEffect(() => { document.querySelector('.content')?.scrollTo({ top: 0 }) }, [loc.pathname])

  const [crumb, setCrumbRaw] = useState('')
  const setCrumb = useCallback((t: string) => setCrumbRaw(t), [])

  const [counts, setCounts] = useState<Dashboard | null>(null)
  const load = useCallback(() => { api.get<Dashboard>(`${V1}/dashboard`).then(setCounts).catch(() => {}) }, [])
  useEffect(() => { load() }, [loc.pathname, load])
  useOnChange(load)

  const [palette, setPalette] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [modal, setModal] = useState<{ kind: 'add'; mode: AddMode; files?: File[] } | { kind: 'practice' } | { kind: 'setlist' } | null>(null)
  const [fabMenu, setFabMenu] = useState<Anchor | null>(null)
  const [dragging, setDragging] = useState(false)

  // /?add=1 (the PWA shortcut) opens the add dialog, /?log=1 the practice dialog
  useEffect(() => {
    if (sp.get('add')) { setModal({ kind: 'add', mode: 'upload' }); setSp(new URLSearchParams(), { replace: true }) }
    else if (sp.get('log')) { setModal({ kind: 'practice' }); setSp(new URLSearchParams(), { replace: true }) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const create = (k: CreateKind) => {
    closeDrawer()
    switch (k) {
      case 'add': setModal({ kind: 'add', mode: 'upload' }); break
      case 'songsterr': setModal({ kind: 'add', mode: 'songsterr' }); break
      case 'folder': setModal({ kind: 'add', mode: 'folder' }); break
      case 'practice': setModal({ kind: 'practice' }); break
      case 'setlist': setModal({ kind: 'setlist' }); break
      case 'tuner': navigate('/tools/tuner'); break
      case 'metronome': navigate('/tools/metronome'); break
    }
  }
  const createRef = useRef(create)
  createRef.current = create

  useEffect(() => {
    const open = () => setShortcuts(true)
    const make = (e: Event) => { const d = (e as CustomEvent<{ kind: CreateKind }>).detail; createRef.current(d.kind) }
    window.addEventListener('pgt:shortcuts', open)
    window.addEventListener('pgt:create', make)
    return () => { window.removeEventListener('pgt:shortcuts', open); window.removeEventListener('pgt:create', make) }
  }, [])

  // drop tab files anywhere to add them
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files')
    const enter = (e: DragEvent) => { if (!hasFiles(e) || modalOpen()) return; depth++; setDragging(true) }
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false) }
    const over = (e: DragEvent) => { if (hasFiles(e) && !modalOpen()) e.preventDefault() }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || modalOpen()) return
      e.preventDefault(); depth = 0; setDragging(false)
      const files = Array.from(e.dataTransfer?.files || [])
      if (files.length) setModal({ kind: 'add', mode: 'upload', files })
    }
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over); window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop) }
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (t.closest('input, textarea, select, [contenteditable="true"]') || modalOpen() || document.querySelector('.menu, .popover, .sel-pop')) return
      if (loc.pathname.startsWith('/tools') && e.key === ' ') return
      const go = (to: string) => { e.preventDefault(); navigate(to) }
      const mk = (k: CreateKind) => { e.preventDefault(); createRef.current(k) }
      switch (e.key) {
        case '/': e.preventDefault(); setPalette(true); break
        case '?': e.preventDefault(); setShortcuts(true); break
        case 'n': mk('add'); break
        case 'l': mk('practice'); break
        case 'h': go('/'); break
        case 'b': go('/library'); break
        case 's': go('/setlists'); break
        case 'p': go('/practice'); break
        case 't': go('/tools/tuner'); break
        case 'm': go('/tools/metronome'); break
        case ',': go('/settings'); break
        case '[': e.preventDefault(); toggleSidebar(); break
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  const songsterr = !!settings?.songsterr_available
  const commands: PaletteCommand[] = [
    { id: 'add', label: 'Upload tab files', icon: 'upload', hint: 'N', keywords: 'add import gp guitar pro musicxml', run: () => create('add') },
    ...(songsterr ? [{ id: 'songsterr', label: 'Search Songsterr for a tab', icon: 'search', keywords: 'songsterr url download find online', run: () => create('songsterr') }] : []),
    { id: 'log', label: 'Log practice', icon: 'clock', hint: 'L', keywords: 'practice time add manual', run: () => create('practice') },
    { id: 'home', label: 'Home', icon: 'home', hint: 'H', run: () => navigate('/') },
    { id: 'library', label: 'Library', icon: 'book-open', hint: 'B', keywords: 'songs tabs', run: () => navigate('/library') },
    { id: 'setlists', label: 'Setlists', icon: 'list-music', hint: 'S', keywords: 'gig playlist', run: () => navigate('/setlists') },
    { id: 'practice', label: 'Practice log and statistics', icon: 'chart', hint: 'P', keywords: 'stats streak minutes journal history', run: () => navigate('/practice') },
    { id: 'tuner', label: 'Tuner', icon: 'gauge', hint: 'T', keywords: 'tune tuning pitch', run: () => navigate('/tools/tuner') },
    { id: 'metronome', label: 'Metronome', icon: 'metronome', hint: 'M', keywords: 'click bpm tempo', run: () => navigate('/tools/metronome') },
    { id: 'timer', label: 'Practise without a tab (timer)', icon: 'timer', keywords: 'scales chords improvise free', run: () => navigate('/tools/timer') },
    { id: 'folders', label: 'Settings: tab folders', icon: 'folder', keywords: 'pocket files sync folder', run: () => navigate('/settings/folders') },
    { id: 'player', label: 'Settings: player', icon: 'sliders', keywords: 'notation speed trainer fretboard count in', run: () => navigate('/settings/player') },
    { id: 'apps', label: 'Settings: connected apps', icon: 'layers', keywords: 'habits files navidrome core integrations', run: () => navigate('/settings/apps') },
    { id: 'settings', label: 'Settings', icon: 'settings', hint: ',', run: () => navigate('/settings') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', run: () => setShortcuts(true) },
  ]

  const closeModal = () => setModal(null)
  return (
    <CrumbCtx.Provider value={setCrumb}>
      <CountsCtx.Provider value={counts}>
        <div className={`app ${sidebarOpen ? 'with-sidebar' : 'no-sidebar'} ${mobile ? 'is-mobile' : ''} ${drawer ? 'drawer-mode' : ''}`}>
          {drawer && sidebarOpen && <div className="drawer-backdrop" onClick={e => { if (e.timeStamp - drawerOpenedAt.current > 400) setSidebarOpen(false) }} />}
          <div className={`sidebar-wrap ${sidebarOpen ? 'open' : ''}`}>
            <Sidebar onCreate={create} onNavigate={closeDrawer} counts={counts} />
          </div>
          <div className="main">
            <TopBar onMenu={toggleSidebar} onPalette={() => setPalette(true)} mobile={mobile} compact={narrow} sidebarOpen={sidebarOpen} crumb={crumb} />
            <main className="content"><div className="content-inner"><Outlet /></div></main>
          </div>
          {mobile && <button type="button" className="fab" aria-label="Add" title="Add" aria-haspopup="menu" aria-expanded={!!fabMenu} onClick={e => setFabMenu(fabMenu ? null : rectOf(e.currentTarget))}><Icon name="plus" size={24} strokeWidth={2.2} /></button>}
          {fabMenu && <Menu anchor={fabMenu} align="right" items={createItems(create, songsterr)} onClose={() => setFabMenu(null)} width={250} />}
          {palette && <CommandPalette onClose={() => setPalette(false)} commands={commands} />}
          {shortcuts && <ShortcutsSheet onClose={() => setShortcuts(false)} />}
          {modal?.kind === 'add' && <AddTabsModal initial={modal.mode} files={modal.files} onClose={closeModal} onAdded={() => announceChange()} />}
          {modal?.kind === 'practice' && <PracticeModal onClose={closeModal} onSaved={() => { closeModal(); announceChange() }} />}
          {modal?.kind === 'setlist' && <SetlistModal onClose={closeModal} onSaved={l => { closeModal(); announceChange(); navigate(`/setlists/${l.id}`) }} />}
          {dragging && <div className="drop-overlay" aria-hidden><div><Icon name="upload" size={34} /><b>Drop to add these tabs</b></div></div>}
        </div>
      </CountsCtx.Provider>
    </CrumbCtx.Provider>
  )
}

const SECTION: Record<string, [string, string]> = { '': ['Home', '/'], library: ['Library', '/library'], setlists: ['Setlists', '/setlists'], practice: ['Practice', '/practice'], tools: ['Tools', '/tools'] }

function TopBar({ onMenu, onPalette, mobile, compact, sidebarOpen, crumb }: { onMenu: () => void; onPalette: () => void; mobile: boolean; compact: boolean; sidebarOpen: boolean; crumb: string }) {
  const { user, themeMode, setThemeMode, status, setUser } = useApp()
  const navigate = useNavigate()
  const loc = useLocation()
  const [section, sectionTo] = SECTION[loc.pathname.split('/')[1] || ''] || ['', '/']
  const signOut = async () => { await api.post(`${V1}/auth/logout`).catch(() => {}); setUser(null); navigate('/login') }
  const avatarMenu = (): MenuItem[] => [
    { heading: user?.name || user?.email || '' },
    { label: 'Profile', icon: 'user', onSelect: () => navigate('/settings/profile') },
    { label: 'Settings', icon: 'settings', onSelect: () => navigate('/settings'), hint: ',' },
    { label: 'Keyboard shortcuts', icon: 'keyboard', onSelect: () => window.dispatchEvent(new CustomEvent('pgt:shortcuts')), hint: '?' },
    'sep',
    { heading: 'Appearance' },
    { label: 'System', checked: themeMode === 'system', onSelect: () => setThemeMode('system') },
    { label: 'Light', checked: themeMode === 'light', onSelect: () => setThemeMode('light') },
    { label: 'Dark', checked: themeMode === 'dark', onSelect: () => setThemeMode('dark') },
    ...(status?.auth_mode === 'local' ? ['sep' as const, { label: 'Sign out', icon: 'log-out', onSelect: signOut }] : []),
  ]
  return (
    <header className="topbar">
      <button type="button" className="btn ghost icon-only" onClick={onMenu} aria-label={sidebarOpen ? 'Hide the sidebar' : 'Show the sidebar'} title="Menu ([)"><Icon name={mobile || compact ? 'menu' : 'sidebar'} size={18} /></button>
      <h1 className="range-title">
        {crumb ? <><button type="button" className="crumb" onClick={() => navigate(sectionTo)}>{section}</button><Icon name="chevron-right" size={16} className="crumb-sep" /><span className="ellipsis">{crumb}</span></> : section}
      </h1>
      <span className="spacer" />
      <TopbarTimer />
      <button type="button" className="btn ghost icon-only" onClick={onPalette} aria-label="Search" title="Search (⌘K or /)"><Icon name="search" size={18} /></button>
      <AskButton />
      <MenuButton label="Account" className="avatar-btn" align="right" width={220} items={avatarMenu}>
        <Avatar name={user?.name} email={user?.email} size={30} />
      </MenuButton>
    </header>
  )
}
