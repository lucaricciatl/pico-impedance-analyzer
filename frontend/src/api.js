const base = ''

async function req(path, opts = {}) {
  const res = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { detail: text } }
  if (!res.ok) throw new Error(body?.detail || `${res.status} ${res.statusText}`)
  return body
}

export const api = {
  status: () => req('/api/status'),
  version: () => req('/api/version'),
  connect: (mode = 'auto') => req('/api/connect', { method: 'POST', body: JSON.stringify({ mode }) }),
  limits: () => req('/api/limits'),
  startSweep: (cfg) => req('/api/sweep', { method: 'POST', body: JSON.stringify(cfg) }),
  stopSweep: () => req('/api/sweep/stop', { method: 'POST' }),
  startLive: (cfg) => req('/api/continuous', { method: 'POST', body: JSON.stringify(cfg) }),
  stopLive: () => req('/api/continuous/stop', { method: 'POST' }),
  awgOff: () => req('/api/awg/off', { method: 'POST' }),
  setDemo: (cfg) => req('/api/demo', { method: 'POST', body: JSON.stringify(cfg) }),
  calibration: () => req('/api/calibration'),
  calibrate: (cfg) => req('/api/calibration', { method: 'POST', body: JSON.stringify(cfg) }),
  clearCalibration: () => req('/api/calibration', { method: 'DELETE' }),
  waveform: (f, amp, rRef) =>
    req(`/api/waveform?f=${f}&amp_vpp=${amp}&r_ref=${rRef}`),
  sweep: () => req('/api/sweep'),
  saveMeasurement: (payload) =>
    req('/api/measurements/save', { method: 'POST', body: JSON.stringify(payload) }),
  measurements: () => req('/api/measurements'),
  scopeSettings: () => req('/api/scope/settings'),
  scopeTrace: (p) => {
    const q = new URLSearchParams({
      f: p.freq,
      amp_vpp: p.amp_vpp,
      r_ref: p.r_ref,
      cycles: p.cycles,
      points: 700,
      time_div_us: p.time_div_us || 0,
      nsamples: p.nsamples || 0,
      range_a: p.range_a || 0,
      range_b: p.range_b || 0,
      trig_mode: p.trig_mode || 'auto',
      trig_source: p.trig_source || 'B',
      trig_dir: p.trig_dir || 'rising',
      trig_level: p.trig_level ?? 0,
      waveform: p.waveform || 'sine',
      duty: p.duty ?? 0.5,
      edge: p.edge ?? 0.02,
      bias_v: p.bias_v ?? 0,
    })
    if (p.waveform === 'custom' && Array.isArray(p.custom) && p.custom.length) {
      q.set('custom', p.custom.map((v) => Number(v).toFixed(3)).join(','))
    }
    return req(`/api/scope/trace?${q.toString()}`)
  },

  exportZip: async (payload) => {
    const res = await fetch('/api/export/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const text = await res.text()
      let msg = text
      try { msg = JSON.parse(text).detail || text } catch { /* keep raw */ }
      throw new Error(msg || `${res.status} ${res.statusText}`)
    }
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') || ''
    const m = /filename="([^"]+)"/.exec(cd)
    return { blob, filename: m ? m[1] : 'impedance_sweep.zip' }
  },
}

export function openSocket(onMessage, onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${location.host}/ws`
  let ws = null
  let closed = false
  let retry = 0

  const connect = () => {
    ws = new WebSocket(url)
    ws.onopen = () => {
      retry = 0
      onOpen?.()
    }
    ws.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)) } catch (e) { console.error(e) }
    }
    ws.onclose = () => {
      if (closed) return
      retry = Math.min(retry + 1, 6)
      setTimeout(connect, 300 * retry)
    }
    ws.onerror = () => ws?.close()
  }
  connect()
  return () => { closed = true; ws?.close() }
}

export const fmt = {
  eng(v, unit = '', digits = 3) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—'
    if (v === 0) return `0 ${unit}`
    const a = Math.abs(v)
    const prefix = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']]
    for (const [scale, sym] of prefix) {
      if (a >= scale * 0.999) {
        const n = v / scale
        const d = Math.abs(n) >= 100 ? 1 : Math.abs(n) >= 10 ? 2 : digits
        return `${n.toFixed(d)} ${sym}${unit}`
      }
    }
    return `${v.toExponential(2)} ${unit}`
  },
  num(v, d = 3) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—'
    return Number(v).toFixed(d)
  },
}
