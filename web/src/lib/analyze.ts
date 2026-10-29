// Reads tabs that arrived without the browser having seen them (from a Pocket
// Files folder, Songsterr, an upload from another device): tracks, tunings,
// tempo, bars and length, so the library shows them without opening each song.
import { api, V1 } from './api'
import type { Tab } from './types'
import { loadAlphaTab, type AT } from '../player/alphatab'
import { analyse } from '../player/music'

/** The song's length from its bars and tempo changes (no audio needed). */
export function estimateDurationMs(score: AT.model.Score): number {
  let tempo = score.tempo || 120
  let ms = 0
  for (const mb of score.masterBars) {
    const autos = ((mb as unknown as { tempoAutomations?: { value: number }[] }).tempoAutomations) || []
    if (autos.length && autos[0].value > 0) tempo = autos[0].value
    const ticks = mb.calculateDuration()
    ms += (ticks / 960) * (60000 / tempo)
  }
  return ms
}

let running = false

/** Reads up to `limit` unread tabs one after another; calls onDone with each updated tab. */
export async function analyzePending(tabs: Tab[], onDone: (t: Tab) => void, limit = 25) {
  if (running) return
  running = true
  try {
    const todo = tabs.filter(t => !t.analyzed).slice(0, limit)
    if (!todo.length) return
    const at = await loadAlphaTab()
    for (const t of todo) {
      try {
        const res = await fetch(`${V1}/tabs/${t.id}/file`, { credentials: 'same-origin' })
        if (!res.ok) continue
        const bytes = new Uint8Array(await res.arrayBuffer())
        const score = at.importer.ScoreLoader.loadScoreFromBytes(bytes)
        const updated = await api.put<Tab>(`${V1}/tabs/${t.id}/analysis`, analyse(score, estimateDurationMs(score)))
        onDone(updated)
      } catch { /* a file alphaTab cannot read stays unread; the player says why */ }
      await new Promise(r => setTimeout(r, 50))
    }
  } finally { running = false }
}
