import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, openSocket, fmt } from './api'
import SweepPanel from './components/SweepPanel'
import LivePanel from './components/LivePanel'
import SweepView from './components/SweepView'
import LiveView from './components/LiveView'
import WiringPanel from './components/WiringPanel'
import WiringView from './components/WiringView'
import ScopePanel from './components/ScopePanel'
import ScopeView from './components/ScopeView'
import SettingsView from './components/SettingsView'

const SWEEP_DEFAULTS = {
  f_start: 10,
  f_stop: 100000,
  points: 60,
  spacing: 'log',
  amp_vpp: 1.0,
  r_ref: 1000,
  averages: 3,
  settle_ms: 15,
  auto_range: true,
  range_a: 6,
  range_b: 6,
}

const LIVE_DEFAULTS = {
  freq: 1000,
  interval_ms: 250,
  window: 200,
  amp_vpp: 1.0,
  r_ref: 1000,
  averages: 3,
  settle_ms: 15,
  auto_range: true,
  range_a: 6,
  range_b: 6,
}

function stored(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

export default function App() {
  const [tab, setTab] = useState('sweep')
  const [p, setP] = useState(() => stored('pico.sweep', SWEEP_DEFAULTS))
  const [lp, setLp] = useState(() => stored('pico.live', LIVE_DEFAULTS))
  const [device, setDevice] = useState(null)
  const [driverError, setDriverError] = useState(null)
  const [connected, setConnected] = useState(false)
  const [running, setRunning] = useState(null)        // 'sweep' | 'live' | null
  const [progress, setProgress] = useState(null)
  const [points, setPoints] = useState([])
  const [meta, setMeta] = useState({})
  const [live, setLive] = useState([])
  const [stats, setStats] = useState(null)
  const [trace, setTrace] = useState(null)
  const [cal, setCal] = useState(null)
  const [calR, setCalR] = useState(1000)
  const [calBusy, setCalBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [demo, setDemo] = useState({ kind: 'rc_parallel', r: 10000, c: 10e-9, l: 1e-3 })
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [stale, setStale] = useState(false)
  const [sp, setSp] = useState(() => stored('pico.scope', {
    freq: 1000, cycles: 3, amp_vpp: 1.0, r_ref: 1000,
    time_div_us: 0, nsamples: 4000,
    range_a: 0, range_b: 0,
    trig_mode: 'auto', trig_source: 'B', trig_dir: 'rising', trig_level: 0,
    waveform: 'sine', duty: 0.5, custom: null, bias_v: 0,
  }))
  const [scopeData, setScopeData] = useState(null)
  const [scopeRunning, setScopeRunning] = useState(false)
  const [scopeErr, setScopeErr] = useState(null)
  useEffect(() => {
    if (tab !== 'scope') setScopeRunning(false)
  }, [tab])
  const t0 = useRef(null)
  const build = useRef(null)

  useEffect(() => { localStorage.setItem('pico.sweep', JSON.stringify(p)) }, [p])
  useEffect(() => { localStorage.setItem('pico.live', JSON.stringify(lp)) }, [lp])
  useEffect(() => { localStorage.setItem('pico.scope', JSON.stringify(sp)) }, [sp])

  // Live scope: poll the trace while the Scope tab is open and running.
  useEffect(() => {
    if (tab !== 'scope' || !scopeRunning) return
    let cancelled = false
    const tick = async () => {
      try {
        const d = await api.scopeTrace(sp)
        if (!cancelled) {
          setScopeData(d)
          setScopeErr(null)
        }
      } catch (e) {
        if (!cancelled) setScopeErr(e.message)
      }
    }
    tick()
    const id = setInterval(tick, 350)
    return () => { cancelled = true; clearInterval(id) }
  }, [tab, scopeRunning, sp])

  // A rebuilt frontend cannot hot-swap into an open tab; tell the user instead
  // of leaving them on a stale bundle wondering why controls "don't work".
  useEffect(() => {
    let stop = false
    const check = async () => {
      try {
        const v = await api.version()
        if (build.current === null) build.current = v.build
        else if (v.build !== build.current && !stop) setStale(true)
      } catch { /* server restarting */ }
    }
    check()
    const id = setInterval(check, 15000)
    return () => { stop = true; clearInterval(id) }
  }, [])

  useEffect(() => {
    api.status().then((s) => {
      setDevice(s.device)
      setDriverError(s.driver_error)
    }).catch(() => {})
    api.calibration().then(setCal).catch(() => {})
  }, [])

  const handle = useCallback((msg) => {
    switch (msg.type) {
      case 'hello':
        setDevice(msg.device)
        setDriverError(msg.driver_error)
        if (msg.points?.length) {
          setPoints(msg.points)
          setMeta(msg.meta || {})
        }
        if (msg.running === 'ContinuousEngine') setRunning('live')
        else if (msg.running === 'SweepEngine') setRunning('sweep')
        break
      case 'sweep_start':
        t0.current = performance.now()
        setPoints([])
        setMeta({ f_start: msg.f_start, f_stop: msg.f_stop, r_ref: msg.r_ref })
        setRunning('sweep')
        setProgress({ done: 0, total: msg.total, f: msg.f_start })
        setError(null)
        break
      case 'point':
        setPoints((prev) => [...prev, msg.point])
        setProgress({ done: msg.point.index + 1, total: msg.point.total, f: msg.point.f })
        break
      case 'sweep_done': {
        setRunning(null)
        const secs = msg.elapsed ? msg.elapsed.toFixed(1) : '?'
        setNote(msg.stopped
          ? `sweep stopped after ${msg.completed} points`
          : `sweep complete · ${msg.completed} points in ${secs} s`)
        api.waveform(p.f_start, p.amp_vpp, p.r_ref).then(setTrace).catch(() => {})
        break
      }
      case 'continuous_start':
        setLive([])
        setStats(null)
        setRunning('live')
        setError(null)
        break
      case 'trace':
        setTrace(msg.trace)
        break
      case 'continuous':
        setLive((prev) => {
          const next = [...prev, { t: msg.t, point: msg.point }]
          return next.length > 1200 ? next.slice(next.length - 1200) : next
        })
        setStats(msg.stats)
        break
      case 'continuous_done':
        setRunning(null)
        break
      case 'calibration':
        setCal(msg.cal)
        break
      case 'status':
        setDevice(msg.device)
        break
      case 'error':
        setError(msg.message)
        setRunning(null)
        break
      default:
        break
    }
  }, [p.f_start, p.amp_vpp, p.r_ref])

  useEffect(() => openSocket(handle, () => setConnected(true)), [handle])

  const act = async (fn, label) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e.message || String(e))
    }
  }

  const runSweep = () => act(() => api.startSweep(p))
  const stopSweep = () => act(() => api.stopSweep())
  const startLive = () => act(() => api.startLive(lp))
  const stopLive = () => act(() => api.stopLive())
  const outputOff = () => act(() => api.awgOff())

  const checkSignal = async () => {
    const f = points.length ? points[points.length - 1].f : p.f_start
    setError(null)
    try {
      setTrace(await api.waveform(f, p.amp_vpp, p.r_ref))
    } catch (e) {
      setError(e.message)
    }
  }

  const doCalibrate = async (rKnown) => {
    setCalBusy(true)
    setError(null)
    try {
      const res = await api.calibrate({
        r_known: rKnown,
        freq: points.length ? points[points.length - 1].f : 1000,
        r_ref: p.r_ref,
        averages: 8,
        amp_vpp: p.amp_vpp,
      })
      setCal(res.cal)
      setNote(`calibration stored · gain ${fmt.num(res.cal.mag, 4)}×`)
    } catch (e) {
      setError(e.message)
    } finally {
      setCalBusy(false)
    }
  }

  const clearCal = () => act(async () => setCal((await api.clearCalibration()).cal))

  // One physical resistor sits in the fixture, so R_ref is shared by both modes.
  const setRRef = (v) => {
    setP((prev) => ({ ...prev, r_ref: v }))
    setLp((prev) => ({ ...prev, r_ref: v }))
    setCalR(v)
  }

  const reconnect = async () => {
    setError(null)
    try {
      const r = await api.connect('auto')
      setDevice(r.device)
      setDriverError(r.driver_error || null)
      setPoints([])
      setLive([])
      setStats(null)
      setTrace(null)
      setNote(r.device.kind === 'hardware'
        ? `connected · ${r.device.model} ${r.device.serial}`
        : 'still no scope on USB — running the simulator')
    } catch (e) {
      setError(e.message)
    }
  }

  const applyDemo = (next) => {
    setDemo(next)
    api.setDemo(next).catch((e) => setError(e.message))
  }

  const exportCsv = () => window.open('/api/export.csv', '_blank')

  const downloadZip = async () => {
    setSaving(true)
    setError(null)
    try {
      const { blob, filename } = await api.exportZip({ name: 'sweep', points, meta })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      setNote(`exported ${filename} (${points.length} points, 4 CSVs + metadata)`)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const saveMeasurement = async (pointsToSave, extraMeta) => {
    setSaving(true)
    setError(null)
    try {
      const res = await api.saveMeasurement({
        name: pointsToSave === points ? 'sweep' : 'continuous',
        points: pointsToSave,
        meta: extraMeta,
      })
      setNote(`saved ${res.points} points → ${res.csv}`)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const simulated = device?.kind === 'simulated'

  return (
    <div className="app">
      {stale && (
        <div className="reload-banner" onClick={() => location.reload()}>
          this tab is running an older build — click to reload
        </div>
      )}
      <header>
        <div className="brand">
          <h1>Impedance Analyzer</h1>
          <span>PicoScope 2204A</span>
        </div>

        <div className={`pill`}>
          <i className={`dot ${connected ? (simulated ? 'sim' : 'live') : 'err'}`} />
          {device ? `${device.model}${simulated ? ' · simulated' : ''}` : 'no device'}
        </div>
        {device && !simulated && (
          <div className="pill">{device.serial} · {device.driver}</div>
        )}
        {simulated && (
          <div className="pill" title={driverError || ''}>
            <i className="dot sim" /> demo circuit
          </div>
        )}

        <div className="spacer" />

        <button className="btn ghost sm" onClick={reconnect} title="re-detect the scope on USB">
          {simulated ? 'find scope' : 'reconnect'}
        </button>
        <div className="pill">
          R_ref {fmt.eng(tab === 'sweep' ? p.r_ref : lp.r_ref, 'Ω')}
        </div>
        <div className="pill">{connected ? 'stream linked' : 'stream down'}</div>
        <button className="btn ghost sm" onClick={outputOff} title="turn the generator off">
          output off
        </button>
      </header>

      <div className="body">
        <aside className="scroll-thin">
          <div className="tabs">
            <button className={tab === 'sweep' ? 'on' : ''} onClick={() => setTab('sweep')}>
              Sweep
            </button>
            <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>
              Live
            </button>
            <button className={tab === 'wiring' ? 'on' : ''} onClick={() => setTab('wiring')}>
              Wiring
            </button>
            <button className={tab === 'scope' ? 'on' : ''} onClick={() => setTab('scope')}>
              Scope
            </button>
            <button className={tab === 'setup' ? 'on' : ''} onClick={() => setTab('setup')}>
              Setup
            </button>
          </div>

          {tab === 'scope' ? (
            <ScopePanel
              sp={sp} setSp={setSp}
              running={scopeRunning}
              data={scopeData}
              onStart={() => { setScopeErr(null); setScopeRunning(true) }}
              onStop={() => setScopeRunning(false)}
              busy={!!running}
            />
          ) : tab === 'setup' ? (
            <div className="card">
              <div className="card-title">Instrument setup</div>
              <p className="para">
                Read-only view of every parameter the driver reports: device identity, channel
                ranges and resolution, the current timebase, generator settings and the limits
                of the 2204A.
              </p>
              <p className="para">
                Ranges change by themselves as auto-ranging follows the signal, so re-read after
                a sweep to see where the converter actually landed.
              </p>
            </div>
          ) : tab === 'wiring' ? (
            <WiringPanel rRef={p.r_ref} setRRef={setRRef} disabled={!!running} />
          ) : tab === 'sweep' ? (
            <SweepPanel
              p={p} setP={setP}
              running={running === 'sweep'} progress={progress}
              onRun={runSweep} onStop={stopSweep}
              cal={cal} calR={calR} setCalR={setCalR} calBusy={calBusy}
              onCalibrate={doCalibrate} onClearCal={clearCal}
              simulated={simulated} demo={demo} setDemo={applyDemo}
              onCheckSignal={checkSignal}
              onOpenWiring={() => setTab('wiring')}
              busy={running === 'live'}
            />
          ) : (
            <LivePanel
              p={lp} setP={setLp}
              running={running === 'live'} stats={stats}
              onStart={startLive} onStop={stopLive}
              busy={running === 'sweep'}
            />
          )}

          {!simulated && driverError && (
            <div className="warnbox">{driverError}</div>
          )}
          {error && <div className="errbox">{error}</div>}
          {note && !error && (
            <div className="okbox" onClick={() => setNote(null)} style={{ cursor: 'pointer' }}>
              {note}
            </div>
          )}
        </aside>

        <main className="scroll-thin">
          {tab === 'setup' ? (
            <SettingsView onRefresh={tab} />
          ) : tab === 'scope' ? (
            <ScopeView data={scopeData} error={scopeErr} />
          ) : tab === 'wiring' ? (
            <WiringView rRef={p.r_ref} setRRef={setRRef} />
          ) : tab === 'sweep' ? (
            <SweepView
              points={points}
              trace={trace}
              meta={meta}
              onExport={exportCsv}
              onSave={() => saveMeasurement(points, meta)}
              onExportZip={downloadZip}
              onCheckSignal={checkSignal}
              saving={saving}
            />
          ) : (
            <LiveView
              samples={live}
              stats={stats}
              trace={trace}
              saving={saving}
              onSave={() => saveMeasurement(live.map((s) => s.point), {
                mode: 'continuous', freq: lp.freq, r_ref: lp.r_ref,
                amp_vpp: lp.amp_vpp, averages: lp.averages,
              })}
            />
          )}
        </main>
      </div>
    </div>
  )
}
