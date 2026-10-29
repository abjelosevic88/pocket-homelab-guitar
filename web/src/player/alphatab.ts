// Loads alphaTab from /alphatab/ (see vite.config.ts): a runtime import so its
// worker, worklet, font and soundfont resolve next to the module. Types come
// from the package; nothing of it is bundled.
import type * as AT from '@coderline/alphatab'

export type AlphaTab = typeof AT
export type { AT }

let loading: Promise<AlphaTab> | null = null

export function loadAlphaTab(): Promise<AlphaTab> {
  if (!loading) {
    const url = '/alphatab/alphaTab.mjs'
    loading = (import(/* @vite-ignore */ url) as Promise<AlphaTab>).catch(e => { loading = null; throw e })
  }
  return loading
}
