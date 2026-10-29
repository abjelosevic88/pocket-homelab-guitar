// The tuner: microphone → YIN pitch → the nearest string of the chosen
// tuning (or the nearest note), a cents needle, a calm strobe and reference
// strings to tap.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Select } from '../components/Select'
import { Icon } from '../components/icons'
import { audioContext, pluck } from './audio'
import { ToolIcon } from './common'
import { detectPitch, PitchSmoother } from './pitch'
import { freqOfMidi, midiOf, midiOfFreq, nearestString, noteName, stringLabel, TUNINGS, tuningById } from './tunings'

type Phase = 'idle' | 'asking' | 'listening' | 'denied' | 'nomic' | 'unsupported' | 'error'

interface Reading { freq: number; target: number; cents: number; name: string; octave: number; string: number; fresh: boolean }

const KEY = 'pgt-tuner'
function loadPrefs(): { tuning: string; a4: number } {
  try { const p = JSON.parse(localStorage.getItem(KEY) || '{}'); return { tuning: p.tuning || 'standard', a4: Number(p.a4) >= 430 && Number(p.a4) <= 450 ? Number(p.a4) : 440 } } catch { return { tuning: 'standard', a4: 440 } }
}

const IN_TUNE = 5 // cents

export function Tuner() {
  const [prefs, setPrefs] = useState(loadPrefs)
  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(prefs)) }, [prefs])
  const tuning = tuningById(prefs.tuning)
  const [phase, setPhase] = useState<Phase>('idle')
  const [err, setErr] = useState('')
  const [reading, setReading] = useState<Reading | null>(null)
  const [tuned, setTuned] = useState<Set<number>>(new Set())
  const strobe = useRef<HTMLDivElement>(null)
  const live = useRef({ cents: 0, active: false })
  const stopRef = useRef<() => void>(() => {})

  // what the detector needs, readable from the loop without restarting it
  const cfg = useRef({ tuning, a4: prefs.a4 })
  cfg.current = { tuning, a4: prefs.a4 }
  useEffect(() => { setTuned(new Set()) }, [prefs.tuning])

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { setPhase('unsupported'); return }
    setPhase('asking')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    } catch (e) {
      const name = (e as DOMException).name
      if (name === 'NotAllowedError' || name === 'SecurityError') setPhase('denied')
      else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') setPhase('nomic')
      else { setErr((e as Error).message); setPhase('error') }
      return
    }
    const ac = audioContext()
    const src = ac.createMediaStreamSource(stream)
    // a gentle high-pass removes rumble and handling noise
    const hp = ac.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 25
    const an = ac.createAnalyser()
    an.fftSize = 8192
    src.connect(hp).connect(an)
    const buf = new Float32Array(an.fftSize)
    const smooth = new PitchSmoother(5)
    let raf = 0, lastDetect = 0, lastHeard = 0, inTuneSince = 0, inTuneString = -1
    let held: Reading | null = null
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - lastDetect < 45) return
      lastDetect = now
      an.getFloatTimeDomainData(buf)
      const { tuning: t, a4 } = cfg.current
      const minF = t.group === 'Bass' || t.id === 'chromatic' ? 27 : 50
      const p = detectPitch(buf, ac.sampleRate, minF, 1500)
      if (!p || p.clarity < 0.82) {
        if (held && now - lastHeard > 300) {
          live.current.active = false
          if (held.fresh) { held = { ...held, fresh: false }; setReading(held) }
        }
        if (held && now - lastHeard > 4000) { held = null; smooth.reset(); setReading(null) }
        inTuneSince = 0
        return
      }
      lastHeard = now
      const f = smooth.push(p.freq)
      const m = midiOfFreq(f, a4)
      const near = t.id === 'chromatic' ? null : nearestString(t, m)
      const targetMidi = near ? near.midi : Math.round(m)
      const cents = (m - targetMidi) * 100
      const prevCents = held && held.target === targetMidi ? held.cents : cents
      const sm = Math.abs(cents - prevCents) > 30 ? cents : prevCents * 0.55 + cents * 0.45
      const n = noteName(targetMidi, !!t.flats)
      held = { freq: f, target: targetMidi, cents: Math.max(-50, Math.min(50, sm)), name: n.name, octave: n.octave, string: near ? near.index : -1, fresh: true }
      live.current = { cents: held.cents, active: true }
      setReading(held)
      if (near && Math.abs(sm) <= IN_TUNE) {
        if (inTuneString !== near.index) { inTuneString = near.index; inTuneSince = now }
        else if (now - inTuneSince > 600) setTuned(s => s.has(near.index) ? s : new Set(s).add(near.index))
      } else { inTuneSince = 0; inTuneString = -1 }
    }
    raf = requestAnimationFrame(loop)
    stopRef.current = () => {
      cancelAnimationFrame(raf)
      stream.getTracks().forEach(tr => tr.stop())
      try { src.disconnect(); hp.disconnect() } catch { /* already gone */ }
      live.current.active = false
    }
    setPhase('listening')
  }
  const stop = () => { stopRef.current(); stopRef.current = () => {}; setPhase('idle'); setReading(null) }
  useEffect(() => () => stopRef.current(), [])

  // the strobe drifts left when flat, right when sharp, and stands still in tune
  useEffect(() => {
    let raf = 0, pos = 0, last = performance.now()
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const { cents, active } = live.current
      if (active && Math.abs(cents) > 1) pos += cents * dt * 4
      if (strobe.current) strobe.current.style.backgroundPositionX = `${pos.toFixed(1)}px`
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  const opts = useMemo(() => TUNINGS.map(t => ({ value: t.id, label: t.name, group: t.group })), [])
  const cents = reading ? Math.round(reading.cents) : 0
  const ok = !!reading && reading.fresh && Math.abs(cents) <= IN_TUNE
  const hint = !reading ? (phase === 'listening' ? 'Play one string and let it ring' : '')
    : !reading.fresh ? 'Play the next string'
      : ok ? 'In tune' : cents < 0 ? 'Too low — tighten the string a little' : 'Too high — loosen the string a little'
  const angle = (cents / 50) * 60 // the needle swings ±60°

  return (
    <div className="gt-tuner">
      <div className="gt-tool-bar">
        <div className="gt-tuning"><Select value={prefs.tuning} onChange={v => setPrefs(p => ({ ...p, tuning: v || 'standard' }))} options={opts} ariaLabel="Tuning" /></div>
        <div className="gt-a4" title="Concert pitch: the frequency of the A above middle C. Leave it at 440 unless you play along with a recording that is tuned differently.">
          <span className="muted small">A4</span>
          <button type="button" className="btn ghost icon-only sm" aria-label="Lower A4" disabled={prefs.a4 <= 430} onClick={() => setPrefs(p => ({ ...p, a4: p.a4 - 1 }))}><Icon name="minus" size={14} /></button>
          <span className="tnum gt-a4-v">{prefs.a4} Hz</span>
          <button type="button" className="btn ghost icon-only sm" aria-label="Raise A4" disabled={prefs.a4 >= 450} onClick={() => setPrefs(p => ({ ...p, a4: p.a4 + 1 }))}><Icon name="plus" size={14} /></button>
        </div>
      </div>

      <div className={`gt-dial ${ok ? 'ok' : ''} ${reading?.fresh ? '' : 'quiet'}`}>
        <svg viewBox="0 0 240 132" className="gt-gauge" aria-hidden="true">
          <path d={arc(-50, 50)} className="gt-arc" />
          <path d={arc(-IN_TUNE, IN_TUNE)} className="gt-zone" />
          {[-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50].map(c => {
            const a = ((c / 50) * 60 - 90) * Math.PI / 180
            const r1 = c % 50 === 0 || c === 0 ? 80 : 86
            return <line key={c} x1={120 + r1 * Math.cos(a)} y1={120 + r1 * Math.sin(a)} x2={120 + 94 * Math.cos(a)} y2={120 + 94 * Math.sin(a)} className={c === 0 ? 'gt-tick0' : 'gt-tick'} />
          })}
          <text x="30" y="80" className="gt-glabel" textAnchor="end">♭</text>
          <text x="210" y="80" className="gt-glabel">♯</text>
          <g className="gt-needle" style={{ transform: `rotate(${reading ? angle : 0}deg)` }}>
            <line x1="120" y1="120" x2="120" y2="34" />
            <circle cx="120" cy="120" r="6" />
          </g>
        </svg>
        <div className="gt-note" aria-live="polite">
          <span className="gt-note-name">{reading ? reading.name : '–'}</span>
          <span className="gt-note-oct tnum">{reading ? reading.octave : ''}</span>
        </div>
        <div className="gt-cents tnum">{reading ? (ok ? 'In tune' : `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${Math.abs(cents)} cents`) : ' '}</div>
        <div ref={strobe} className={`gt-strobe ${ok ? 'ok' : ''}`} aria-hidden="true" />
        <div className="gt-freq muted small tnum">{reading ? `${reading.freq.toFixed(1)} Hz · target ${freqOfMidi(reading.target, prefs.a4).toFixed(1)} Hz` : ' '}</div>
        <div className="gt-hint">{hint || ' '}</div>
      </div>

      {tuning.strings.length > 0 && (
        <div className="gt-strings" role="group" aria-label="Strings — tap to hear the note">
          {tuning.strings.map((s, i) => {
            const l = stringLabel(s)
            const active = reading?.fresh && reading.string === i
            return (
              <button key={i} type="button" className={`gt-string ${active ? 'active' : ''} ${tuned.has(i) ? 'done' : ''}`} title={`Play ${s}`}
                onClick={() => pluck(freqOfMidi(midiOf(s), prefs.a4))}>
                <span className="gt-string-n">{l.name}<small>{l.octave}</small></span>
                <span className="gt-string-mark">{tuned.has(i) ? <Icon name="check" size={13} strokeWidth={2.4} /> : <Icon name="volume" size={13} />}</span>
              </button>
            )
          })}
        </div>
      )}
      {tuning.strings.length > 0 && <p className="muted small gt-center">Tap a string to hear how it should sound.</p>}

      <div className="gt-mic">
        {phase === 'listening'
          ? <button type="button" className="btn lg" onClick={stop}><ToolIcon name="mic-off" size={17} />Stop listening</button>
          : <button type="button" className="btn primary lg" onClick={start} disabled={phase === 'asking'}><ToolIcon name="mic" size={17} />{phase === 'asking' ? 'Waiting for the microphone…' : 'Start the tuner'}</button>}
      </div>
      {phase === 'denied' && <div className="callout warn"><Icon name="alert" size={15} /><div>The browser is not allowed to use the microphone. Allow it for this site (tap the lock or the site settings next to the address), then press <b>Start the tuner</b> again.</div></div>}
      {phase === 'nomic' && <div className="callout warn"><Icon name="alert" size={15} /><div>No microphone was found. Plug one in, or use a phone or laptop with a built-in microphone.</div></div>}
      {phase === 'unsupported' && <div className="callout warn"><Icon name="alert" size={15} /><div>This browser cannot use the microphone here. The tuner needs a secure (https) address and a current browser.</div></div>}
      {phase === 'error' && <div className="callout danger"><Icon name="alert" size={15} /><div>The microphone did not start: {err}</div></div>}
    </div>
  )
}

/** An arc of the gauge between two cent values. */
function arc(c1: number, c2: number) {
  const p = (c: number) => { const a = ((c / 50) * 60 - 90) * Math.PI / 180; return [120 + 96 * Math.cos(a), 120 + 96 * Math.sin(a)] }
  const [x1, y1] = p(c1), [x2, y2] = p(c2)
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A 96 96 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}
