// Left column: the add button, sections with today's numbers, what you're learning — the Pocket Calendar sidebar.
import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { useApp } from '../lib/app-context'
import { fmtMinutes, tabName } from '../lib/guitar'
import type { Dashboard } from '../lib/types'
import { Icon } from './icons'
import { createItems, type CreateKind } from './Layout'
import { type Anchor, Menu, rectOf } from './ui'

export function Sidebar({ onCreate, onNavigate, counts }: { onCreate: (k: CreateKind) => void; onNavigate: () => void; counts: Dashboard | null }) {
  const { status, settings } = useApp()
  const [menu, setMenu] = useState<Anchor | null>(null)
  const title = settings?.title || status?.title || 'Pocket Guitar'
  const todayMin = counts ? counts.today_s / 60 : 0
  const goal = counts && counts.goal_min > 0 ? `${Math.round(todayMin)}/${counts.goal_min} min` : todayMin ? fmtMinutes(todayMin) : undefined
  const nav: { to: string; label: string; icon: string; end?: boolean; count?: string }[] = [
    { to: '/', label: 'Home', icon: 'home', end: true, count: goal },
    { to: '/library', label: 'Library', icon: 'book-open', count: counts?.counts.tabs ? String(counts.counts.tabs) : undefined },
    { to: '/setlists', label: 'Setlists', icon: 'list-music' },
    { to: '/practice', label: 'Practice', icon: 'chart' },
    { to: '/tools', label: 'Tuner & metronome', icon: 'gauge' },
  ]
  const learning = counts?.learning.slice(0, 4) || []
  return (
    <aside className="sidebar" aria-label="Pocket Guitar">
      <div className="sb-brand">
        <img src="/favicon.svg" alt="" className="sb-logo" />
        <span className="sb-title">{title !== 'Pocket Guitar' ? title : <>Pocket <b>Guitar</b></>}</span>
        {status?.version && <span className="sb-version" title={`Version ${status.version}`}>{/^v?\d+\.\d+/.test(status.version) ? 'v' + status.version.replace(/^v/, '').replace(/[-+].*$/, '') : status.version}</span>}
      </div>
      <button type="button" className="btn primary create-btn" aria-haspopup="menu" aria-expanded={!!menu} onClick={e => setMenu(menu ? null : rectOf(e.currentTarget))}>
        <Icon name="plus" size={15} strokeWidth={2.2} />Add<Icon name="chevron-down" size={15} className="create-caret" />
      </button>
      {menu && <Menu anchor={menu} items={createItems(onCreate, !!settings?.songsterr_available)} onClose={() => setMenu(null)} width={256} />}

      <nav className="sb-nav" aria-label="Sections">
        {nav.map(n => (
          <NavLink key={n.to} to={n.to} end={n.end} onClick={onNavigate} className={({ isActive }) => `sb-nav-item ${isActive ? 'active' : ''}`}>
            <Icon name={n.icon} size={16} />{n.label}
            {!!n.count && <span className="sb-count">{n.count}</span>}
          </NavLink>
        ))}
      </nav>

      {counts && (
        <section className="sb-sec sb-streak" aria-label="Streak">
          <div className="sb-streak-row">
            <Icon name="flame" size={16} className={counts.streak > 0 ? 'flame-on' : 'muted'} />
            <span><b>{counts.streak}</b> {counts.streak === 1 ? 'day' : 'days'} in a row</span>
          </div>
          <div className="sb-streak-sub muted small">{fmtMinutes(counts.week_s / 60)} this week · best streak {counts.longest_streak}</div>
        </section>
      )}

      {learning.length > 0 && (
        <section className="sb-sec">
          <h4 className="sb-h"><span className="sb-h-btn">Learning now</span></h4>
          <div className="sb-quick">
            {learning.map(t => (
              <Link key={t.id} to={`/tab/${t.id}`} className="sb-quick-btn" onClick={onNavigate} title={tabName(t)}>
                <Icon name="play" size={13} /><span className="ellipsis">{t.title || t.file_name}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="sb-foot">
        <Link to="/settings" className="sb-foot-link" onClick={onNavigate}><Icon name="settings" size={15} />Settings</Link>
        <button type="button" className="sb-foot-link" onClick={() => { onNavigate(); window.dispatchEvent(new CustomEvent('pgt:shortcuts')) }}><Icon name="keyboard" size={15} />Shortcuts</button>
      </div>
    </aside>
  )
}
