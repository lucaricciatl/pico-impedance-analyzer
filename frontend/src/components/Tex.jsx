import { useMemo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/**
 * Typeset maths with KaTeX.
 *   <Tex>{String.raw`Z = \frac{R_{ref} V_A}{V_B - V_A}`}</Tex>
 */
export default function Tex({ children, block = false, className = '', style }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(String(children), {
        displayMode: block,
        throwOnError: false,
        strict: false,
        output: 'html',
      })
    } catch (e) {
      return `<code>${String(children)}</code>`
    }
  }, [children, block])

  return (
    <span
      className={`tex ${block ? 'tex-block' : ''} ${className}`}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
