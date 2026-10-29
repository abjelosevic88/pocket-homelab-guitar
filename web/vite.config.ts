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
  'alphaTab.mjs': 'alphaTab.min.mjs',
  'alphaTab.core.mjs': 'alphaTab.core.min.mjs',
  'alphaTab.worker.mjs': 'alphaTab.worker.min.mjs',
  'alphaTab.worklet.mjs': 'alphaTab.worklet.min.mjs',
  'font/Bravura.woff2': 'font/Bravura.woff2',
  'font/Bravura.woff': 'font/Bravura.woff',
  'font/Bravura.otf': 'font/Bravura.otf',
  'soundfont/sonivox.sf2': 'soundfont/sonivox.sf2',
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
        res.end(readFileSync(AT + src))
      })
    },
    generateBundle() {
      for (const [name, src] of Object.entries(ALPHATAB_FILES)) {
        this.emitFile({ type: 'asset', fileName: 'alphatab/' + name, source: readFileSync(AT + src) })
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
