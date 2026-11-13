// The AI's answers may use a little formatting: **bold**, "- " lists and "1. " lists. This turns an answer into
// plain blocks that the chat renders as React text nodes, never as HTML, so nothing in an answer can become markup.
// Anything else (headings, links, tables) simply shows as the text it is ("## " is dropped, the heading is bold).

export interface Span {
  text: string
  bold: boolean
}

export type Block = { kind: 'p'; spans: Span[] } | { kind: 'ul' | 'ol'; items: Span[][] }

const BULLET = /^\s*[-*•]\s+(.*)$/
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/
const HEADING = /^\s*#{1,6}\s+(.*)$/

/** "a **b** c" -> a, b (bold), c. Unpaired ** are shown as typed. */
export function parseSpans(line: string): Span[] {
  const parts = line.split('**')
  if (parts.length % 2 === 0) return [{ text: line, bold: false }] // an odd number of ** markers: not formatting
  return parts.map((text, i) => ({ text, bold: i % 2 === 1 })).filter((s) => s.text !== '')
}

export function parseRichText(text: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []

  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'p', spans: parseSpans(paragraph.join('\n')) })
    paragraph = []
  }

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = line.match(BULLET)
    const listItem = bullet ?? line.match(NUMBERED)
    if (listItem) {
      endParagraph()
      const kind = bullet ? 'ul' : 'ol'
      const item = parseSpans(listItem[1])
      const last = blocks[blocks.length - 1]
      if (last && last.kind === kind) last.items.push(item)
      else blocks.push({ kind, items: [item] })
      continue
    }
    if (line.trim() === '') {
      endParagraph()
      continue
    }
    const heading = line.match(HEADING)
    if (heading) {
      endParagraph()
      blocks.push({ kind: 'p', spans: [{ text: heading[1].replace(/\*\*/g, ''), bold: true }] })
      continue
    }
    // A plain line right after a list starts a new paragraph.
    paragraph.push(line)
  }
  endParagraph()
  return blocks
}
