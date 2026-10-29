// TabEngine wraps one alphaTab API instance: loading, rendering choices,
// playback, loops and the events the page needs. React reads it through
// small stores (useEngine*), so the 60 Hz position updates only re-render the
// readouts that show them.
import { useSyncExternalStore } from 'react'
import { loadAlphaTab, type AlphaTab, type AT } from './alphatab'
import { tidyScore, type FileNote } from './tidy'
import type { Notation, ScoreLayout } from '../lib/types'

export interface ViewOptions {
  tracks: number[]          // track indexes shown
  notation: Notation
  layout: ScoreLayout
  zoom: number              // percent
  transpose: number         // semitones, display only
  autoScroll: boolean
  colors: ScoreColors | null // null = alphaTab's own (paper)
}
export interface ScoreColors { main: string; secondary: string; staff: string; bar: string; barNumber: string; info: string }

export interface EngineState {
  phase: 'idle' | 'loading' | 'rendering' | 'ready' | 'error'
  error: string
  score: AT.model.Score | null
  fileNotes: FileNote[]      // long text notes taken out of the tab (see tidy.ts)
  playerReady: boolean
  soundLoad: number          // 0..1 while the soundfont downloads
  playing: boolean
  looping: boolean
  range: { start: number; end: number } | null // selected bars (0-based, inclusive)
  speed: number              // 0.25..2
  metronome: boolean
  countIn: boolean
  volume: number             // master 0..1
  muted: number[]; solo: number[]; trackVolume: Record<number, number>
  renderedTracks: number[]
}
export interface Position { time: number; end: number; tick: number; endTick: number; bar: number; bars: number }

type Listener = () => void

class Store<T> {
  private v: T
  private ls = new Set<Listener>()
  constructor(v: T) { this.v = v }
  get = () => this.v
  set(patch: Partial<T> | T, replace = false) {
    this.v = replace ? (patch as T) : { ...this.v, ...patch }
    this.ls.forEach(l => l())
  }
  subscribe = (l: Listener) => { this.ls.add(l); return () => { this.ls.delete(l) } }
}

export interface EngineEvents {
  loopPass: (speed: number, range: { start: number; end: number }) => void
  finished: (speed: number) => void
  scoreLoaded: (score: AT.model.Score) => void
  midiLoaded: (endTimeMs: number) => void
  seek: (timeMs: number) => void
  play: () => void
  pause: () => void
  beatClicked: (beat: AT.model.Beat) => void
}

const initial: EngineState = {
  phase: 'idle', error: '', score: null, fileNotes: [], playerReady: false, soundLoad: 0, playing: false, looping: false, range: null,
  speed: 1, metronome: false, countIn: false, volume: 1, muted: [], solo: [], trackVolume: {}, renderedTracks: [],
}

export class TabEngine {
  at: AlphaTab | null = null
  api: AT.AlphaTabApi | null = null
  state = new Store<EngineState>(initial)
  position = new Store<Position>({ time: 0, end: 0, tick: 0, endTick: 0, bar: 0, bars: 0 })
  beats = new Store<AT.model.Beat[]>([])
  private handlers: { [K in keyof EngineEvents]?: Set<EngineEvents[K]> } = {}
  private offs: (() => void)[] = []
  private lastTick = 0
  private clock = { time: 0, at: 0 }
  private lastPosEmit = 0
  private destroyed = false
  private view: ViewOptions | null = null

  on<K extends keyof EngineEvents>(k: K, fn: EngineEvents[K]): () => void {
    const hs = this.handlers as Record<string, Set<unknown>>
    const set = (hs[k] ||= new Set())
    set.add(fn)
    return () => { set.delete(fn) }
  }
  private emit<K extends keyof EngineEvents>(k: K, ...args: Parameters<EngineEvents[K]>) {
    (this.handlers[k] as Set<(...a: unknown[]) => void> | undefined)?.forEach(fn => fn(...args))
  }

  async mount(el: HTMLElement, scrollEl: HTMLElement, view: ViewOptions, data: ArrayBuffer) {
    this.state.set({ phase: 'loading' })
    let at: AlphaTab
    try { at = await loadAlphaTab() } catch (e) {
      this.state.set({ phase: 'error', error: 'The tab player could not start: ' + (e as Error).message })
      return
    }
    if (this.destroyed) return
    this.at = at
    this.view = view
    const settings = new at.Settings()
    settings.core.fontDirectory = '/alphatab/font/'
    settings.core.logLevel = at.LogLevel.Warning
    settings.display.scale = view.zoom / 100
    settings.display.layoutMode = view.layout === 'horizontal' ? at.LayoutMode.Horizontal : at.LayoutMode.Page
    settings.display.staveProfile = staveProfile(at, view.notation)
    settings.display.padding = [12, 20, 12, 20]
    const pl = settings.player
    pl.enablePlayer = true
    pl.playerMode = at.PlayerMode.EnabledSynthesizer
    pl.soundFont = '/alphatab/soundfont/sonivox.sf2'
    pl.scrollElement = scrollEl
    pl.enableCursor = true
    pl.enableAnimatedBeatCursor = true
    pl.enableElementHighlighting = true
    pl.enableUserInteraction = true
    pl.scrollMode = view.autoScroll ? at.ScrollMode.Continuous : at.ScrollMode.Off
    pl.scrollOffsetY = -40
    if (view.transpose) settings.notation.displayTranspositionPitches = new Array(64).fill(view.transpose)
    const api = new at.AlphaTabApi(el, settings)
    this.api = api
    this.applyColors(view.colors, false)
    const on = <T,>(em: { on(fn: (a: T) => void): () => void }, fn: (a: T) => void) => this.offs.push(em.on(fn))
    on<AT.model.Score>(api.scoreLoaded, score => {
      this.state.set({ score, phase: 'rendering' })
      this.position.set({ bars: score.masterBars.length })
      this.emit('scoreLoaded', score)
    })
    let first = true
    on<AT.rendering.RenderFinishedEventArgs>(api.renderFinished, () => {
      if (this.state.get().phase !== 'error') this.state.set({ phase: 'ready' })
      // open at the top (title and tempo), not where the cursor scroll put us
      if (first) { first = false; requestAnimationFrame(() => { if (!this.state.get().playing) scrollEl.scrollTo({ top: 0, left: 0 }) }) }
    })
    on<Error>(api.error, e => this.state.set({ phase: 'error', error: friendlyError(e) }))
    on<AT.ProgressEventArgs>(api.soundFontLoad, e => this.state.set({ soundLoad: e.total ? e.loaded / e.total : 0 }))
    on<void>(api.playerReady as never, () => { this.state.set({ playerReady: true, soundLoad: 1 }); this.midiReady(this.position.get().end) })
    on<AT.synth.PlayerStateChangedEventArgs>(api.playerStateChanged, e => {
      const playing = e.state === at.synth.PlayerState.Playing
      this.state.set({ playing })
      this.emit(playing ? 'play' : 'pause')
    })
    on<AT.synth.PositionChangedEventArgs>(api.playerPositionChanged, e => this.onPosition(e))
    // (not api.midiLoaded: in 1.8.4 subscribing to it recurses forever in the worker player)
    on<AT.synth.PlaybackRangeChangedEventArgs>(api.playbackRangeChanged, e => this.onRange(e.playbackRange))
    on<void>(api.playerFinished as never, () => { if (!this.state.get().looping || !this.state.get().range) this.emit('finished', this.state.get().speed) })
    on<AT.synth.ActiveBeatsChangedEventArgs>(api.activeBeatsChanged, e => { if (e.activeBeats.length) this.beats.set(e.activeBeats, true) })
    on<AT.model.Beat>(api.beatMouseDown, b => { this.beats.set([b], true); this.emit('beatClicked', b) })
    try {
      const score = at.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(data), settings)
      this.state.set({ fileNotes: tidyScore(score) })
      api.renderScore(score, view.tracks.length ? view.tracks : [0])
    } catch (e) {
      this.state.set({ phase: 'error', error: friendlyError(e as Error) })
    }
    this.state.set({ renderedTracks: view.tracks.length ? view.tracks : [0] })
  }

  private midiSent = false
  private midiReady(endMs: number) {
    if (this.midiSent || !(endMs > 0)) return
    this.midiSent = true
    this.emit('midiLoaded', endMs * (this.api?.playbackSpeed || 1))
  }

  private onPosition(e: AT.synth.PositionChangedEventArgs) {
    if (e.endTime > 0) this.midiReady(e.endTime)
    const st = this.state.get()
    // a loop pass: the playhead jumps from the end of the range back to its start
    // (the player reports that jump as a seek, so look at where it came from)
    const rt = this.rangeTicks
    if (st.looping && st.range && rt && e.currentTick + 10 < this.lastTick && this.lastTick >= rt.end - 1920 && e.currentTick <= rt.start + 960) {
      this.emit('loopPass', st.speed, st.range)
    } else if (e.isSeek) this.emit('seek', e.currentTime)
    this.lastTick = e.currentTick
    this.clock = { time: e.currentTime, at: performance.now() }
    const now = performance.now()
    // a calm readout: four updates a second are plenty for the clock
    if (e.isSeek || now - this.lastPosEmit > 240) {
      this.lastPosEmit = now
      const bar = this.barAtTick(e.currentTick)
      this.position.set({ time: e.currentTime, end: e.endTime, tick: e.currentTick, endTick: e.endTick, bar: bar < 0 ? 0 : bar })
    }
  }

  private rangeTicks: { start: number; end: number } | null = null
  private onRange(r: AT.synth.PlaybackRange | null) {
    this.rangeTicks = r ? { start: r.startTick, end: r.endTick } : null
    if (!r || !this.api?.tickCache) { this.state.set({ range: null }); return }
    const start = this.barAtTick(r.startTick)
    const end = this.barAtTick(Math.max(r.startTick, r.endTick - 1))
    this.state.set({ range: start < 0 || end < 0 ? null : { start, end } })
  }

  /** The playhead in ms (wall clock at the current speed), between the player's own updates too. */
  nowMs(): number {
    const c = this.clock
    return c.time + (this.state.get().playing ? Math.min(1000, performance.now() - c.at) : 0)
  }

  barAtTick(tick: number): number {
    const mbs = this.api?.tickCache?.masterBars || []
    for (const m of mbs) if (tick >= m.start && tick < m.end) return m.masterBar.index
    return mbs.length ? mbs[mbs.length - 1].masterBar.index : -1
  }

  // ---- view ----

  setView(v: ViewOptions) {
    const api = this.api, at = this.at, old = this.view
    this.view = v
    if (!api || !at || !old) return
    const s = api.settings
    let render = false
    if (old.zoom !== v.zoom) { s.display.scale = v.zoom / 100; render = true }
    if (old.layout !== v.layout) { s.display.layoutMode = v.layout === 'horizontal' ? at.LayoutMode.Horizontal : at.LayoutMode.Page; render = true }
    if (old.notation !== v.notation) { s.display.staveProfile = staveProfile(at, v.notation); render = true }
    if (old.autoScroll !== v.autoScroll) { s.player.scrollMode = v.autoScroll ? at.ScrollMode.Continuous : at.ScrollMode.Off }
    if (old.transpose !== v.transpose) { s.notation.displayTranspositionPitches = (api.score?.tracks || []).map(() => v.transpose); render = true }
    if (JSON.stringify(old.colors) !== JSON.stringify(v.colors)) { this.applyColors(v.colors, false); render = true }
    const tracksChanged = old.tracks.join() !== v.tracks.join()
    if (render || old.autoScroll !== v.autoScroll) api.updateSettings()
    if (tracksChanged && api.score) {
      const tr = v.tracks.map(i => api.score!.tracks[i]).filter(Boolean)
      if (tr.length) { this.state.set({ renderedTracks: v.tracks, phase: 'rendering' }); api.renderTracks(tr); return }
    }
    if (render) { this.state.set({ phase: 'rendering' }); api.render() }
  }

  private applyColors(c: ScoreColors | null, update = true) {
    const api = this.api, at = this.at
    if (!api || !at) return
    const r = api.settings.display.resources
    const def = new at.RenderingResources()
    const C = (v: string | undefined, d: AT.model.Color) => v ? at.model.Color.fromJson(v) ?? d : d
    r.mainGlyphColor = C(c?.main, def.mainGlyphColor)
    r.secondaryGlyphColor = C(c?.secondary, def.secondaryGlyphColor)
    r.staffLineColor = C(c?.staff, def.staffLineColor)
    r.barSeparatorColor = C(c?.bar, def.barSeparatorColor)
    r.barNumberColor = C(c?.barNumber, def.barNumberColor)
    r.scoreInfoColor = C(c?.info, def.scoreInfoColor)
    if (update) { api.updateSettings(); api.render() }
  }

  // ---- playback ----

  playPause() { if (this.api && this.state.get().playerReady) this.api.playPause() }
  play() { if (this.api && this.state.get().playerReady) this.api.play() }
  pause() { this.api?.pause() }
  stop() { this.api?.stop() }

  setSpeed(speed: number) {
    const v = Math.max(0.25, Math.min(2, Math.round(speed * 100) / 100))
    if (this.api) this.api.playbackSpeed = v
    this.state.set({ speed: v })
  }
  setMetronome(on: boolean) { if (this.api) this.api.metronomeVolume = on ? 1 : 0; this.state.set({ metronome: on }) }
  setCountIn(on: boolean) { if (this.api) this.api.countInVolume = on ? 1 : 0; this.state.set({ countIn: on }) }
  private audible = true
  setVolume(v: number) { if (this.api) this.api.masterVolume = this.audible ? v : 0; this.state.set({ volume: v }) }

  setLooping(on: boolean) {
    if (this.api) this.api.isLooping = on
    this.state.set({ looping: on })
  }

  private tracks(idx: number[]) { return idx.map(i => this.api?.score?.tracks[i]).filter((t): t is AT.model.Track => !!t) }
  setMute(i: number, on: boolean) {
    const tr = this.tracks([i]); if (tr.length) this.api!.changeTrackMute(tr, on)
    const m = new Set(this.state.get().muted); on ? m.add(i) : m.delete(i)
    this.state.set({ muted: [...m].sort((a, b) => a - b) })
  }
  setSolo(i: number, on: boolean) {
    const tr = this.tracks([i]); if (tr.length) this.api!.changeTrackSolo(tr, on)
    const m = new Set(this.state.get().solo); on ? m.add(i) : m.delete(i)
    this.state.set({ solo: [...m].sort((a, b) => a - b) })
  }
  setTrackVolume(i: number, v: number) {
    const tr = this.tracks([i]); if (tr.length) this.api!.changeTrackVolume(tr, v)
    this.state.set({ trackVolume: { ...this.state.get().trackVolume, [i]: v } })
  }
  /** Silence the synthesizer (the recording plays instead) without touching the mixer. */
  setSynthAudible(on: boolean) { this.audible = on; if (this.api) this.api.masterVolume = on ? this.state.get().volume : 0 }

  // ---- bars and loops ----

  private barBeats(bar: number, last: boolean): AT.model.Beat | null {
    const score = this.api?.score
    if (!score) return null
    const idx = this.state.get().renderedTracks
    const track = score.tracks[idx[0] ?? 0] || score.tracks[0]
    const b = track?.staves[0]?.bars[bar]
    const beats = b?.voices[0]?.beats
    if (!beats?.length) return null
    return last ? beats[beats.length - 1] : beats[0]
  }

  /** Select bars start..end (0-based, inclusive) as the loop and highlight them. */
  selectBars(start: number, end: number) {
    const api = this.api
    if (!api?.score) return
    const n = api.score.masterBars.length
    start = Math.max(0, Math.min(n - 1, start)); end = Math.max(start, Math.min(n - 1, end))
    const a = this.barBeats(start, false), b = this.barBeats(end, true)
    if (!a || !b) return
    api.highlightPlaybackRange(a, b)
    api.applyPlaybackRangeFromHighlight()
    this.state.set({ range: { start, end } })
  }
  clearSelection() {
    const api = this.api
    if (!api) return
    api.clearPlaybackRangeHighlight()
    api.playbackRange = null
    this.state.set({ range: null })
  }
  /** Move the playhead to the start of a bar (0-based). */
  seekBar(bar: number) {
    const api = this.api
    if (!api?.score || !api.tickCache) return
    const n = api.score.masterBars.length
    const mb = api.score.masterBars[Math.max(0, Math.min(n - 1, bar))]
    api.tickPosition = api.tickCache.getMasterBarStart(mb)
    this.position.set({ bar: mb.index })
  }
  print() { (this.api as unknown as { print?: (w?: string) => void })?.print?.() }

  destroy() {
    this.destroyed = true
    this.offs.forEach(o => o())
    this.offs = []
    try { this.api?.destroy() } catch { /* already gone */ }
    this.api = null
  }
}

function staveProfile(at: AlphaTab, n: Notation) {
  return n === 'score' ? at.StaveProfile.Score : n === 'both' ? at.StaveProfile.ScoreTab : at.StaveProfile.Tab
}

function friendlyError(e: Error): string {
  const m = e?.message || String(e)
  if (/unsupported|no reader|not supported/i.test(m)) return 'This file type could not be read. Guitar Pro (3–8), MusicXML and alphaTex files work.'
  return 'The tab could not be shown: ' + m
}

export function useEngineState(e: TabEngine): EngineState { return useSyncExternalStore(e.state.subscribe, e.state.get) }
export function usePosition(e: TabEngine): Position { return useSyncExternalStore(e.position.subscribe, e.position.get) }
export function useActiveBeats(e: TabEngine): AT.model.Beat[] { return useSyncExternalStore(e.beats.subscribe, e.beats.get) }
