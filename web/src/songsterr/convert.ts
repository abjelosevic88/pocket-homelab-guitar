// Songsterr's per-track JSON → an alphaTab score → a Guitar Pro 7 file.
//
// Ported from songsterr-downloader by Ryan Roberts (MIT License,
// https://github.com/Metaphysics0/songsterr-downloader, commit 1bbd50e),
// src/lib/server/services/converter/. Changes here:
// - rests and padding are real rests (a beat without notes), not "empty"
//   beats: alphaTab leaves empty beats out of the Guitar Pro file, which
//   gave bars different numbers of voices and broke loading (Iron Maiden);
// - every bar of a track gets the same number of voices, each filled to
//   the bar's length;
// - the drum-sound lookup is built before the song (built lazily it
//   restarted alphaTab's id counters mid-song and the saved file shared ids
//   between voices — the real cause of the Iron Maiden crash);
// - alphaTab is passed in (it is loaded at runtime from /alphatab/);
// - no MIDI export, no warnings list.
import type { AT } from '../player/alphatab'

type AlphaTab = typeof AT

export interface SongsterrTrackMeta { partId: number; instrumentId: number; title?: string; name?: string; tuning?: number[]; isDrums?: boolean }
export interface SongsterrSongMeta { song_id: number; revision_id: number; image: string; title: string; artist: string; url: string; tracks: SongsterrTrackMeta[] }

interface TempoPoint { measure: number; position: number; bpm: number; type: number }
interface BendPoint { position: number; tone: number }
interface NoteData {
  fret?: number; string?: number; tie?: boolean; slide?: string; rest?: boolean; dead?: boolean; ghost?: boolean; hp?: boolean
  staccato?: boolean; accentuated?: boolean; vibrato?: boolean; wideVibrato?: boolean; harmonic?: string; harmonicFret?: number
  bend?: { tone: number; points: BendPoint[] }
}
interface BeatData {
  notes?: NoteData[]; type?: number; duration?: [number, number]; dots?: number; text?: string | { text: string }; velocity?: string
  rest?: boolean; palmMute?: boolean; vibrato?: boolean; wideVibrato?: boolean; vibratoWithTremoloBar?: string; pickStroke?: string; tuplet?: number
}
interface VoiceData { beats?: BeatData[]; rest?: boolean }
interface MeasureData {
  voices?: VoiceData[]; signature?: [number, number]; marker?: string | { text: string }
  repeatStart?: boolean; repeatCount?: number; alternateEnding?: number; rest?: boolean
}
export interface SongsterrPart { name?: string; instrumentId?: number; tuning?: number[]; measures: MeasureData[]; automations?: { tempo?: TempoPoint[] } }
export interface SongsterrRevision { trackMeta: SongsterrTrackMeta; revision: SongsterrPart }

const TUPLETS: Record<number, [number, number]> = { 3: [3, 2], 5: [5, 4], 6: [6, 4], 7: [7, 4], 9: [9, 8], 10: [10, 8], 12: [12, 8] }
function tupletRatio(t: number): [number, number] {
  if (TUPLETS[t]) return TUPLETS[t]
  return t > 1 ? [t, Math.pow(2, Math.floor(Math.log2(t)))] : [1, 1]
}

export class SongsterrConverter {
  private at: AlphaTab
  private percussion: Map<number, number> | null = null

  constructor(at: AlphaTab) { this.at = at }

  /** Builds the Guitar Pro 7 file for a song. */
  toGp7(meta: SongsterrSongMeta, revisions: SongsterrRevision[]): Uint8Array {
    // The drum-sound lookup builds and re-reads a tiny score, which restarts alphaTab's id counters.
    // Built lazily in the middle of a song (as upstream did) it gave later voices and bars the ids
    // of earlier ones, and the saved file then mixed them up on loading. So: before the song.
    this.percussionIndex(0)
    const { score, settings } = this.buildScore(meta, revisions)
    return new this.at.exporter.Gp7Exporter().export(score, settings)
  }

  private duration(d: [number, number] | undefined): { duration: AT.model.Duration; dots: number } {
    const D = this.at.model.Duration
    const bases = [D.Whole, D.Half, D.Quarter, D.Eighth, D.Sixteenth, D.ThirtySecond, D.SixtyFourth]
    if (!d || !d[0] || !d[1]) return { duration: D.Quarter, dots: 0 }
    const target = d[0] / d[1]
    let best = { duration: D.Quarter, dots: 0 }, delta = Infinity
    for (const c of bases) {
      const base = 1 / Number(c)
      for (const dots of [0, 1, 2]) {
        const v = base + (dots >= 1 ? base / 2 : 0) + (dots >= 2 ? base / 4 : 0)
        if (Math.abs(v - target) < delta) { delta = Math.abs(v - target); best = { duration: c, dots } }
      }
    }
    return best
  }

  private buildScore(meta: SongsterrSongMeta, revisions: SongsterrRevision[]) {
    const at = this.at
    const score = new at.model.Score()
    score.title = meta.title
    score.artist = meta.artist
    score.tab = 'Songsterr'
    const master = revisions.reduce<SongsterrPart | null>((l, c) => (!l || (c.revision.measures?.length || 0) > (l.measures?.length || 0) ? c.revision : l), null)
    const bars = Math.max(1, ...revisions.map(r => r.revision.measures?.length || 0))
    this.buildMasterBars(score, master, bars)
    let next = 0
    for (const entry of revisions) {
      const inst = entry.trackMeta.instrumentId ?? entry.revision.instrumentId
      const drums = inst === 1024 || !!entry.trackMeta.isDrums
      let channel = 9
      if (!drums) { if (next === 9) next++; channel = next++ }
      this.buildTrack(score, entry, bars, channel, drums)
    }
    const settings = new at.Settings()
    score.finish(settings)
    return { score, settings }
  }

  private buildMasterBars(score: AT.model.Score, master: SongsterrPart | null, count: number) {
    const at = this.at
    let num = 4, den = 4
    for (let i = 0; i < count; i++) {
      const m = master?.measures?.[i]
      if (Array.isArray(m?.signature) && m!.signature[0] && m!.signature[1]) [num, den] = m!.signature
      const mb = new at.model.MasterBar()
      mb.timeSignatureNumerator = num
      mb.timeSignatureDenominator = den
      if (m?.marker) {
        const text = typeof m.marker === 'string' ? m.marker : m.marker.text || ''
        if (text) { const sec = new at.model.Section(); sec.text = text; sec.marker = ''; mb.section = sec }
      }
      if (m?.repeatStart) mb.isRepeatStart = true
      if (typeof m?.repeatCount === 'number' && m.repeatCount > 0) mb.repeatCount = m.repeatCount
      if (typeof m?.alternateEnding === 'number' && m.alternateEnding > 0) mb.alternateEndings = m.alternateEnding
      score.addMasterBar(mb)
    }
    for (const p of master?.automations?.tempo || []) {
      const mb = score.masterBars[p.measure]
      if (!mb) continue
      const ratio = p.position > 0 ? Math.max(0, Math.min(1, p.position / (p.type || 4))) : 0
      mb.tempoAutomations.push(at.model.Automation.buildTempoAutomation(false, ratio, p.bpm, 2, true))
    }
  }

  private buildTrack(score: AT.model.Score, entry: SongsterrRevision, bars: number, channel: number, drums: boolean) {
    const at = this.at
    const { trackMeta, revision } = entry
    const inst = trackMeta.instrumentId ?? revision.instrumentId
    const track = new at.model.Track()
    track.name = trackMeta.title || trackMeta.name || revision.name || 'Track'
    track.shortName = track.name.slice(0, 20)
    track.playbackInfo.program = drums ? 0 : typeof inst === 'number' ? Math.min(Math.max(inst, 0), 127) : 24
    track.playbackInfo.primaryChannel = channel
    track.playbackInfo.secondaryChannel = channel
    const staff = new at.model.Staff()
    const tuning = revision.tuning || trackMeta.tuning
    if (Array.isArray(tuning) && tuning.length) staff.stringTuning = new at.model.Tuning('Custom', tuning, false)
    staff.isPercussion = drums
    const strings = Array.isArray(tuning) && tuning.length ? tuning.length : 6
    // every bar of the track gets the same number of voices (alphaTab expects it)
    let voices = 1
    for (let i = 0; i < bars; i++) voices = Math.max(voices, revision.measures?.[i]?.voices?.length || 0)
    for (let i = 0; i < bars; i++) {
      const bar = new at.model.Bar()
      const m = revision.measures?.[i]
      const mb = score.masterBars[i]
      for (let v = 0; v < voices; v++) {
        const voice = new at.model.Voice()
        const src = m?.voices?.[v]
        const beats = src && !src.rest ? src.beats || [] : []
        for (const bd of beats) voice.addBeat(this.beat(bd, drums, strings))
        if (!voice.beats.length) this.fillWithRests(voice, mb)
        bar.addVoice(voice)
      }
      staff.addBar(bar)
    }
    track.addStaff(staff)
    score.addTrack(track)
  }

  /** A bar's worth of rests: real rests (no notes), so the voice is written to the file. */
  private fillWithRests(voice: AT.model.Voice, mb: AT.model.MasterBar) {
    const { duration, dots } = this.duration([1, mb.timeSignatureDenominator || 4])
    for (let i = 0; i < (mb.timeSignatureNumerator || 4); i++) {
      const b = new this.at.model.Beat()
      b.duration = duration
      b.dots = dots
      voice.addBeat(b)
    }
  }

  private beat(bd: BeatData, drums: boolean, strings: number): AT.model.Beat {
    const at = this.at
    const beat = new at.model.Beat() // a beat without notes is a rest
    const d = this.duration(bd.duration)
    beat.duration = d.duration
    beat.dots = bd.dots ?? d.dots
    const text = typeof bd.text === 'string' ? bd.text : bd.text?.text
    beat.text = text || null
    if (typeof bd.tuplet === 'number' && bd.tuplet > 1) {
      const [n, dd] = tupletRatio(bd.tuplet)
      beat.tupletNumerator = n
      beat.tupletDenominator = dd
      if (typeof bd.type === 'number' && bd.type > 0) { beat.duration = this.duration([1, bd.type]).duration; beat.dots = bd.dots ?? 0 }
    }
    const dyn: Record<string, AT.model.DynamicValue> = { ppp: at.model.DynamicValue.PPP, pp: at.model.DynamicValue.PP, p: at.model.DynamicValue.P, mp: at.model.DynamicValue.MP, mf: at.model.DynamicValue.MF, f: at.model.DynamicValue.F, ff: at.model.DynamicValue.FF, fff: at.model.DynamicValue.FFF }
    if (typeof bd.velocity === 'string' && dyn[bd.velocity.toLowerCase()] !== undefined) beat.dynamics = dyn[bd.velocity.toLowerCase()]
    if (bd.pickStroke === 'down') beat.pickStroke = at.model.PickStroke.Down
    else if (bd.pickStroke === 'up') beat.pickStroke = at.model.PickStroke.Up
    if (bd.wideVibrato || bd.vibratoWithTremoloBar) beat.vibrato = at.model.VibratoType.Wide
    else if (bd.vibrato) beat.vibrato = at.model.VibratoType.Slight
    if (!bd.rest) for (const nd of bd.notes || []) if (!nd.rest) beat.addNote(this.note(nd, bd, drums, strings))
    return beat
  }

  private note(nd: NoteData, bd: BeatData, drums: boolean, strings: number): AT.model.Note {
    const at = this.at
    const note = new at.model.Note()
    // Songsterr: string 0 = the highest; alphaTab: string 1 = the lowest
    note.string = drums ? -1 : strings - (nd.string ?? 0)
    note.fret = nd.fret ?? 0
    if (drums) note.percussionArticulation = this.percussionIndex(nd.fret ?? 0)
    if (nd.tie) note.isTieDestination = true
    if (nd.dead) note.isDead = true
    if (nd.ghost) note.isGhost = true
    if (nd.hp) note.isHammerPullOrigin = true
    if (nd.staccato) note.isStaccato = true
    if (nd.accentuated) note.accentuated = at.model.AccentuationType.Normal
    if (bd.palmMute) note.isPalmMute = true
    if (nd.wideVibrato) note.vibrato = at.model.VibratoType.Wide
    else if (nd.vibrato) note.vibrato = at.model.VibratoType.Slight
    if (typeof nd.slide === 'string') {
      const s = nd.slide.toLowerCase()
      if (s === 'shift') note.slideOutType = at.model.SlideOutType.Shift
      else if (s === 'legato') note.slideOutType = at.model.SlideOutType.Legato
      else if (s === 'into_from_below' || s === 'below') note.slideInType = at.model.SlideInType.IntoFromBelow
      else if (s === 'into_from_above') note.slideInType = at.model.SlideInType.IntoFromAbove
      else if (s === 'out_up') note.slideOutType = at.model.SlideOutType.OutUp
      else if (s === 'out_down' || s === 'downwards') note.slideOutType = at.model.SlideOutType.OutDown
    }
    if (typeof nd.harmonic === 'string') {
      const h: Record<string, AT.model.HarmonicType> = { natural: at.model.HarmonicType.Natural, artificial: at.model.HarmonicType.Artificial, pinch: at.model.HarmonicType.Pinch, tap: at.model.HarmonicType.Tap, semi: at.model.HarmonicType.Semi, feedback: at.model.HarmonicType.Feedback }
      const t = h[nd.harmonic.toLowerCase()]
      if (t !== undefined) { note.harmonicType = t; if (typeof nd.harmonicFret === 'number') note.harmonicValue = nd.harmonicFret }
    }
    if (nd.bend?.points?.length) this.bend(note, nd.bend.points)
    return note
  }

  private bend(note: AT.model.Note, points: BendPoint[]) {
    const at = this.at
    const val = (tone: number) => Math.round(tone / 25)
    const first = points[0].tone
    if (first > 0) {
      const last = points[points.length - 1]
      const max = Math.max(...points.map(p => p.tone))
      if (max > first) { note.bendType = at.model.BendType.PrebendBend; note.addBendPoint(new at.model.BendPoint(0, val(first))); note.addBendPoint(new at.model.BendPoint(60, val(max))) }
      else if (last.tone < first) { note.bendType = at.model.BendType.PrebendRelease; note.addBendPoint(new at.model.BendPoint(0, val(first))); note.addBendPoint(new at.model.BendPoint(60, val(last.tone))) }
      else { note.bendType = at.model.BendType.Prebend; note.addBendPoint(new at.model.BendPoint(0, val(first))); note.addBendPoint(new at.model.BendPoint(60, val(last.tone))) }
      return
    }
    note.bendType = at.model.BendType.Custom
    let use = points
    if (points.length > 4) {
      let max = 0, peak = 0
      points.forEach((p, i) => { if (p.tone >= max) { max = p.tone; peak = i } })
      use = peak === 0 || peak === points.length - 1 ? [points[0], points[points.length - 1]] : [points[0], points[peak], points[points.length - 1]]
    }
    for (const p of use) note.addBendPoint(new at.model.BendPoint(Math.round(p.position), val(p.tone)))
  }

  /** GP7 names drum sounds by their index in alphaTab's default list, not by MIDI note. */
  private percussionIndex(midi: number): number {
    if (!this.percussion) {
      const at = this.at
      const score = new at.model.Score()
      score.addMasterBar(new at.model.MasterBar())
      const track = new at.model.Track()
      track.playbackInfo.primaryChannel = 9
      track.playbackInfo.secondaryChannel = 9
      const staff = new at.model.Staff()
      staff.isPercussion = true
      track.addStaff(staff)
      const bar = new at.model.Bar()
      const voice = new at.model.Voice()
      const beat = new at.model.Beat()
      beat.isEmpty = true
      voice.addBeat(beat)
      bar.addVoice(voice)
      staff.addBar(bar)
      score.addTrack(track)
      const settings = new at.Settings()
      score.finish(settings)
      const back = at.importer.ScoreLoader.loadScoreFromBytes(new at.exporter.Gp7Exporter().export(score, settings), settings)
      this.percussion = new Map()
      back.tracks[0].percussionArticulations.forEach((a, i) => { if (!this.percussion!.has(a.id)) this.percussion!.set(a.id, i) })
    }
    return this.percussion.get(midi) ?? midi
  }
}
