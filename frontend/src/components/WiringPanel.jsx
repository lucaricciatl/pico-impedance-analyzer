import { useState } from 'react'
import { DirectNum } from './Fields'
import { fmt } from '../api'

const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0,
             3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1]

function e24Series(lo, hi) {
  const out = []
  for (let dec = -1; dec <= 5; dec++) {
    const scale = Math.pow(10, dec)
    for (const v of E24) {
      const x = v * scale
      if (x >= lo && x <= hi) out.push(Number(x.toPrecision(3)))
    }
  }
  return out
}

function nearestE24(z) {
  const series = e24Series(10, 100_000)
  let best = series[0]
  let bestD = Infinity
  for (const v of series) {
    const d = Math.abs(Math.log(v) - Math.log(Math.max(z, 1e-6)))
    if (d < bestD) { bestD = d; best = v }
  }
  return best
}

export default function WiringPanel({ rRef, setRRef, disabled }) {
  const [expected, setExpected] = useState(rRef)
  const rec = nearestE24(expected)
  const ratio = expected / (expected + rec)
  const good = ratio > 0.25 && ratio < 0.75

  return (
    <>
      <div className="card">
        <div className="card-title">Reference resistor</div>
        <DirectNum label="R_ref" value={rRef} onChange={setRRef} width="100%"
                   disabled={disabled} />
        <div className="presets" style={{ marginTop: 10 }}>
          {[10, 47, 100, 470, 1000, 4700, 10000, 47000].map((v) => (
            <button key={v} type="button" disabled={disabled}
                    className={Math.abs(rRef - v) < 1e-9 ? 'on' : ''}
                    onClick={() => setRRef(v)}>
              {fmt.eng(v, 'Ω')}
            </button>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 9 }}>
          Type any value. Shared by sweep and continuous, and mirrored in the schematic header.
        </div>
      </div>

      <div className="card">
        <div className="card-title">What value do I need?</div>
        <div className="field">
          <label>expected |Z| at the frequency of interest</label>
          <DirectNum value={expected} onChange={setExpected} width="100%" />
        </div>

        <div className={`suggest ${good ? 'ok' : 'warn'}`}>
          <div className="k">suggested R_ref</div>
          <div className="v">{fmt.eng(rec, 'Ω')}</div>
          <div className="s">
            DUT sees {Math.round(ratio * 100)} % of V_B · ±{Math.round((1 - ratio) * 100)} % dropped across R_ref
          </div>
        </div>

        <button className="btn" style={{ marginTop: 8 }} onClick={() => setRRef(rec)}
                disabled={disabled || rec === rRef}>
          {rec === rRef ? 'already selected' : `use ${fmt.eng(rec, 'Ω')}`}
        </button>

        <dl className="table-hint">
          <div><dt>10 – 100 Ω</dt><dd>milliohm to ~1 kΩ parts, electrolytes</dd></div>
          <div><dt>1 kΩ</dt><dd>general purpose, 100 Ω – 10 kΩ</dd></div>
          <div><dt>10 kΩ</dt><dd>1 kΩ – 100 kΩ, coatings, thin films</dd></div>
          <div><dt>100 kΩ</dt><dd>above 100 kΩ, dielectrics, insulators</dd></div>
        </dl>
      </div>

      <div className="warnbox">
        The 2204A generator has a fixed 600 Ω source resistance. With R_ref below ~600 Ω the
        source is loaded heavily and V_B sags — still measured correctly, but the current is
        limited. Raise the amplitude or accept the lower SNR.
      </div>
    </>
  )
}
