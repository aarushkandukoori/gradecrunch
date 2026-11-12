// A colored letter grade badge (A green, B blue, C amber, D orange, R red, P/N/W gray). The letter is always
// printed, so color is never the only signal.
import { letterTone } from '../lib/format'

export function LetterChip({ letter, size = 'md' }: { letter: string; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`chip chip-${letterTone(letter)} chip-${size}`}>{letter}</span>
}
