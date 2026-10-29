// Tools: the tuner, the metronome and a practice timer for practice without a tab.
import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader, Segmented } from '../components/ui'
import { Icon } from '../components/icons'
import { Tuner } from '../tools/Tuner'
import { Metronome, useMetronome } from '../tools/Metronome'
import { PracticeTimer } from '../tools/PracticeTimer'
import { metronome } from '../tools/metronome'
import { ToolIcon } from '../tools/common'

type Tool = 'tuner' | 'metronome' | 'timer'
const SUB: Record<Tool, string> = {
  tuner: 'Play one string at a time; the needle shows whether it is too low or too high.',
  metronome: 'Keep time. The speed trainer starts slow and speeds up by itself.',
  timer: 'Practice without a song — scales, chords, improvising — and save the time to your log.',
}

export default function Tools() {
  const { tool: raw } = useParams()
  const navigate = useNavigate()
  const tool: Tool = raw === 'metronome' || raw === 'timer' ? raw : 'tuner'
  const [m, cfg] = useMetronome()
  // leaving the tools page stops the metronome (the time it counted stays until saved)
  useEffect(() => () => metronome.stop(), [])

  return (
    <div className="gt-tools">
      <PageHeader title="Tools" sub={SUB[tool]} />
      <div className="gt-tools-switch">
        <Segmented<Tool> value={tool} onChange={v => navigate(`/tools/${v}`, { replace: true })} label="Tool" options={[
          { value: 'tuner', label: <span className="inline-ico"><ToolIcon name="tuner" size={15} />Tuner</span> },
          { value: 'metronome', label: <span className="inline-ico"><ToolIcon name="metronome" size={15} />Metronome</span> },
          { value: 'timer', label: <span className="inline-ico"><Icon name="timer" size={15} />Timer</span> },
        ]} />
        <span className={`gt-metro-pill ${m.running && tool !== 'metronome' ? '' : 'hidden'}`}>
          <span className={`gt-pulse ${m.beat === 0 ? 'on' : ''}`} />
          <span className="tnum">{cfg.bpm} BPM</span>
          <button type="button" className="btn ghost xs" aria-label="Stop the metronome" onClick={() => metronome.stop()}><Icon name="stop" size={13} /></button>
        </span>
      </div>
      <section className="card gt-tool-card">
        {tool === 'tuner' && <Tuner />}
        {tool === 'metronome' && <Metronome />}
        {tool === 'timer' && <PracticeTimer />}
      </section>
    </div>
  )
}
