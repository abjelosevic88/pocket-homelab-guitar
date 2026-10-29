// The live fretboard: the notes of the beat being played (or the one you
// clicked while paused) on a neck drawn from the track's own tuning. The top
// line is the highest string, like the tab above it.
import { memo, useEffect, useRef, useState } from 'react'
import type { AT } from './alphatab'
import { type TabEngine, useActiveBeats } from './engine'
import { lowToHigh, noteName } from './music'

const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21]

export function Fretboard({ engine, score, track, leftHanded }: { engine: TabEngine; score: AT.model.Score | null; track: number; leftHanded: boolean }) {
  const beats = useActiveBeats(engine)
  const tr = score?.tracks[track]
  const staff = tr?.staves[0]
  if (!staff || staff.isPercussion || !staff.isStringed || !staff.tuning.length) {
    return <div className="fretboard empty muted small">The fretboard shows a guitar or bass track. Pick one in Tracks.</div>
  }
  const notes: { string: number; fret: number }[] = []
  let chord = ''
  for (const b of beats) {
    if (b.voice.bar.staff.track.index !== track) continue
    if (b.hasChord && b.chord?.name) chord = b.chord.name
    for (const n of b.notes) if (n.isStringed && !n.isDead && n.fret >= 0) notes.push({ string: n.string, fret: n.fret })
  }
  const capo = staff.capo || 0
  return <Neck tuning={lowToHigh(staff)} notes={notes} chord={chord} capo={capo} leftHanded={leftHanded} />
}

const Neck = memo(function Neck({ tuning, notes, chord, capo, leftHanded }: { tuning: number[]; notes: { string: number; fret: number }[]; chord: string; capo: number; leftHanded: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(1000)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const strings = tuning.length
  const maxNote = notes.reduce((m, n) => Math.max(m, n.fret), 0)
  const frets = maxNote > 15 || W > 1100 ? 24 : W < 520 ? 12 : 15
  // fret widths shrink up the neck (a gentle version of the real 12th-root spacing)
  const nutX = 34, H = 24 + strings * 16
  const widths: number[] = []
  for (let f = 1; f <= frets; f++) widths.push(Math.pow(0.955, f))
  const scale = (W - nutX - 8) / widths.reduce((a, b) => a + b, 0)
  const fx: number[] = [nutX]
  for (const w of widths) fx.push(fx[fx.length - 1] + w * scale)
  const X = (x: number) => (leftHanded ? W - x : x)
  const top = 12, gap = 16
  const sy = (s: number) => top + (strings - s) * gap // s: 1 = lowest string, drawn at the bottom
  const noteX = (f: number) => (f === 0 ? nutX - 14 : (fx[f - 1] + fx[f]) / 2)
  const midY = top + ((strings - 1) * gap) / 2
  return (
    <div className="fretboard" aria-label="Fretboard">
      <div ref={box} className="fb-inner">
      {chord && <span className="fb-chord">{chord}</span>}
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={notes.length ? `Playing ${notes.map(n => `string ${n.string} fret ${n.fret}`).join(', ')}` : 'Nothing playing'}>
        <rect className="fb-wood" x={X(leftHanded ? W - 4 : nutX)} y={top - 6} width={W - nutX - 4} height={(strings - 1) * gap + 12} rx={3} />
        {INLAYS.filter(f => f <= frets).map(f => <circle key={f} className="fb-inlay" cx={X((fx[f - 1] + fx[f]) / 2)} cy={midY} r={4} />)}
        {[12, 24].filter(f => f <= frets).map(f => <g key={f}><circle className="fb-inlay" cx={X((fx[f - 1] + fx[f]) / 2)} cy={midY - gap} r={4} /><circle className="fb-inlay" cx={X((fx[f - 1] + fx[f]) / 2)} cy={midY + gap} r={4} /></g>)}
        {fx.map((x, f) => <line key={f} className={f === 0 ? 'fb-nut' : 'fb-fret'} x1={X(x)} x2={X(x)} y1={top - 6} y2={top + (strings - 1) * gap + 6} />)}
        {capo > 0 && capo <= frets && <rect className="fb-capo" x={X(fx[capo - 1]) - 3} y={top - 8} width={6} height={(strings - 1) * gap + 16} rx={3} />}
        {tuning.map((_, i) => { const s = i + 1; return <line key={s} className="fb-string" x1={X(nutX)} x2={X(W - 4)} y1={sy(s)} y2={sy(s)} style={{ strokeWidth: 0.8 + (s / strings) * 1.4 }} /> })}
        {tuning.map((m, i) => <text key={'t' + i} className="fb-tune" x={X(10)} y={sy(i + 1) + 4} textAnchor="middle">{noteName(m)}</text>)}
        {notes.map((n, i) => n.string >= 1 && n.string <= strings && n.fret <= frets && (
          <g key={i}>
            <circle className={`fb-note ${n.fret === 0 ? 'open' : ''}`} cx={X(noteX(n.fret))} cy={sy(n.string)} r={8} />
            <text className="fb-note-t" x={X(noteX(n.fret))} y={sy(n.string) + 3.5} textAnchor="middle">{n.fret}</text>
          </g>
        ))}
        {[3, 5, 7, 9, 12, 15, 17, 19, 21, 24].filter(f => f <= frets).map(f => <text key={'n' + f} className="fb-num" x={X((fx[f - 1] + fx[f]) / 2)} y={H - 2} textAnchor="middle">{f}</text>)}
      </svg>
      </div>
    </div>
  )
})
