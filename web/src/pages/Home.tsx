// Home: today's practice against the goal, the week, and what to play next.
import { Link } from 'react-router-dom'
import { useApp } from '../lib/app-context'
import { weekday } from '../lib/format'
import { fmtMinutes } from '../lib/guitar'
import type { Dashboard, Tab } from '../lib/types'
import { Icon } from '../components/icons'
import { openCreate, useCounts } from '../components/Layout'
import { Cover, SpeedBar, StatusChip, tabMeta } from '../components/TabCard'
import { Loading } from '../components/ui'

function greeting(name?: string) {
  const h = new Date().getHours()
  const part = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return name ? `${part}, ${name.split(' ')[0]}` : part
}

function Ring({ value, goal }: { value: number; goal: number }) {
  const pct = goal > 0 ? Math.min(1, value / goal) : value > 0 ? 1 : 0
  const r = 34, c = 2 * Math.PI * r
  return (
    <div className="ring" style={{ width: 84, height: 84 }}>
      <svg width="84" height="84" viewBox="0 0 84 84" aria-hidden>
        <circle className="ring-bg" cx="42" cy="42" r={r} strokeWidth="8" fill="none" />
        <circle className="ring-fg" cx="42" cy="42" r={r} strokeWidth="8" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round" transform="rotate(-90 42 42)" />
      </svg>
      <div className="ring-label"><b className="tnum">{Math.round(value)}</b><span>{goal > 0 ? `of ${goal} min` : 'min'}</span></div>
    </div>
  )
}

function Week({ d }: { d: Dashboard }) {
  const max = Math.max(d.goal_min * 60, ...d.week.map(w => w.seconds), 60)
  return (
    <div className="home-week" aria-label="The last seven days">
      {d.week.map(w => (
        <div key={w.date} className="home-week-day" title={`${weekday(w.date, true)}: ${fmtMinutes(w.seconds / 60)}`}>
          <div className="home-week-track"><div className={`home-week-fill ${d.goal_min > 0 && w.seconds >= d.goal_min * 60 ? 'met' : ''}`} style={{ height: `${Math.max(w.seconds ? 6 : 0, (w.seconds / max) * 100)}%` }} /></div>
          <span className="muted xs">{weekday(w.date).slice(0, 2)}</span>
        </div>
      ))}
    </div>
  )
}

function SongTile({ t }: { t: Tab }) {
  return (
    <Link to={`/tab/${t.id}`} className="song-tile">
      <Cover tab={t} size={46} />
      <span className="song-tile-text">
        <span className="tab-title ellipsis">{t.title || t.file_name}</span>
        <span className="tab-artist ellipsis">{t.artist || 'Unknown artist'}</span>
        <span className="song-tile-foot"><StatusChip tab={t} /><SpeedBar tab={t} /></span>
      </span>
      <span className="song-tile-play" aria-hidden><Icon name="play" size={16} /></span>
    </Link>
  )
}

export default function Home() {
  const { user } = useApp()
  const d = useCounts()
  if (!d) return <Loading />
  const empty = d.counts.tabs === 0
  const todayMin = d.today_s / 60
  const goalLeft = d.goal_min > 0 ? Math.max(0, d.goal_min - todayMin) : 0
  const next = d.learning[0] || d.recent[0] || d.added[0]
  return (
    <div className="home">
      <div className="home-hero card">
        <div className="home-hero-text">
          <h2>{greeting(user?.name)}</h2>
          <p className="muted">
            {empty ? 'Add your first tabs and start playing.'
              : todayMin === 0 ? (d.streak > 0 ? `Play today to make it ${d.streak + 1} days in a row.` : 'Nothing played yet today.')
                : goalLeft > 0 ? `${fmtMinutes(goalLeft)} to go for today's goal.` : 'Today’s goal is done. Anything more is a bonus.'}
          </p>
          <div className="home-hero-stats">
            <span><Icon name="flame" size={15} className={d.streak > 0 ? 'flame-on' : 'muted'} /><b className="tnum">{d.streak}</b> {d.streak === 1 ? 'day' : 'days'} in a row</span>
            <span><Icon name="clock" size={15} /><b className="tnum">{fmtMinutes(d.week_s / 60)}</b> this week</span>
            <span><Icon name="check-circle" size={15} /><b className="tnum">{d.counts.mastered}</b> {d.counts.mastered === 1 ? 'song' : 'songs'} you can play</span>
          </div>
          {next && <Link to={`/tab/${next.id}`} className="btn primary home-cta"><Icon name="play" size={15} /><span className="ellipsis">{d.learning[0] || d.recent[0] ? 'Continue' : 'Start'}: {next.title || next.file_name}</span></Link>}
        </div>
        <div className="home-hero-side">
          <Ring value={todayMin} goal={d.goal_min} />
          <Week d={d} />
        </div>
      </div>

      {empty ? (
        <div className="home-start">
          <button type="button" className="start-card" onClick={() => openCreate('add')}><Icon name="upload" size={22} /><b>Upload tab files</b><span className="muted small">Guitar Pro 3–8, MusicXML or alphaTex, or drop them anywhere on this page.</span></button>
          <button type="button" className="start-card" onClick={() => openCreate('folder')}><Icon name="folder" size={22} /><b>Use a Pocket Files folder</b><span className="muted small">Point to the folder where your tabs live; new ones show up by themselves.</span></button>
          <button type="button" className="start-card" onClick={() => openCreate('songsterr')}><Icon name="download" size={22} /><b>From Songsterr</b><span className="muted small">Paste the address of a tab and get it with every track.</span></button>
        </div>
      ) : (
        <>
          {d.learning.length > 0 && (
            <section className="home-sec">
              <div className="home-sec-head"><h3>Learning now</h3><Link to="/library?status=learning" className="link-btn small">All</Link></div>
              <div className="song-tiles">{d.learning.map(t => <SongTile key={t.id} t={t} />)}</div>
            </section>
          )}
          {d.recent.length > 0 && (
            <section className="home-sec">
              <div className="home-sec-head"><h3>Played lately</h3><Link to="/library?sort=recent" className="link-btn small">Library</Link></div>
              <div className="home-list card">
                {d.recent.map(t => (
                  <Link key={t.id} to={`/tab/${t.id}`} className="home-list-row">
                    <Cover tab={t} size={34} />
                    <span className="grow ellipsis"><b>{t.title || t.file_name}</b> <span className="muted">{t.artist}</span></span>
                    <span className="muted small tnum hide-phone">{tabMeta(t)}</span>
                    <span className="muted small tnum">{fmtMinutes(t.practice_s / 60)}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
          {d.added.length > 0 && (
            <section className="home-sec">
              <div className="home-sec-head"><h3>New in your library</h3><Link to="/library?sort=added" className="link-btn small">All</Link></div>
              <div className="song-tiles">{d.added.map(t => <SongTile key={t.id} t={t} />)}</div>
            </section>
          )}
        </>
      )}

      <section className="home-sec">
        <div className="home-sec-head"><h3>Tools</h3></div>
        <div className="home-tools">
          <Link to="/tools/tuner" className="tool-btn"><Icon name="gauge" size={18} />Tuner</Link>
          <Link to="/tools/metronome" className="tool-btn"><Icon name="metronome" size={18} />Metronome</Link>
          <Link to="/tools/timer" className="tool-btn"><Icon name="timer" size={18} />Practise without a tab</Link>
          <Link to="/practice" className="tool-btn"><Icon name="chart" size={18} />Your practice</Link>
        </div>
      </section>
    </div>
  )
}
