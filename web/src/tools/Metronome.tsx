// The metronome page: tempo, meter, accents, subdivisions, sounds, a speed
// trainer, and the time played along saved as practice.
import { useEffect, useRef, useState } from 'react'
import { Field, Segmented, Switch, useToast, errMsg } from '../components/ui'
import { Icon } from '../components/icons'
import { announceChange } from '../components/Layout'
import { clampBpm, METERS, meterById, metronome, type MetronomeConfig, type MetronomeState, type Subdivision } from './metronome'
import { minutes, saveFreePractice } from './common'

export function useMetronome(): [MetronomeState, MetronomeConfig] {
  const [st, setSt] = useState<MetronomeState>(() => metronome.state())
  const [cfg, setCfg] = useState<MetronomeConfig>(metronome.cfg)
  useEffect(() => metronome.subscribe(s => { setSt(s); setCfg(metronome.cfg) }), [])
  return [st, cfg]
}

const TEMPO_NAMES: [number, string][] = [[40, 'Grave'], [60, 'Largo'], [66, 'Larghetto'], [76, 'Adagio'], [108, 'Andante'], [120, 'Moderato'], [156, 'Allegro'], [176, 'Vivace'], [200, 'Presto'], [999, 'Prestissimo']]
const tempoName = (bpm: number) => TEMPO_NAMES.find(([max]) => bpm < max)?.[1] || ''

export function Metronome() {
  const [st, cfg] = useMetronome()
  const { toast } = useToast()
  const [typed, setTyped] = useState<string | null>(null)
  const taps = useRef<number[]>([])
  const [saving, setSaving] = useState(false)
  const meter = meterById(cfg.meter)
  const set = (p: Partial<MetronomeConfig>) => metronome.set(p)

  const tap = () => {
    const now = performance.now()
    const t = taps.current.filter(x => now - x < 2500)
    t.push(now)
    taps.current = t.slice(-6)
    if (taps.current.length >= 2) {
      const iv = taps.current.slice(1).map((x, i) => x - taps.current[i])
      const avg = iv.reduce((a, b) => a + b, 0) / iv.length
      set({ bpm: clampBpm(60000 / avg) })
    }
  }

  // Space starts and stops; the arrow keys nudge the tempo (Shift: by 10)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest('input, textarea, [contenteditable="true"], .modal, .menu, .sel-pop')) return
      if (e.key === ' ') { e.preventDefault(); metronome.toggle() }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); set({ bpm: metronome.cfg.bpm + (e.shiftKey ? 10 : 1) }) }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); set({ bpm: metronome.cfg.bpm - (e.shiftKey ? 10 : 1) }) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (st.playedS < 60) return
    setSaving(true)
    try {
      await saveFreePractice(`Metronome — ${cfg.bpm} BPM`, st.firstStart || new Date(Date.now() - st.playedS * 1000).toISOString(), st.playedS,
        cfg.trainer ? `Speed trainer ${cfg.trainerStart}→${cfg.trainerTarget} BPM` : '')
      metronome.resetPlayed()
      announceChange()
      toast('Saved to your practice log')
    } catch (e) { toast(errMsg(e), 'err') } finally { setSaving(false) }
  }

  const commitTyped = () => { if (typed !== null) { const v = Number(typed); if (v) set({ bpm: v }); setTyped(null) } }

  return (
    <div className="gt-metro">
      <div className="gt-bpm-block">
        <div className="gt-beats" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${meter.beats}, 1fr)` }}>
          {Array.from({ length: meter.beats }, (_, i) => (
            <span key={i} className={`gt-beat ${i === 0 && cfg.accent ? 'accent' : cfg.accent && meter.groups.includes(i) ? 'group' : ''} ${st.running && st.beat === i ? 'on' : ''}`} />
          ))}
        </div>
        <div className="gt-bpm-row">
          <button type="button" className="btn icon-only lg gt-round" aria-label="Slower" onClick={() => set({ bpm: cfg.bpm - 1 })}><Icon name="minus" size={20} /></button>
          <div className="gt-bpm">
            <input className="gt-bpm-in tnum" inputMode="numeric" aria-label="Beats per minute" value={typed ?? String(cfg.bpm)}
              onChange={e => setTyped(e.target.value.replace(/\D/g, '').slice(0, 3))} onBlur={commitTyped} onKeyDown={e => { if (e.key === 'Enter') { commitTyped(); (e.target as HTMLInputElement).blur() } }} />
            <span className="gt-bpm-u">BPM · {tempoName(cfg.bpm)}</span>
          </div>
          <button type="button" className="btn icon-only lg gt-round" aria-label="Faster" onClick={() => set({ bpm: cfg.bpm + 1 })}><Icon name="plus" size={20} /></button>
        </div>
        <input type="range" className="gt-range" min={20} max={300} value={cfg.bpm} onChange={e => set({ bpm: Number(e.target.value) })} aria-label="Tempo" />
        <div className="gt-go-row">
          <button type="button" className="btn lg gt-tap" onClick={tap} title="Tap the beat a few times">Tap</button>
          <button type="button" className={`btn lg gt-go ${st.running ? '' : 'primary'}`} onClick={() => metronome.toggle()} title="Start or stop (Space)">
            <Icon name={st.running ? 'stop' : 'play'} size={18} strokeWidth={2.2} />{st.running ? 'Stop' : 'Start'}
          </button>
        </div>
        <div className="gt-trainer-line muted small tnum">
          {cfg.trainer && st.running && st.barsToStep > 0 ? `Speeding up by ${cfg.trainerStep} BPM in ${st.barsToStep} ${st.barsToStep === 1 ? 'bar' : 'bars'}`
            : cfg.trainer && st.running ? `Target reached: ${cfg.trainerTarget} BPM` : ' '}
        </div>
      </div>

      <div className="gt-metro-opts">
        <Field label="Time signature" group>
          <Segmented size="sm" className="gt-wrap-seg" value={cfg.meter} onChange={v => set({ meter: v })} options={METERS.map(m => ({ value: m.id, label: m.label }))} label="Time signature" />
        </Field>
        <Field label="Clicks per beat" group>
          <Segmented<Subdivision> size="sm" value={cfg.sub} onChange={v => set({ sub: v })} label="Subdivision"
            options={[{ value: 1, label: 'Beats only', title: 'One click per beat' }, { value: 2, label: 'Eighths', title: 'Two clicks per beat' }, { value: 3, label: 'Triplets', title: 'Three clicks per beat' }, { value: 4, label: 'Sixteenths', title: 'Four clicks per beat' }]} />
        </Field>
        <Field label="Sound" group>
          <Segmented size="sm" value={cfg.sound} onChange={v => set({ sound: v })} label="Sound" options={[{ value: 'click', label: 'Click' }, { value: 'wood', label: 'Wood block' }, { value: 'beep', label: 'Beep' }]} />
        </Field>
        <div className="gt-opt-row">
          <label className="gt-check"><Switch size="sm" checked={cfg.accent} onChange={v => set({ accent: v })} label="Accent the first beat" /><span>Accent the first beat</span></label>
          <label className="gt-vol"><Icon name="volume" size={15} className="muted" /><input type="range" min={0} max={1} step={0.05} value={cfg.volume} onChange={e => set({ volume: Number(e.target.value) })} aria-label="Volume" /></label>
        </div>

        <div className="gt-trainer">
          <label className="gt-check"><Switch size="sm" checked={cfg.trainer} onChange={v => set({ trainer: v })} label="Speed trainer" /><span><b>Speed trainer</b> <span className="muted">— start slow, speed up by itself</span></span></label>
          <div className={`gt-trainer-grid ${cfg.trainer ? '' : 'off'}`}>
            <NumField label="Start at" unit="BPM" value={cfg.trainerStart} min={20} max={300} disabled={!cfg.trainer} onChange={v => set({ trainerStart: v })} />
            <NumField label="Add" unit="BPM" value={cfg.trainerStep} min={1} max={50} disabled={!cfg.trainer} onChange={v => set({ trainerStep: v })} />
            <NumField label="Every" unit="bars" value={cfg.trainerEvery} min={1} max={64} disabled={!cfg.trainer} onChange={v => set({ trainerEvery: v })} />
            <NumField label="Stop at" unit="BPM" value={cfg.trainerTarget} min={20} max={300} disabled={!cfg.trainer} onChange={v => set({ trainerTarget: v })} />
          </div>
        </div>
      </div>

      <div className="gt-played">
        <span className="muted small tnum">{st.playedS >= 1 ? `${minutes(st.playedS)} with the metronome on this visit` : 'Time with the metronome is counted here.'}</span>
        <button type="button" className="btn sm" disabled={st.playedS < 60 || saving} onClick={save} title={st.playedS < 60 ? 'Play at least a minute first' : undefined}>
          <Icon name="check" size={14} />Save as practice
        </button>
      </div>
    </div>
  )
}

function NumField({ label, unit, value, min, max, onChange, disabled }: { label: string; unit: string; value: number; min: number; max: number; onChange: (v: number) => void; disabled?: boolean }) {
  const [txt, setTxt] = useState<string | null>(null)
  const commit = () => { if (txt !== null) { const v = Math.max(min, Math.min(max, Math.round(Number(txt) || value))); onChange(v); setTxt(null) } }
  return (
    <label className="gt-num">
      <span className="label">{label}</span>
      <span className="gt-num-in"><input inputMode="numeric" disabled={disabled} value={txt ?? String(value)} onChange={e => setTxt(e.target.value.replace(/\D/g, '').slice(0, 3))} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit() }} /><span className="muted small">{unit}</span></span>
    </label>
  )
}
