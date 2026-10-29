// Player-only icons in the same style as components/icons.tsx (24 grid, round stroke).
import { Icon } from '../components/icons'

const P: Record<string, string> = {
  metronome: 'M9 3h6l4 18H5zM7.5 15h9M12 15l5-9',
  fretboard: 'M3 7h18M3 12h18M3 17h18M7 5v14M12 5v14M17 5v14',
  guitar: 'M19 3l2 2-4.5 4.5M16 6l2 2M14.5 9.5a3 3 0 0 0-4.2-.3l-.6.6a2.4 2.4 0 0 1-2 .7 3.8 3.8 0 0 0-3.4 6.2l1.4 1.4a3.8 3.8 0 0 0 6.2-3.4 2.4 2.4 0 0 1 .7-2l.6-.6a3 3 0 0 0-.3-4.2zM8.5 15.5h.01',
  'skip-start': 'M6 5v14M18 6l-9 6 9 6z',
  printer: 'M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z',
  'zoom-in': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6',
  'zoom-out': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6',
  'count-in': 'M5 4h14M5 20h14M8 4c0 4 8 6 8 8s-8 4-8 8M16 4c0 4-8 6-8 8',
  bars: 'M4 6v12M10 6v12M20 6v12M4 9h16M4 12h16M4 15h16',
  speed: 'M12 14l4-4M3.5 17a9 9 0 1 1 17 0',
  record: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  notes: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  view: 'M3 5h18v14H3zM3 9h18M9 9v10',
  wand: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 6.2l-1.4-1.4M3 21l9-9',
}

export function PIcon({ name, size = 16, className = '', strokeWidth = 1.75, title }: { name: string; size?: number; className?: string; strokeWidth?: number; title?: string }) {
  const d = P[name]
  if (!d) return <Icon name={name} size={size} className={className} strokeWidth={strokeWidth} title={title} />
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  )
}
