// A song as a card (grid) or a row (list): cover tile, names, what it needs, progress.
import { Link } from 'react-router-dom'
import { ago } from '../lib/format'
import { fmtLength, fmtSeconds, STATUSES, tabHue, tabInitials } from '../lib/guitar'
import type { Tab } from '../lib/types'
import { Icon } from './icons'
import { MenuButton, type MenuItem } from './ui'

export function Cover({ tab, size = 44 }: { tab: Pick<Tab, 'id' | 'title' | 'artist'>; size?: number }) {
  const h = tabHue(tab)
  return (
    <span className="cover" aria-hidden style={{ width: size, height: size, fontSize: size * 0.36, background: `linear-gradient(140deg, hsl(${h} 62% 58%), hsl(${(h + 40) % 360} 58% 42%))` }}>
      {tabInitials(tab)}
    </span>
  )
}

export function StatusChip({ tab }: { tab: Pick<Tab, 'status'> }) {
  const s = STATUSES.find(x => x.id === tab.status)
  return <span className={`status-chip st-${tab.status}`}>{s?.short || tab.status}</span>
}

/** Best speed against the goal, as a thin bar (only once the song was played). */
export function SpeedBar({ tab }: { tab: Pick<Tab, 'best_speed' | 'goal_speed'> }) {
  if (!tab.best_speed) return null
  const pct = Math.min(100, Math.round((tab.best_speed / Math.max(1, tab.goal_speed)) * 100))
  return (
    <span className="speed-bar" title={`Best ${tab.best_speed}% of the written tempo, goal ${tab.goal_speed}%`}>
      <span className="speed-track"><span className="speed-fill" style={{ width: `${pct}%` }} /></span>
      <span className="speed-v tnum">{tab.best_speed}%</span>
    </span>
  )
}

export function tabMeta(t: Tab): string {
  return [t.tuning && t.tuning !== 'Standard' ? t.tuning : '', t.tempo ? `${t.tempo} bpm` : '', t.duration_s ? fmtLength(t.duration_s) : '', t.capo ? `capo ${t.capo}` : ''].filter(Boolean).join(' · ')
}

export function TabCard({ tab, menu, onFavorite }: { tab: Tab; menu?: () => MenuItem[]; onFavorite?: (t: Tab) => void }) {
  return (
    <div className={`tab-card ${tab.source_missing ? 'missing' : ''}`}>
      <Link to={`/tab/${tab.id}`} className="tab-card-main">
        <Cover tab={tab} size={52} />
        <span className="tab-card-text">
          <span className="tab-title ellipsis">{tab.title || tab.file_name}</span>
          <span className="tab-artist ellipsis">{tab.artist || 'Unknown artist'}</span>
          <span className="tab-meta ellipsis">{tabMeta(tab) || ' '}</span>
        </span>
      </Link>
      <div className="tab-card-foot">
        <StatusChip tab={tab} />
        <SpeedBar tab={tab} />
        <span className="spacer" />
        {onFavorite && <button type="button" className={`btn ghost icon-only xs fav ${tab.favorite ? 'on' : ''}`} aria-pressed={tab.favorite} title={tab.favorite ? 'Remove from favourites' : 'Add to favourites'} onClick={() => onFavorite(tab)}><Icon name="star" size={15} /></button>}
        {menu && <MenuButton label="More" className="btn ghost icon-only xs" items={menu} align="right"><Icon name="more" size={15} /></MenuButton>}
      </div>
    </div>
  )
}

export function TabRow({ tab, menu, onFavorite, extra }: { tab: Tab; menu?: () => MenuItem[]; onFavorite?: (t: Tab) => void; extra?: React.ReactNode }) {
  return (
    <div className={`tab-row ${tab.source_missing ? 'missing' : ''}`}>
      <Link to={`/tab/${tab.id}`} className="tab-row-main">
        <Cover tab={tab} size={38} />
        <span className="tab-row-text">
          <span className="tab-title ellipsis">{tab.title || tab.file_name}</span>
          <span className="tab-artist ellipsis">{[tab.artist || 'Unknown artist', tabMeta(tab)].filter(Boolean).join(' · ')}</span>
        </span>
      </Link>
      <span className="tab-row-side">
        {extra}
        <span className="tab-row-played muted small tnum">{tab.last_played_at ? `${fmtSeconds(tab.practice_s)} · ${ago(tab.last_played_at)}` : 'Not played yet'}</span>
        <StatusChip tab={tab} />
        {onFavorite && <button type="button" className={`btn ghost icon-only xs fav ${tab.favorite ? 'on' : ''}`} aria-pressed={tab.favorite} title={tab.favorite ? 'Remove from favourites' : 'Add to favourites'} onClick={() => onFavorite(tab)}><Icon name="star" size={15} /></button>}
        {menu && <MenuButton label="More" className="btn ghost icon-only xs" items={menu} align="right"><Icon name="more" size={15} /></MenuButton>}
      </span>
    </div>
  )
}
