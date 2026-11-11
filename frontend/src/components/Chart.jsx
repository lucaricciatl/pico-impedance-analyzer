import { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist-min'

const GRID = '#1b2731'
const AXIS = '#6b7f8f'

export function baseLayout(extra = {}) {
  return {
    margin: { l: 52, r: 14, t: 8, b: 34 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'ui-monospace, Menlo, monospace', size: 10, color: AXIS },
    hovermode: 'closest',
    hoverlabel: {
      bgcolor: '#0b141b',
      bordercolor: '#243544',
      font: { family: 'ui-monospace, Menlo, monospace', size: 11, color: '#d8e4ec' },
    },
    showlegend: false,
    xaxis: {
      gridcolor: GRID, zerolinecolor: '#283845', linecolor: '#22313d',
      tickcolor: '#22313d', showline: true, ticks: 'outside', ticklen: 3,
      ...(extra.xaxis || {}),
    },
    yaxis: {
      gridcolor: GRID, zerolinecolor: '#283845', linecolor: '#22313d',
      tickcolor: '#22313d', showline: true, ticks: 'outside', ticklen: 3,
      ...(extra.yaxis || {}),
    },
    ...extra,
  }
}

export default function Chart({ data, layout, config, style }) {
  const ref = useRef(null)
  const first = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const cfg = {
      displayModeBar: false,
      responsive: true,
      doubleClick: 'reset',
      ...config,
    }
    if (first.current) {
      Plotly.newPlot(el, data, layout, cfg)
      first.current = false
    } else {
      Plotly.react(el, data, layout, cfg)
    }
  }, [data, layout, config])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (el && el.data) Plotly.Plots.resize(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return <div ref={ref} style={{ width: '100%', height: '100%', ...style }} />
}
