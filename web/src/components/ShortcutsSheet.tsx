import { Modal } from './ui'

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  { title: 'Go to', keys: [[['h'], 'Home'], [['b'], 'Library'], [['s'], 'Setlists'], [['p'], 'Practice'], [['t'], 'Tuner'], [['m'], 'Metronome'], [[','], 'Settings'], [['/'], 'Search songs & commands'], [['⌘', 'K'], 'Search songs & commands']] },
  { title: 'Add', keys: [[['n'], 'Upload tab files'], [['l'], 'Log practice'], [['drop'], 'Drop files anywhere to add them']] },
  { title: 'Playing a song', keys: [[['space'], 'Play or pause'], [['esc'], 'Stop, or clear the selection'], [['l'], 'Loop on or off'], [['[', ']'], 'Slower, faster'], [['←', '→'], 'Previous, next bar'], [['home'], 'Back to the start'], [['s'], 'Save the selection as a section'], [['1–9'], 'Loop a section'], [['m'], 'Metronome'], [['c'], 'Count-in'], [['f'], 'Fretboard'], [['t'], 'Tracks']] },
  { title: 'Metronome page', keys: [[['space'], 'Start or stop'], [['↑', '↓'], 'Tempo up, down (shift: by 10)']] },
  { title: 'Window', keys: [[['['], 'Show or hide the sidebar'], [['esc'], 'Close a dialog or menu'], [['?'], 'This sheet']] },
]

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} size="lg">
      <div className="shortcuts">
        {GROUPS.map(g => (
          <section key={g.title}>
            <h4 className="sc-h">{g.title}</h4>
            {g.keys.map(([keys, label]) => (
              <div key={label + keys.join('')} className="sc-row"><span>{label}</span><span className="sc-keys">{keys.map(k => <kbd key={k}>{k}</kbd>)}</span></div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  )
}
