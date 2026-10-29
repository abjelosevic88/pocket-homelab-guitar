import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// alphaTab (the score renderer and synthesizer) runs unbundled from /alphatab/:
// its ES modules find their web worker, audio worklet, music font and
// soundfont next to themselves (import.meta.url), which a bundle would break.
// The page loads it with a dynamic import (src/player/alphatab.ts); vite
// serves the files from node_modules in dev and copies them into dist/alphatab
// on build, so the Go binary embeds them like any other asset.
const AT = fileURLToPath(new URL('./node_modules/@coderline/alphatab/dist/', import.meta.url))
const ALPHATAB_FILES: Record<string, string> = {
  // the readable builds (not .min): the core gets two small layout patches below; served gzipped anyway
  'alphaTab.mjs': 'alphaTab.mjs',
  'alphaTab.core.mjs': 'alphaTab.core.mjs',
  'alphaTab.worker.mjs': 'alphaTab.worker.mjs',
  'alphaTab.worklet.mjs': 'alphaTab.worklet.mjs',
  'font/Bravura.woff2': 'font/Bravura.woff2',
  'font/Bravura.woff': 'font/Bravura.woff',
  'font/Bravura.otf': 'font/Bravura.otf',
  'soundfont/sonivox.sf2': 'soundfont/sonivox.sf2',
}
// Layout fixes for tab files from the wild (alphaTab 1.8.4). Each pattern must match exactly once:
// an alphaTab upgrade that changes this code fails the build instead of silently losing the fix.
//  1. Section names ("Main Riff") may share a line with P.M./let ring marks that start a beat later,
//     but their text is wider than the beat and runs into them: give sections a line of their own.
//  2. Text above the staff is sized by its letters only, so descenders touch the mark below
//     ("alternate picking" on top of "P.M."): add a little room under every text line.
//  3. A bar with more voices than the next one crashed loading ("reading 'beats'"): skip the link
//     to a voice that is not there (files from other converters, e.g. older Songsterr downloads).
//  5. The rhythm under the tab (stems, beams, tuplets) is drawn in the colour of the bar lines,
//     a softer shade than the fret numbers, so the numbers stay what you read first.
//  4. Standard notation with several voices crashed when the lowest note head of a chord was a
//     displaced one ("reading 'length'"): treat a missing note head as one that cannot be shared.
const PATCHES: [RegExp, string][] = [
  [/(class MarkerEffectInfo extends EffectInfo \{[\s\S]*?get canShareBand\(\) \{\s*return )true;/, '$1false;'],
  [/(class TextGlyph extends EffectGlyph \{[\s\S]*?const h = )size\.height;/, '$1size.height + 4;'],
  [/(const nextVoice = this\.bar\.nextBar\.voices\[this\.index\];\s*if \()(nextVoice\.beats\.length > 0\) \{\s*beat\.nextBeat = nextVoice\.beats\[0\];\s*beat\.nextBeat\.previousBeat = beat;\s*\}) else beat\.nextBeat\.previousBeat = beat;/, '$1nextVoice && $2'],
  [/paintBeams\(cx, cy, canvas, flagsElement, beamsElement\) \{\s*if \(this\.rhythmMode !== TabRhythmMode\.Hidden\) super\.paintBeams\(cx, cy, canvas, flagsElement, beamsElement\);\s*\}\s*paintTuplets\(cx, cy, canvas, beatElement, bracketsAsArcs = false\) \{\s*if \(this\.rhythmMode !== TabRhythmMode\.Hidden\) super\.paintTuplets\(cx, cy, canvas, beatElement, bracketsAsArcs\);\s*\}/,
    `paintBeams(cx, cy, canvas, flagsElement, beamsElement) {
		if (this.rhythmMode !== TabRhythmMode.Hidden) this._pgtRhythmColor(() => super.paintBeams(cx, cy, canvas, flagsElement, beamsElement));
	}
	paintTuplets(cx, cy, canvas, beatElement, bracketsAsArcs = false) {
		if (this.rhythmMode !== TabRhythmMode.Hidden) this._pgtRhythmColor(() => super.paintTuplets(cx, cy, canvas, beatElement, bracketsAsArcs));
	}
	_pgtRhythmColor(paint) {
		const r = this.resources, main = r.mainGlyphColor, second = r.secondaryGlyphColor;
		r.mainGlyphColor = r.barSeparatorColor; r.secondaryGlyphColor = r.barSeparatorColor;
		try { paint(); } finally { r.mainGlyphColor = main; r.secondaryGlyphColor = second; }
	}`],
  [/(const mainGroupBottomNoteHead = mainGroup\.correctNotes\.notes\.get\(mainGroupBottom\);\s*if \()(mainGroupBottomNoteHead\.length > 1\) return false;\s*const thisGroupBottomNoteHead = thisGroup\.correctNotes\.notes\.get\(thisGroupBottom\);\s*if \()(thisGroupBottomNoteHead\.length > 1\) return false;)/, '$1!mainGroupBottomNoteHead || $2!thisGroupBottomNoteHead || $3'],
]
function patchCore(src: string): string {
  for (const [re, to] of PATCHES) {
    if ((src.match(new RegExp(re.source, 'g')) || []).length !== 1) throw new Error(`alphaTab patch no longer applies: ${re.source.slice(0, 60)}…`)
    src = src.replace(re, to)
  }
  return src
}
function readAlphaTab(src: string): Buffer | string {
  return src === 'alphaTab.core.mjs' ? patchCore(readFileSync(AT + src, 'utf8')) : readFileSync(AT + src)
}

const MIME: Record<string, string> = { mjs: 'text/javascript', woff2: 'font/woff2', woff: 'font/woff', otf: 'font/otf', sf2: 'application/octet-stream' }

function alphaTabAssets(): Plugin {
  return {
    name: 'pocket-alphatab-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0]
        if (!path.startsWith('/alphatab/')) return next()
        const src = ALPHATAB_FILES[path.slice('/alphatab/'.length)]
        if (!src) { res.statusCode = 404; res.end(); return }
        res.setHeader('Content-Type', MIME[src.split('.').pop() || ''] || 'application/octet-stream')
        res.end(readAlphaTab(src))
      })
    },
    generateBundle() {
      for (const [name, src] of Object.entries(ALPHATAB_FILES)) {
        this.emitFile({ type: 'asset', fileName: 'alphatab/' + name, source: readAlphaTab(src) })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), alphaTabAssets()],
  build: {
    outDir: 'dist', emptyOutDir: true, sourcemap: false,
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'] } } },
  },
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL || 'http://localhost:8080', '/healthz': process.env.API_URL || 'http://localhost:8080', '/pocket-ask.js': process.env.API_URL || 'http://localhost:8080' },
  },
})
