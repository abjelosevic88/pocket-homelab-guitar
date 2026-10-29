// Practice: how your practice adds up (today, streak, the week, the year,
// per song, when you play) and the journal of every session.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, V1 } from '../lib/api'
import { useApp } from '../lib/app-context'
import { addDays, fmtDate, fmtISOTime, todayISO } from '../lib/format'
import type { DayPoint, PracticeSession, Stats } from '../lib/types'
import { Bars, Heatmap, LineChart, Ring } from '../components/Chart'
import { Icon } from '../components/icons'
import { useOnChange, announceChange } from '../components/Layout'
import { PracticeModal } from '../components/PracticeForm'
import { Card, Confirm, Empty, Loading, MenuButton, PageHeader, Segmented, errMsg, useToast } from '../components/ui'
import { mins, minutes } from '../tools/common'

type Range = 'week' | 'month' | 'year'
const RANGE_DAYS: Record<Range, number> = { week: 7, month: 30, year: 365 }
const PAGE = 30
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function Practice() {
  const { settings } = useApp()
  const { toast } = useToast()
  const [sp, setSp] = useSearchParams()
  const tabFilter = Number(sp.get('tab')) || 0
  const [range, setRange] = useState<Range>(() => (localStorage.getItem('pgt-practice-range') as Range) || 'month')
  const [stats, setStats] = useState<Stats | null>(null)
  const [sessions, setSessions] = useState<PracticeSession[] | null>(null)
  const [total, setTotal] = useState(0)
  const [more, setMore] = useState(false)
  const [modal, setModal] = useState<Partial<PracticeSession> | null>(null)
  const [del, setDel] = useState<PracticeSession | null>(null)
  const goal = settings?.daily_goal_min || 0
  const heat = useRef<HTMLDivElement>(null)
  const weekStart = settings?.week_start || 1

  const loadStats = useCallback(() => {
    const to = todayISO()
    api.get<Stats>(`${V1}/stats?from=${addDays(to, -(RANGE_DAYS[range] - 1))}&to=${to}`).then(setStats).catch(e => toast(errMsg(e), 'err'))
  }, [range]) // eslint-disable-line react-hooks/exhaustive-deps
  const loadJournal = useCallback(async (offset = 0) => {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    if (tabFilter) q.set('tab_id', String(tabFilter))
    try {
      const r = await api.get<{ sessions: PracticeSession[]; total: number }>(`${V1}/practice?${q}`)
      setSessions(prev => offset ? [...(prev || []), ...r.sessions] : r.sessions)
      setTotal(r.total)
    } catch (e) { toast(errMsg(e), 'err'); setSessions(s => s || []) }
  }, [tabFilter]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadStats(); localStorage.setItem('pgt-practice-range', range) }, [loadStats, range])
  useEffect(() => { loadJournal(0) }, [loadJournal])
  useOnChange(() => { loadStats(); loadJournal(0) })
  // on a narrow screen the year scrolls sideways: start at the latest weeks
  const hasStats = !!stats
  useEffect(() => { const el = heat.current; if (el) el.scrollLeft = el.scrollWidth }, [hasStats])

  // header numbers come from the last year, so they do not change with the range
  const year = stats?.year || []
  const today = todayISO()
  const todayS = year.find(d => d.date === today)?.seconds || 0
  const weekS = year.filter(d => d.date > addDays(today, -7)).reduce((a, d) => a + d.seconds, 0)

  const chart = useMemo(() => {
    if (!stats) return []
    const days = stats.days
    if (range !== 'year') return days.map(d => ({ x: d.date, y: mins(d.seconds) }))
    const out: { x: string; y: number }[] = []
    for (let i = 0; i < days.length; i += 7) {
      const chunk = days.slice(i, i + 7)
      out.push({ x: chunk[0].date, y: mins(chunk.reduce((a, d) => a + d.seconds, 0)) })
    }
    return out
  }, [stats, range])
  const weekdays = useMemo(() => {
    const vals = stats?.by_weekday || []
    const order = weekStart === 7 ? [6, 0, 1, 2, 3, 4, 5] : weekStart === 6 ? [5, 6, 0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6]
    return order.map(i => ({ label: WEEKDAYS[i], value: mins(vals[i] || 0) }))
  }, [stats, weekStart])
  const hours = useMemo(() => (stats?.by_hour || []).map((s, h) => ({ label: String(h), value: mins(s), hint: `${h}:00` })), [stats])
  const peakHour = useMemo(() => {
    const h = stats?.by_hour || []
    let best = -1
    h.forEach((v, i) => { if (v > 0 && (best < 0 || v > h[best])) best = i })
    return best
  }, [stats])
  const topSongs = (stats?.by_tab || []).slice(0, 10)
  const songMax = Math.max(1, ...topSongs.map(s => s.seconds))

  const groups = useMemo(() => {
    const g: { date: string; items: PracticeSession[]; seconds: number }[] = []
    for (const s of sessions || []) {
      const last = g[g.length - 1]
      if (last && last.date === s.date) { last.items.push(s); last.seconds += s.duration_s } else g.push({ date: s.date, items: [s], seconds: s.duration_s })
    }
    return g
  }, [sessions])
  const filterTitle = tabFilter ? sessions?.find(s => s.tab_id === tabFilter)?.title : ''

  const remove = async () => {
    const s = del!
    setDel(null)
    try { await api.del(`${V1}/practice/${s.id}`); toast('Practice deleted'); announceChange() } catch (e) { toast(errMsg(e), 'err') }
  }
  const showMore = async () => { setMore(true); await loadJournal(sessions?.length || 0); setMore(false) }
  const dayLabel = (d: string) => d === today ? 'Today' : d === addDays(today, -1) ? 'Yesterday' : `${new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'long' })}, ${fmtDate(d, d.slice(0, 4) !== today.slice(0, 4))}`

  return (
    <div className="gt-practice">
      <PageHeader title="Practice" sub="Every session you play is logged here — by the player on its own, or by hand."
        actions={<button type="button" className="btn primary" onClick={() => setModal({})}><Icon name="plus" size={15} />Log practice</button>} />

      <div className="gt-kpis">
        <div className="gt-kpi gt-kpi-today">
          <Ring pct={goal ? (todayS / 60 / goal) * 100 : todayS ? 100 : 0} size={58} stroke={6}><span className="tnum gt-ring-n">{mins(todayS)}</span></Ring>
          <div><div className="stat-l">Today</div><div className="gt-kpi-v tnum">{mins(todayS)}<small> {goal ? `of ${goal} min` : 'min'}</small></div>
            <div className="muted small">{!goal ? 'No daily goal set' : todayS / 60 >= goal ? 'Goal reached' : `${Math.max(0, goal - mins(todayS))} min to go`}</div></div>
        </div>
        <div className="gt-kpi">
          <div className="stat-l">Streak</div>
          <div className="gt-kpi-v tnum"><Icon name="flame" size={18} className={stats?.streak ? 'flame-on' : 'muted'} />{stats?.streak ?? '–'}<small> {stats?.streak === 1 ? 'day' : 'days'}</small></div>
          <div className="muted small tnum">Best {stats?.longest_streak ?? '–'} days</div>
        </div>
        <div className="gt-kpi">
          <div className="stat-l">Last 7 days</div>
          <div className="gt-kpi-v tnum">{minutes(weekS) || '0 min'}</div>
          <div className="muted small tnum">{year.filter(d => d.date > addDays(today, -7) && d.seconds > 0).length} of 7 days played</div>
        </div>
        <div className="gt-kpi">
          <div className="stat-l">Last {range === 'week' ? '7 days' : range === 'month' ? '30 days' : 'year'}</div>
          <div className="gt-kpi-v tnum">{stats ? minutes(stats.total_s) || '0 min' : '–'}</div>
          <div className="muted small tnum">{stats ? `${stats.sessions} sessions · ${stats.days_practised} days` : ' '}</div>
        </div>
      </div>

      <Card title="Minutes played" sub={range === 'year' ? 'Per week' : `Per day${goal ? ` — the line is your goal of ${goal} min` : ''}`}
        actions={<Segmented<Range> size="sm" value={range} onChange={setRange} label="Range" options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }]} />}>
        <div className="gt-chart-box">
          {!stats ? <Loading /> : stats.total_s === 0
            ? <Empty title="No practice in this time" icon="chart">Play a song and the minutes show up here.</Empty>
            : <LineChart points={chart} kind="bar" height={190} zero goal={range !== 'year' && goal ? goal : undefined} goalLabel={`goal ${goal} min`} format={v => `${Math.round(v)}`} />}
        </div>
      </Card>

      <div className="gt-two">
        <Card title="By song" sub="Where your time went">
          {!stats ? <Loading /> : !topSongs.length ? <p className="muted small">Nothing yet in this time.</p> : (
            <div className="gt-songbars">
              {topSongs.map((s, i) => {
                const label = <><span className="gt-sb-t ellipsis">{s.title || 'Untitled'}</span>{s.artist && <span className="gt-sb-a ellipsis">{s.artist}</span>}</>
                return (
                  <div key={i} className="gt-sb">
                    {s.tab_id ? <Link to={`/tab/${s.tab_id}`} className="gt-sb-l">{label}</Link> : <span className="gt-sb-l">{label}</span>}
                    <span className="gt-sb-track"><span style={{ width: `${(s.seconds / songMax) * 100}%` }} /></span>
                    <span className="gt-sb-v tnum">{minutes(s.seconds)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
        <Card title="When you play" sub={peakHour >= 0 ? `Most often around ${peakHour}:00` : 'By weekday and hour'}>
          {!stats ? <Loading /> : (
            <div className="gt-when">
              <Bars items={weekdays} height={110} format={v => `${v}`} />
              <div className="gt-hours"><Bars items={hours} height={90} format={v => `${v} min`} /></div>
            </div>
          )}
        </Card>
      </div>

      <Card title="The last year" sub="Each square is a day; darker means more practice.">
        <div className="gt-heat" ref={heat}>{stats ? <Heatmap days={year.map((d: DayPoint) => ({ date: d.date, minutes: d.seconds / 60 }))} weekStart={weekStart} goal={goal} /> : <Loading />}</div>
      </Card>

      {!!stats?.mastered.length && (
        <Card title="Songs you can play" sub="Everything you marked “Can play it”">
          <ul className="gt-mastered">
            {stats.mastered.map(m => (
              <li key={m.tab_id}><Link to={`/tab/${m.tab_id}`}><Icon name="trophy" size={15} className="gt-gold" /><span className="ellipsis"><b>{m.title}</b>{m.artist && <span className="muted"> · {m.artist}</span>}</span>{m.at && <span className="muted small tnum">{fmtDate(m.at.slice(0, 10))}</span>}</Link></li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Journal" flush sub={tabFilter ? undefined : total ? `${total.toLocaleString()} sessions` : undefined}
        actions={tabFilter ? <button type="button" className="chip active" onClick={() => { sp.delete('tab'); setSp(sp, { replace: true }) }}>Only {filterTitle || 'this song'}<Icon name="x" size={13} /></button> : undefined}>
        {sessions === null ? <div className="pad"><Loading /></div> : !sessions.length ? (
          <Empty title="Nothing logged yet" icon="journal">Open a song and press play — the time you practise is logged here by itself. Practised without a tab? Use the timer under Tools, or <button type="button" className="link-btn" onClick={() => setModal({})}>log it by hand</button>.</Empty>
        ) : (
          <div className="gt-journal">
            {groups.map(g => (
              <section key={g.date}>
                <div className="gt-day-h"><span>{dayLabel(g.date)}</span><span className="tnum">{minutes(g.seconds)}</span></div>
                {g.items.map(s => (
                  <div key={s.id} className="gt-session">
                    <span className={`gt-session-ico ${s.kind === 'free' ? 'free' : ''}`}><Icon name={s.kind === 'free' ? 'timer' : 'music'} size={16} /></span>
                    <div className="gt-session-main">
                      <div className="gt-session-t ellipsis">{s.tab_id ? <Link to={`/tab/${s.tab_id}`}>{s.title || 'Untitled'}</Link> : <span>{s.title || 'Practice'}</span>}</div>
                      <div className="muted small tnum">{[minutes(s.duration_s), s.speed ? `up to ${s.speed}%` : '', s.loops ? `${s.loops} ${s.loops === 1 ? 'loop' : 'loops'}` : '', fmtISOTime(s.started_at), s.source !== 'app' && s.source !== 'manual' ? `from ${s.source}` : ''].filter(Boolean).join(' · ')}</div>
                      {s.note && <div className="gt-session-note">{s.note}</div>}
                    </div>
                    <MenuButton label="More" className="btn ghost icon-only sm" align="right" width={180} items={[
                      { label: 'Change', icon: 'edit', onSelect: () => setModal(s) },
                      ...(s.tab_id ? [{ label: 'Only this song', icon: 'list', onSelect: () => setSp({ tab: String(s.tab_id) }) }] : []),
                      'sep',
                      { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setDel(s) },
                    ]}><Icon name="more" size={16} /></MenuButton>
                  </div>
                ))}
              </section>
            ))}
            {sessions.length < total && <div className="gt-more"><button type="button" className="btn" disabled={more} onClick={showMore}>{more ? 'Loading…' : `Show more (${total - sessions.length} older)`}</button></div>}
          </div>
        )}
      </Card>

      {modal && <PracticeModal initial={modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); announceChange() }} />}
      {del && <Confirm title="Delete this practice?" message={<>“{del.title || 'Practice'}”, {minutes(del.duration_s)} on {fmtDate(del.date)}. The song itself stays in your library.</>} confirmLabel="Delete" onConfirm={remove} onCancel={() => setDel(null)} />}
    </div>
  )
}
