// Adding a song from Songsterr, done in the browser: the server fetches the
// song's page data and each track's JSON from Songsterr (browsers may not),
// alphaTab builds the Guitar Pro file here, and it is uploaded like any other
// tab (with its Songsterr address, so the library knows where it came from).
import { api, ApiError, V1 } from '../lib/api'
import type { Tab, UploadResult } from '../lib/types'
import { loadAlphaTab } from '../player/alphatab'
import { SongsterrConverter, type SongsterrPart, type SongsterrRevision, type SongsterrSongMeta } from './convert'

export type ImportStep = 'reading' | 'tracks' | 'building' | 'saving'

function fileName(meta: SongsterrSongMeta): string {
  const name = `${meta.artist || 'Unknown artist'} - ${meta.title || 'Song'}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return name.slice(0, 150) + '.gp'
}

/** Fetches, converts and saves one Songsterr song. Returns the tab and whether it was already in the library. */
export async function importFromSongsterr(url: string, onStep?: (s: ImportStep, done?: number, total?: number) => void): Promise<{ tab: Tab; existing: boolean }> {
  onStep?.('reading')
  const meta = await api.get<SongsterrSongMeta>(`${V1}/songsterr/song?url=${encodeURIComponent(url)}`)
  const tracks = (meta.tracks || []).filter(t => typeof t.partId === 'number').sort((a, b) => a.partId - b.partId)
  if (!tracks.length) throw new Error('This Songsterr song has no tracks.')

  // the tracks' data, four at a time
  const revisions: (SongsterrRevision | null)[] = new Array(tracks.length).fill(null)
  let done = 0, next = 0
  onStep?.('tracks', 0, tracks.length)
  const worker = async () => {
    while (next < tracks.length) {
      const i = next++
      const t = tracks[i]
      try {
        const q = new URLSearchParams({ song: String(meta.song_id), revision: String(meta.revision_id), image: meta.image, part: String(t.partId) })
        const revision = await api.get<SongsterrPart>(`${V1}/songsterr/part?${q}`)
        if (Array.isArray(revision?.measures)) revisions[i] = { trackMeta: t, revision }
      } catch { /* a missing track is left out; the rest of the song still comes */ }
      onStep?.('tracks', ++done, tracks.length)
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  const got = revisions.filter((r): r is SongsterrRevision => !!r)
  if (!got.length) throw new Error('Songsterr sent no track data for this song. Try again in a minute.')

  onStep?.('building')
  const at = await loadAlphaTab()
  const data = new SongsterrConverter(at).toGp7(meta, got)
  // the file must open again before it is saved
  try {
    at.importer.ScoreLoader.loadScoreFromBytes(data)
  } catch (e) {
    throw new Error('The tab built from Songsterr does not open (' + (e as Error).message + '). Nothing was saved.')
  }

  onStep?.('saving')
  const fd = new FormData()
  fd.append('file', new File([data as BlobPart], fileName(meta), { type: 'application/octet-stream' }))
  fd.append('songsterr_url', meta.url)
  fd.append('title', meta.title)
  fd.append('artist', meta.artist)
  const res = await fetch(`${V1}/tabs`, { method: 'POST', body: fd, credentials: 'same-origin' })
  if (res.status === 401) window.dispatchEvent(new CustomEvent('pgt:unauthorized'))
  const j = (await res.json().catch(() => ({}))) as Partial<UploadResult> & { error?: string }
  if (j.added?.length) return { tab: j.added[0], existing: false }
  if (j.existing?.length) return { tab: j.existing[0], existing: true }
  throw new ApiError(res.status, j.errors?.[0]?.error || j.error || res.statusText)
}
