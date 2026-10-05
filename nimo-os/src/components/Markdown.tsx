/**
 * Markdown.tsx
 * A tiny, dependency-free markdown renderer for NIMO's agent responses —
 * headings, bullets, numbered lists, **bold**, *italics*, `inline code`,
 * ```code fences```, [links](url) and blockquotes. Output is styled for the
 * dashboard's dark glass panels.
 */

import React from 'react'

/** Render inline markdown (bold, italics, code, links) for one line. */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tok = m[0]
    const k = `${keyBase}-${i++}`
    if (tok.startsWith('**')) {
      nodes.push(<strong key={k} className="font-semibold text-white">{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('`')) {
      nodes.push(<code key={k} className="rounded-md bg-white/[0.08] px-1.5 py-0.5 font-mono text-[11px] text-[#a9b8ff]">{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith('[')) {
      const lm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/)
      if (lm) {
        nodes.push(<a key={k} href={lm[2]} target="_blank" rel="noopener noreferrer" className="text-[#a9b8ff] hover:underline">{lm[1]}</a>)
      }
    } else if (tok.startsWith('*')) {
      nodes.push(<em key={k} className="italic text-white/85">{tok.slice(1, -1)}</em>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export default function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const lines = String(text || '').split('\n')
  const blocks: React.ReactNode[] = []
  let listBuf: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let codeBuf: string[] | null = null
  let bi = 0

  const flushList = () => {
    if (!listBuf.length || !listType) return
    const items = listBuf.map((item, j) => (
      <li key={j} className="leading-relaxed">{renderInline(item, `li-${bi}-${j}`)}</li>
    ))
    blocks.push(
      listType === 'ul'
        ? <ul key={`ul-${bi++}`} className="ml-4 list-disc space-y-1 marker:text-[#6d7ef2]">{items}</ul>
        : <ol key={`ol-${bi++}`} className="ml-4 list-decimal space-y-1 marker:text-[#6d7ef2]">{items}</ol>
    )
    listBuf = []
    listType = null
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    // Code fences
    if (line.trim().startsWith('```')) {
      if (codeBuf === null) { flushList(); codeBuf = [] }
      else {
        blocks.push(
          <pre key={`code-${bi++}`} className="my-2 overflow-x-auto rounded-xl border border-white/10 bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-[#a9b8ff] custom-scrollbar">
            {codeBuf.join('\n')}
          </pre>
        )
        codeBuf = null
      }
      continue
    }
    if (codeBuf !== null) { codeBuf.push(raw); continue }

    // Headings
    const h = line.match(/^(#{1,4})\s+(.*)/)
    if (h) {
      flushList()
      const level = h[1].length
      const size = level <= 2 ? 'text-[15px]' : 'text-[13px]'
      blocks.push(
        <p key={`h-${bi++}`} className={`${size} mt-3 mb-1 font-semibold text-white first:mt-0`}>
          {renderInline(h[2], `hh-${bi}`)}
        </p>
      )
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushList()
      blocks.push(
        <blockquote key={`q-${bi++}`} className="my-1.5 border-l-2 border-[#6d7ef2]/50 pl-3 text-white/60 italic">
          {renderInline(line.slice(2), `qq-${bi}`)}
        </blockquote>
      )
      continue
    }

    // Bullets
    const ul = line.match(/^\s*[-*•]\s+(.*)/)
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)/)
    if (ul) {
      if (listType !== 'ul') flushList()
      listType = 'ul'
      listBuf.push(ul[1])
      continue
    }
    if (ol) {
      if (listType !== 'ol') flushList()
      listType = 'ol'
      listBuf.push(ol[2])
      continue
    }

    flushList()
    if (line.trim()) {
      blocks.push(
        <p key={`p-${bi++}`} className="leading-relaxed">{renderInline(line, `pp-${bi}`)}</p>
      )
    }
  }
  flushList()
  if (codeBuf !== null) {
    blocks.push(
      <pre key={`code-${bi++}`} className="my-2 overflow-x-auto rounded-xl border border-white/10 bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-[#a9b8ff]">{codeBuf.join('\n')}</pre>
    )
  }

  return <div className={`space-y-1.5 ${className}`}>{blocks}</div>
}
