import { useEffect, useState } from 'react'

export function Num({ value, onChange, suffix, step = 'any', disabled, min, max, clamp }) {
  const [txt, setTxt] = useState(String(value ?? ''))
  useEffect(() => {
    if (Number(txt) !== Number(value)) setTxt(String(value ?? ''))
  }, [value])
  return (
    <div className="numwrap">
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        value={txt}
        onChange={(e) => {
          setTxt(e.target.value)
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n)) {
            // a clamped value is echoed straight back into the field, so the box
            // never shows a number the instrument is not actually producing
            const c = clamp ? clamp(n) : n
            onChange(c)
            if (clamp && Math.abs(c - n) > 1e-12) setTxt(String(+c.toFixed(3)))
          }
        }}
      />
      {suffix && <em>{suffix}</em>}
    </div>
  )
}

export function Field({ label, children, hint }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

export function Toggle({ label, on, onChange, disabled }) {
  return (
    <div
      className={`toggle ${on ? 'on' : ''}`}
      onClick={() => !disabled && onChange(!on)}
      role="switch"
      aria-checked={on}
    >
      <span>{label}</span>
      <i />
    </div>
  )
}

export function Seg({ options, value, onChange, disabled, cols = 2 }) {
  return (
    <div className="seg" style={cols !== 2 ? { gridTemplateColumns: `repeat(${cols}, 1fr)` } : undefined}>
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => !disabled && onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Numeric field that lets you type freely and commits valid values as you go.
 * Keeps its own text buffer while focused so React cannot fight the keyboard.
 */
export function DirectNum({ label, value, onChange, suffix = 'Ω', disabled, width = 104,
                            min = 1 }) {
  const [txt, setTxt] = useState(String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setTxt(String(value))
  }, [value, focused])

  return (
    <div className="directnum">
      {label && <span className="diag-label">{label}</span>}
      <input
        type="number"
        inputMode="decimal"
        value={txt}
        disabled={disabled}
        style={{ width, flex: width === '100%' ? '1 1 auto' : 'none' }}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          setTxt(e.target.value)
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n) && n >= min) onChange(n)
        }}
        onBlur={() => {
          setFocused(false)
          setTxt(String(value))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      {suffix && <span className="diag-label">{suffix}</span>}
    </div>
  )
}

export function Presets({ items, value, onPick, disabled }) {
  return (
    <div className="presets">
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          disabled={disabled}
          className={Math.abs(Number(value) - Number(it.value)) < 1e-9 ? 'on' : ''}
          onClick={() => onPick(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
