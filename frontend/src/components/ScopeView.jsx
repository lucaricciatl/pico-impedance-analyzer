import Chart, { baseLayout } from './Chart'
import { fmt } from '../api'

const BLUE = '#38bdf8'
const VIOLET = '#a78bfa'
const AMBER = '#fbbf24'

export function ScopeTraceChart({ data }) {
  if (!data) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center' }} className="hint">
        waiting for a capture…
      </div>
    )
  }
  const mk = (y, color, name, dash, width) => ({
    x: data.t_ms,
    y,
    mode: 'lines',
    type: 'scatter',
    name,
    line: { color, width, dash },
    hovertemplate: `%{y:.4f} V<extra>${name}</extra>`,
  })
  const trigOn = data.trig && data.trig.mode && data.trig.mode !== 'off'
  const peak = Math.max(
    0.05,
    Math.abs(Math.max(...data.vb, ...data.emf)) * 1.25,
    trigOn ? Math.abs(data.trig.level_v) * 1.1 : 0,
  )
  const shapes = [
    { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0,
      line: { color: '#3a5061', width: 1 } },
  ]
  if (trigOn) {
    shapes.push({
      type: 'line', xref: 'paper', x0: 0, x1: 1,
      y0: data.trig.level_v, y1: data.trig.level_v,
      line: { color: '#fbbf24', width: 1, dash: 'dot' },
    })
  }
  return (
    <Chart
      data={[
        mk(data.emf, AMBER, 'AWG (reconstructed)', 'dot', 1.6),
        mk(data.vb, BLUE, 'CH B · V_B', 'solid', 2.0),
        mk(data.va, VIOLET, 'CH A · V_A', 'solid', 2.0),
      ]}
      layout={baseLayout({
        margin: { l: 56, r: 14, t: 8, b: 34 },
        showlegend: true,
        legend: {
          orientation: 'h', x: 0, y: 1.14, font: { size: 9.5, color: '#7b8f9e' },
          bgcolor: 'rgba(0,0,0,0)',
        },
        xaxis: {
          showspikes: false, showline: true, linecolor: '#22313d',
          gridcolor: '#1b2731', zeroline: false,
          title: { text: 'ms', font: { size: 9, color: '#4d5f6d' } },
        },
        yaxis: {
          showline: true, linecolor: '#22313d', gridcolor: '#1b2731',
          zeroline: true, zerolinecolor: '#3a5061', zerolinewidth: 1,
          ticksuffix: 'V',
          range: [-peak, peak],
        },
        shapes,
      })}
    />
  )
}

export default function ScopeView({ data, error }) {
  const z = data?.z
  return (
    <>
      <div className="readouts">
        <div className="readout">
          <div className="k">CH B · source</div>
          <div className="v c-blue" style={{ fontSize: 19 }}>
            {data ? fmt.num(data.vpp_b, 3) : '—'}<small>Vpp</small>
          </div>
          <div className="sub">{data ? `RMS ${fmt.num(data.rms_b, 4)} V · ±${fmt.eng(data.range_b, 'V')} range${data.range_b_auto ? ' · auto' : ''}` : ''}</div>
        </div>
        <div className="readout">
          <div className="k">CH A · DUT</div>
          <div className="v c-violet" style={{ fontSize: 19 }}>
            {data ? fmt.num(data.vpp_a, 3) : '—'}<small>Vpp</small>
          </div>
          <div className="sub">{data ? `RMS ${fmt.num(data.rms_a, 4)} V · ±${fmt.eng(data.range_a, 'V')} range${data.range_a_auto ? ' · auto' : ''}` : ''}</div>
        </div>
        <div className="readout">
          <div className="k">phase A vs B</div>
          <div className="v c-amber" style={{ fontSize: 19 }}>
            {data && data.phase_a_vs_b_deg != null ? fmt.num(data.phase_a_vs_b_deg, 2) : '—'}
            <small>°</small>
          </div>
          <div className="sub">
            {data ? `${fmt.eng(data.f, 'Hz')} · ${fmt.eng(data.time_div_us * 1e-6, 's')}/div` : ''}
          </div>
        </div>
        <div className="readout">
          <div className="k">Z from this trace</div>
          <div className="v c-green" style={{ fontSize: 19 }}>
            {z ? fmt.num(z.mag, 1) : '—'}<small>Ω</small>
          </div>
          <div className="sub">
            {z ? `${fmt.num(z.phase_deg, 2)}° · ${data.trig?.mode === 'off' ? 'free run' : `trig CH ${data.trig?.source}`}` : ''}
          </div>
        </div>
      </div>

      <div className="chart-card" style={{ flex: 1, minHeight: 320 }}>
        <div className="chart-head">
          <h3>Oscilloscope</h3>
          <span className="axis">
            {data
              ? `${data.time_div_us >= 1000
                  ? fmt.eng(data.time_div_us * 1e-6, 's')
                  : fmt.num(data.time_div_us, 0) + ' µs'}/div · ${data.trigger} · `
                + `${data.waveform === 'custom' ? `custom (${data.custom_points} pts)` : data.waveform}`
                + `${data.duty ? ` ${(data.duty * 100).toFixed(0)}%` : ''}`
                + `${data.bias_v ? ` · bias ${data.bias_v > 0 ? '+' : ''}${data.bias_v.toFixed(2)} V` : ''} · `
                + `${fmt.num(data.record_ms, 3)} ms · ${data.samples} pts · ${fmt.num(data.dt_us, 3)} µs/sample`
              : 'no data'}
          </span>
        </div>
        <div className="chart-body"><ScopeTraceChart data={data} /></div>
      </div>

      {error && <div className="errbox">{error}</div>}

      {data?.clipped && (
        <div className="warnbox">
          {data.clip_a && data.clip_b ? 'Both channels are clipping'
            : data.clip_a ? 'CH A is clipping' : 'CH B is clipping'} — the trace is flat-topped
          at ±{fmt.eng(data.clip_a ? data.range_a : data.range_b, 'V')}. Raise that range.
        </div>
      )}

      <div className="footnote">
        The amber trace is not measured — it is reconstructed from the two probes:
        V_emf = V_B + (600 Ω / R_ref)·(V_B − V_A). That is the generator's EMF behind its
        internal 600 Ω, which is why it sits slightly above V_B.
      </div>
    </>
  )
}
