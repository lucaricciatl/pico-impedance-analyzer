import Chart, { baseLayout } from './Chart'
import { fmt } from '../api'

const CYAN = '#22d3ee'
const AMBER = '#fbbf24'
const VIOLET = '#a78bfa'
const GREEN = '#34d399'

const axisStyle = {
  showspikes: true,
  spikemode: 'across',
  spikethickness: 1,
  spikedash: 'dot',
  spikecolor: '#2f4757',
}

function decades(min, max) {
  const lo = Math.floor(Math.log10(min))
  const hi = Math.ceil(Math.log10(max))
  const vals = []
  const text = []
  for (let e = lo; e <= hi; e++) {
    const v = Math.pow(10, e)
    if (v < min * 0.85 || v > max * 1.15) continue
    vals.push(v)
    text.push(fmt.eng(v, 'Hz'))
  }
  return { vals, text }
}

function span(points, key, fallback = [1, 1e3]) {
  if (!points.length) return fallback
  const v = points.map((p) => p[key]).filter((x) => Number.isFinite(x) && x > 0)
  if (!v.length) return fallback
  return [Math.min(...v), Math.max(...v)]
}

export function BodeMagnitude({ points }) {
  const [fmin, fmax] = span(points, 'f', [10, 1e5])
  const [zmin, zmax] = span(points, 'mag', [10, 1e4])
  const ticks = decades(fmin, fmax)
  return (
    <Chart
      data={[
        {
          x: points.map((p) => p.f),
          y: points.map((p) => p.mag),
          customdata: points.map((p) => [fmt.eng(p.f, 'Hz'), fmt.eng(p.mag, 'Ω')]),
          mode: 'lines+markers',
          type: 'scatter',
          line: { color: CYAN, width: 2, shape: 'linear' },
          marker: { color: CYAN, size: 4.5, line: { width: 0 } },
          hovertemplate: '%{customdata[0]}<br>|Z| = %{customdata[1]}<extra></extra>',
        },
      ]}
      layout={baseLayout({
        margin: { l: 58, r: 16, t: 10, b: 36 },
        xaxis: { ...axisStyle, type: 'log', tickvals: ticks.vals, ticktext: ticks.text,
                 title: { text: 'frequency', font: { size: 9.5, color: '#4d5f6d' } } },
        yaxis: { ...axisStyle, type: 'log', tickformat: '~s',
                 ticksuffix: 'Ω', title: { text: '|Z|', font: { size: 9.5, color: '#4d5f6d' } } },
      })}
    />
  )
}

export function BodePhase({ points }) {
  const [fmin, fmax] = span(points, 'f', [10, 1e5])
  const ticks = decades(fmin, fmax)
  return (
    <Chart
      data={[
        {
          x: points.map((p) => p.f),
          y: points.map((p) => p.phase_deg),
          customdata: points.map((p) => [fmt.eng(p.f, 'Hz'), fmt.num(p.phase_deg, 2)]),
          mode: 'lines+markers',
          type: 'scatter',
          line: { color: AMBER, width: 2 },
          marker: { color: AMBER, size: 4.5 },
          hovertemplate: '%{customdata[0]}<br>∠Z = %{customdata[1]}°<extra></extra>',
        },
      ]}
      layout={baseLayout({
        margin: { l: 48, r: 16, t: 10, b: 36 },
        xaxis: { ...axisStyle, type: 'log', tickvals: ticks.vals, ticktext: ticks.text,
                 title: { text: 'frequency', font: { size: 9.5, color: '#4d5f6d' } } },
        yaxis: { ...axisStyle, range: [-100, 100], dtick: 45, ticksuffix: '°' },
        shapes: [
          { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: 0, y1: 0,
            line: { color: '#2b3d4a', width: 1, dash: 'dot' } },
        ],
      })}
    />
  )
}

export function Nyquist({ points }) {
  const xs = points.map((p) => p.z_re)
  const ys = points.map((p) => -p.z_im)
  const all = [...xs, ...ys]
  const lo = all.length ? Math.min(0, Math.min(...all)) : 0
  const hi = all.length ? Math.max(...all) : 1
  const pad = Math.max((hi - lo) * 0.08, 1e-6)
  const decadesMark = points.filter((p) => {
    const e = Math.log10(p.f)
    return Math.abs(e - Math.round(e)) < 0.03
  })
  return (
    <Chart
      data={[
        {
          x: xs,
          y: ys,
          customdata: points.map((p) => [
            fmt.eng(p.f, 'Hz'), fmt.eng(p.mag, 'Ω'),
            fmt.num(p.phase_deg, 2), fmt.eng(p.z_re, 'Ω'), fmt.eng(p.z_im, 'Ω'),
          ]),
          mode: 'lines+markers',
          type: 'scatter',
          line: { color: VIOLET, width: 2 },
          marker: { color: VIOLET, size: 4.5 },
          hovertemplate:
            '%{customdata[0]}<br>Re = %{customdata[3]}<br>Im = %{customdata[4]}' +
            '<br>|Z| = %{customdata[1]}<br>∠ = %{customdata[2]}°<extra></extra>',
        },
        {
          x: decadesMark.map((p) => p.z_re),
          y: decadesMark.map((p) => -p.z_im),
          text: decadesMark.map((p) => fmt.eng(p.f, 'Hz')),
          mode: 'text',
          type: 'scatter',
          textposition: 'top center',
          textfont: { size: 9, color: '#5f7383', family: 'ui-monospace, monospace' },
          hoverinfo: 'skip',
        },
        {
          x: points.length ? [points[0].z_re] : [],
          y: points.length ? [-points[0].z_im] : [],
          mode: 'markers',
          marker: { symbol: 'circle-open', size: 13, color: GREEN, line: { width: 1.5 } },
          hoverinfo: 'skip',
        },
      ]}
      layout={baseLayout({
        margin: { l: 52, r: 16, t: 10, b: 38 },
        xaxis: { ...axisStyle, range: [lo - pad, hi + pad], ticksuffix: '',
                 constrain: 'domain',
                 title: { text: 'Re(Z) Ω', font: { size: 9.5, color: '#4d5f6d' } } },
        yaxis: { ...axisStyle, range: [lo - pad, hi + pad], scaleanchor: 'x', scaleratio: 1,
                 constrain: 'domain',
                 title: { text: '−Im(Z) Ω', font: { size: 9.5, color: '#4d5f6d' } } },
        annotations: points.length
          ? [
              { x: xs[0], y: ys[0], xref: 'x', yref: 'y', text: 'low f', showarrow: true,
                arrowhead: 2, arrowsize: 0.8, arrowwidth: 1, ax: -26, ay: 22,
                font: { size: 9, color: GREEN }, arrowcolor: GREEN },
            ]
          : [],
      })}
    />
  )
}

export function StripChart({ samples, field, unit, color, transform }) {
  const t = samples.map((s) => s.t)
  const v = samples.map((s) => (transform ? transform(s.point) : s.point[field]))
  const finite = v.filter((x) => Number.isFinite(x))
  const lo = finite.length ? Math.min(...finite) : 0
  const hi = finite.length ? Math.max(...finite) : 1
  const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.001, 1e-9)
  return (
    <Chart
      data={[
        {
          x: t,
          y: v,
          customdata: samples.map((s) => [fmt.num(s.t, 1), fmt.num(s.point.f, 0)]),
          mode: 'lines',
          type: 'scatter',
          line: { color, width: 1.8 },
          hovertemplate: 't = %{customdata[0]} s<br>%{y:.5~s}' + unit + '<extra></extra>',
        },
      ]}
      layout={baseLayout({
        margin: { l: 56, r: 14, t: 8, b: 30 },
        xaxis: { ...axisStyle, title: { text: 't (s)', font: { size: 9, color: '#4d5f6d' } } },
        yaxis: { ...axisStyle, range: [lo - pad, hi + pad], tickformat: '~s',
                 ticksuffix: unit },
      })}
    />
  )
}

export function ScopeTraces({ trace, onCheck }) {
  if (!trace) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center' }} className="hint">
        <button className="btn ghost sm" onClick={onCheck}>check signal</button>
      </div>
    )
  }
  return (
    <Chart
      data={[
        {
          x: trace.t_ms, y: trace.vb, mode: 'lines', type: 'scatter',
          line: { color: '#38bdf8', width: 1.6 }, name: 'B · source',
          hovertemplate: 't = %{x:.3f} ms<br>V_B = %{y:.4f} V<extra></extra>',
        },
        {
          x: trace.t_ms, y: trace.va, mode: 'lines', type: 'scatter',
          line: { color: CYAN, width: 1.6, dash: 'solid' }, name: 'A · DUT',
          hovertemplate: 't = %{x:.3f} ms<br>V_A = %{y:.4f} V<extra></extra>',
        },
      ]}
      layout={baseLayout({
        margin: { l: 50, r: 12, t: 8, b: 30 },
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.12, font: { size: 9.5, color: '#7b8f9e' },
                  bgcolor: 'rgba(0,0,0,0)' },
        xaxis: { ...axisStyle, title: { text: 'ms', font: { size: 9, color: '#4d5f6d' } } },
        yaxis: { ...axisStyle, ticksuffix: 'V' },
      })}
    />
  )
}

export function SignalQuality({ points }) {
  const snr = points.map((p) => p.snr_db)
  const last = null
  return null
}
