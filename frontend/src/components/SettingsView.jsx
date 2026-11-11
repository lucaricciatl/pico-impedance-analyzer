import { useEffect, useState } from 'react'
import { api, fmt } from '../api'

function Row({ k, v, unit, mono = true }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <span className={mono ? 'mono' : ''}>{v}{unit ? ` ${unit}` : ''}</span>
    </div>
  )
}

export default function SettingsView({ onRefresh }) {
  const [s, setS] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setBusy(true)
    try {
      setS(await api.scopeSettings())
      setErr(null)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { load() }, [onRefresh])

  return (
    <>
      <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
        <span className="hint" style={{ marginRight: 'auto' }}>
          everything the driver reports, read from the instrument
        </span>
        <button className="btn ghost sm" onClick={load} disabled={busy}>
          {busy ? 'reading…' : 'refresh'}
        </button>
      </div>

      {err && <div className="errbox">{err}</div>}

      {s && (
        <>
          <div className="wiring-grid">
            <div className="card">
              <div className="card-title">Device</div>
              <Row k="model" v={s.device.model} />
              <Row k="serial" v={s.device.serial} />
              <Row k="mode" v={s.device.kind} />
              <Row k="driver" v={s.device.driver} />
              <Row k="usb" v={s.device.usb} />
              <Row k="hardware" v={s.device.hardware} />
              <Row k="calibration date" v={s.device.cal_date} />
              <Row k="kernel" v={s.device.kernel} />
            </div>

            <div className="card">
              <div className="card-title">Acquisition</div>
              <Row k="mode" v={s.acquisition.mode} />
              <Row k="timebase" v={s.acquisition.timebase ?? '—'} />
              <Row k="sample interval" v={fmt.num(s.acquisition.dt_us, 4)} unit="µs" />
              <Row k="sample rate" v={fmt.num(s.acquisition.sample_rate_msps, 3)} unit="MS/s" />
              <Row k="samples" v={s.acquisition.samples ?? '—'} />
              <Row k="record" v={fmt.num(s.acquisition.record_us, 2)} unit="µs" />
              <Row k="trigger" v={s.acquisition.trigger} />
              <Row k="oversampling" v={s.acquisition.oversampling} />
              <Row k="buffer" v={s.acquisition.max_samples} unit="samples" />
            </div>
          </div>

          <div className="wiring-grid" style={{ marginTop: 12 }}>
            <div className="card">
              <div className="card-title">Channels</div>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>ch</th><th>role</th><th>range</th><th>coupling</th>
                    <th>offset</th><th>bits</th><th>LSB</th>
                  </tr>
                </thead>
                <tbody>
                  {s.channels.map((c) => (
                    <tr key={c.channel}>
                      <td>{c.channel}</td>
                      <td style={{ textAlign: 'left' }}>{c.role}</td>
                      <td>±{fmt.num(c.range_v, 2)} V</td>
                      <td>{c.coupling}</td>
                      <td>{fmt.num(c.offset_v, 2)} V</td>
                      <td>{c.resolution_bits}</td>
                      <td>{fmt.num(c.lsb_uv, 1)} µV</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <div className="card-title">Generator</div>
              <Row k="waveform" v={s.generator.waveform} />
              <Row k="frequency" v={fmt.eng(s.generator.freq_hz, 'Hz')} />
              <Row k="amplitude" v={fmt.num(s.generator.amplitude_vpp, 3)} unit="Vpp" />
              <Row k="offset" v={fmt.num(s.generator.offset_v, 3)} unit="V" />
              <Row k="source impedance" v={`${s.generator.source_impedance_ohm} Ω`} />
              <Row k="sweep" v={s.generator.sweep} />
              <Row k="trigger" v={s.generator.trigger} />
              <Row k="output" v={s.generator.output} />
            </div>
          </div>

          <div className="wiring-grid" style={{ marginTop: 12 }}>
            <div className="card">
              <div className="card-title">Limits</div>
              <Row k="frequency range" v={`${fmt.eng(s.limits.freq_min_hz, 'Hz')} – ${fmt.eng(s.limits.freq_max_hz, 'Hz')}`} />
              <Row k="amplitude range" v={`${fmt.num(s.limits.vpp_min, 3)} – ${fmt.num(s.limits.vpp_max, 1)} Vpp`} />
              <Row k="input ranges" v={s.limits.ranges_v.map((v) => `±${v}`).join(', ') + ' V'} />
            </div>

            <div className="card">
              <div className="card-title">Calibration &amp; app</div>
              <Row k="calibration" v={s.calibration.active
                ? `gain ${fmt.num(s.calibration.mag, 4)}× @ ${fmt.num(s.calibration.phase_deg, 2)}°`
                : 'none (raw)'} />
              <Row k="known resistor" v={s.calibration.r_known ? fmt.eng(s.calibration.r_known, 'Ω') : '—'} />
              <Row k="measured at" v={s.calibration.f ? fmt.eng(s.calibration.f, 'Hz') : '—'} />
              <Row k="build" v={s.app.build} />
              <Row k="server uptime" v={`${Math.round(s.app.uptime_s)} s`} />
              <Row k="instrument busy" v={s.app.busy ? 'yes' : 'no'} />
            </div>
          </div>

          <div className="footnote">
            Ranges shown are the ones currently selected by auto-ranging. Resolution is the ADC
            width (8 bit on the 2204A), and LSB is one least-significant bit at that range —
            the floor of what a single sample can resolve.
          </div>
        </>
      )}
    </>
  )
}
