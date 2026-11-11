import { useState } from 'react'
import { BodeMagnitude, BodePhase, Nyquist, ScopeTraces } from './Plots'
import { fmt } from '../api'

function Readout({ k, v, unit, sub, cls }) {
  return (
    <div className="readout">
      <div className="k">{k}</div>
      <div className={`v ${cls || ''}`}>
        {v}
        {unit && <small>{unit}</small>}
      </div>
      <div className="sub">{sub || '\u00a0'}</div>
    </div>
  )
}

export default function SweepView({ points, trace, meta, onExport, onSave, onExportZip,
                                    saving, onCheckSignal }) {
  const [showLog, setShowLog] = useState(() => window.innerHeight >= 820)
  const last = points.length ? points[points.length - 1] : null
  const eq = last
    ? last.c_equiv
      ? `${fmt.eng(last.c_equiv, 'F')} series`
      : last.l_equiv
      ? `${fmt.eng(last.l_equiv, 'H')} series`
      : 'resistive'
    : ''

  return (
    <>
      <div className="readouts">
        <Readout
          k="|Z|"
          v={last ? fmt.num(last.mag, 2) : '—'}
          unit={last ? 'Ω' : ''}
          sub={last ? fmt.eng(last.mag, 'Ω') : 'run a sweep'}
          cls="c-cyan"
        />
        <Readout
          k="phase"
          v={last ? fmt.num(last.phase_deg, 2) : '—'}
          unit={last ? '°' : ''}
          sub={last ? eq : ''}
          cls="c-amber"
        />
        <Readout
          k="Re / Im"
          v={last ? fmt.num(last.z_re, 1) : '—'}
          unit={last ? 'Ω' : ''}
          sub={last ? `Im ${fmt.eng(last.z_im, 'Ω')}` : ''}
          cls="c-violet"
        />
        <Readout
          k="quality"
          v={last ? fmt.num(last.snr_db, 1) : '—'}
          unit={last ? 'dB SNR' : ''}
          sub={last ? `±${fmt.num(last.uncertainty_pct, 2)}% · ${fmt.num(last.elapsed_ms, 0)} ms/pt` : ''}
          cls={last && last.snr_db < 30 ? 'c-amber' : 'c-green'}
        />
      </div>

      <div className="charts">
        <div className="chart-card">
          <div className="chart-head">
            <h3>Bode · magnitude</h3>
            <span className="axis">|Z| vs f · log-log</span>
          </div>
          <div className="chart-body"><BodeMagnitude points={points} /></div>
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <h3>Bode · phase</h3>
            <span className="axis">∠Z vs f</span>
          </div>
          <div className="chart-body"><BodePhase points={points} /></div>
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <h3>Nyquist</h3>
            <span className="axis">−Im vs Re</span>
          </div>
          <div className="chart-body"><Nyquist points={points} /></div>
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <h3>Signal</h3>
            <span className="axis">
              {trace ? `${fmt.eng(trace.f, 'Hz')} · A ${trace.range_a} V · B ${trace.range_b} V` : 'time domain'}
            </span>
          </div>
          <div className="chart-body">
            <ScopeTraces trace={trace} onCheck={onCheckSignal} />
          </div>
        </div>
      </div>

      {points.length > 0 && (
        <div className="card tight" style={{ flex: 'none' }}>
          <div className="card-title">
            <span>
              Measurement log · {points.length} points
              {meta?.r_ref ? ` · R_ref ${fmt.eng(meta.r_ref, 'Ω')}` : ''}
            </span>
            <div className="toolbar">
              <button className="btn ghost sm" onClick={() => setShowLog((v) => !v)}>
                {showLog ? 'hide table' : 'show table'}
              </button>
              <button className="btn ghost sm" onClick={onSave} disabled={saving}>
                {saving ? 'saving…' : 'save'}
              </button>
              <button className="btn ghost sm" onClick={onExport}>export CSV</button>
              <button className="btn sm primary" onClick={onExportZip} disabled={saving}
                      title="Bode magnitude, Bode phase, Nyquist and the full table as one ZIP">
                {saving ? '…' : 'export all (zip)'}
              </button>
            </div>
          </div>
          {showLog && (
          <div className="table-wrap scroll-thin">
            <table>
              <thead>
                <tr>
                  <th>f</th><th>|Z| Ω</th><th>∠Z °</th><th>Re Ω</th><th>Im Ω</th>
                  <th>C / L</th><th>I rms</th><th>SNR</th><th>±%</th><th>rng A/B</th>
                </tr>
              </thead>
              <tbody>
                {[...points].reverse().map((p, i) => (
                  <tr key={`${p.f}-${i}`}>
                    <td>{fmt.eng(p.f, 'Hz')}</td>
                    <td>{fmt.num(p.mag, 2)}</td>
                    <td>{fmt.num(p.phase_deg, 2)}</td>
                    <td>{fmt.num(p.z_re, 2)}</td>
                    <td>{fmt.num(p.z_im, 2)}</td>
                    <td>{p.c_equiv ? fmt.eng(p.c_equiv, 'F') : p.l_equiv ? fmt.eng(p.l_equiv, 'H') : '—'}</td>
                    <td>{fmt.eng(p.i_rms, 'A')}</td>
                    <td className={p.snr_db < 30 ? 'warn' : ''}>{fmt.num(p.snr_db, 1)}</td>
                    <td className={p.uncertainty_pct > 1 ? 'warn' : ''}>{fmt.num(p.uncertainty_pct, 2)}</td>
                    <td>{`${p.range_a}/${p.range_b}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}
    </>
  )
}
