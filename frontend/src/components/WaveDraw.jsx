import { useEffect, useRef, useState } from 'react'

/**
 * One-cycle waveform editor. Drag to draw; the value under the cursor is
 * committed to the parent 300 ms after you stop, so dragging does not fire a
 * capture request per pointer event.
 */
export default function WaveDraw({ value, onChange, disabled, cols = 64 }) {
  const canvas = useRef(null)
  const timer = useRef(null)
  const drawing = useRef(false)
  const [local, setLocal] = useState(() =>
    Array.isArray(value) && value.length === cols ? value : new Array(cols).fill(0))

  useEffect(() => {
    if (Array.isArray(value) && value.length === cols && !drawing.current) setLocal(value)
  }, [value, cols])

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth || 280
    const h = c.clientHeight || 64
    c.width = Math.round(w * dpr)
    c.height = Math.round(h * dpr)
    const g = c.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)

    // zero line + quarters
    g.strokeStyle = '#1b2731'
    g.lineWidth = 1
    ;[0.25, 0.5, 0.75].forEach((f) => {
      g.beginPath()
      g.moveTo(0, h * f)
      g.lineTo(w, h * f)
      g.stroke()
    })
    g.strokeStyle = '#31485a'
    g.beginPath()
    g.moveTo(0, h / 2)
    g.lineTo(w, h / 2)
    g.stroke()

    // the shape
    const x = (i) => (i / (cols - 1)) * (w - 1)
    const y = (v) => h / 2 - (v * (h / 2 - 2))
    g.beginPath()
    local.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))))
    g.strokeStyle = '#a78bfa'
    g.lineWidth = 1.8
    g.stroke()
    g.lineTo(w - 1, h / 2)
    g.lineTo(0, h / 2)
    g.closePath()
    g.fillStyle = 'rgba(167,139,250,.12)'
    g.fill()
  }, [local, cols])

  const commit = (next) => {
    setLocal(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onChange(next), 300)
  }

  const pick = (e) => {
    if (disabled) return
    const c = canvas.current
    const r = c.getBoundingClientRect()
    const i = Math.min(cols - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * cols)))
    const v = 1 - 2 * Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    const next = local.slice()
    next[i] = Math.max(-1, Math.min(1, v))
    commit(next)
  }

  return (
    <canvas
      ref={canvas}
      className="wavedraw"
      onPointerDown={(e) => {
        drawing.current = true
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
        pick(e)
      }}
      onPointerMove={(e) => drawing.current && pick(e)}
      onPointerUp={() => { drawing.current = false }}
      onPointerLeave={() => { drawing.current = false }}
      title={disabled ? 'stop the scope to edit' : 'drag to draw one cycle'}
    />
  )
}
