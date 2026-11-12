// Fallback for "Ask Claude about my grades" when the browser would not let us copy to the clipboard:
// show the summary so the student can copy it by hand.
import { useRef, useState } from 'react'
import { ExternalLink } from './Link'
import { Modal } from './Modal'
import { ExternalIcon } from './icons'

export function ClaudeDialog({ text, onClose }: { text: string | null; onClose: () => void }) {
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text ?? '')
      setCopied(true)
    } catch {
      // Clipboard still blocked: select the text so Cmd+C / Ctrl+C works.
      areaRef.current?.select()
    }
  }

  return (
    <Modal open={text !== null} onClose={onClose} title="Your grade summary">
      <p className="muted small">Copy this and paste it into Claude. It has no names, ids or links.</p>
      <label className="sr-only" htmlFor="claude-text">
        Grade summary
      </label>
      <textarea id="claude-text" ref={areaRef} className="claude-text" readOnly value={text ?? ''} rows={12} />
      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <ExternalLink href="https://claude.ai/new" className="btn btn-secondary btn-sm">
          Open Claude <ExternalIcon size={14} />
        </ExternalLink>
      </div>
    </Modal>
  )
}
