import { Field, Num, Presets, Seg, Toggle } from './Fields'
import { fmt } from '../api'

export default function SweepPanel({
  p, setP, running, progress, onRun, onStop,
  cal, calR, setCalR, calBusy, onCalibrate, onClearCal,
  simulated, demo, setDemo, onCheckSignal, onOpenWiring, busy,
}) {
  const set = (k) => (v) => setP({ ...p, [k]: v })
  const pct = progress ? Math.round((100 * progress.done) / Math.max(progress.total, 1)) : 0

  return (
    <>
      <div className="card">
        <div className="card-title">Frequency sweep</div>

        <div className="row">
          <Field label="start"><Num value={p.f_start} onChange={set('f_start')} suffix="Hz" /></Field>
          <Field label="stop"><Num value={p.f_stop} onChange={set('f_stop')} suffix="Hz" /></Field>
        </div>

        <div className="row">
          <Field label="points">
            <Num value={p.points} onChange={set('points')} step="1" min="2" max="1000" />
          </Field>
          <Field label="spacing">
            <Seg
              value={p.spacing}
              onChange={set('spacing')}
              disabled={running}
              options={[{ value: 'log', label: 'log' }, { value: 'lin', label: 'linear' }]}
            />
          </Field>
        </div>

        <div className="row">
          <Field label="amplitude"><Num value={p.amp_vpp} onChange={set('amp_vpp')} suffix="Vpp" /></Field>
          <Field label="averages">
            <Num value={p.averages} onChange={set('averages')} step="1" min="1" max="64" />
          </Field>
        </div>

        <Field label="reference resistor R_ref">
          <Num value={p.r_ref} onChange={set('r_ref')} suffix="Ω" />
        </Field>
        <Presets
          value={p.r_ref}
          onPick={(v) => setP({ ...p, r_ref: v })}
          disabled={running}
          items={[
            { label: '100 Ω', value: 100 },
            { label: '1 kΩ', value: 1000 },
            { label: '10 kΩ', value: 10000 },
            { label: '100 kΩ', value: 100000 },
          ]}
        />

        <div style={{ height: 9 }} />
        <Toggle label="auto-range inputs" on={p.auto_range} onChange={set('auto_range')} disabled={running} />

        <details className="adv">
          <summary>advanced</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <Field label="settle"><Num value={p.settle_ms} onChange={set('settle_ms')} suffix="ms" /></Field>
            {!p.auto_range && (
              <Field label="range A"><Num value={p.range_a} onChange={set('range_a')} step="1" min="0" max="9" /></Field>
            )}
          </div>
          {!p.auto_range && (
            <div className="row">
              <Field label="range B"><Num value={p.range_b} onChange={set('range_b')} step="1" min="0" max="9" /></Field>
            </div>
          )}
          <div className="hint" style={{ marginTop: 6 }}>
            Excitation is a zero-centred sine, fixed — no DC offset is applied.
          </div>
        </details>
      </div>

      {running ? (
        <button className="btn danger" onClick={onStop}>Stop sweep</button>
      ) : (
        <button className="btn primary" onClick={onRun} disabled={busy}>Run sweep</button>
      )}

      <div className="progress">
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        <div className="meta">
          <span>{progress ? `${progress.done} / ${progress.total} points` : 'idle'}</span>
          <span>{progress ? fmt.eng(progress.f, 'Hz') : ''}</span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          Calibration
          {cal?.active && <span style={{ color: 'var(--green)', fontSize: 9.5 }}>active</span>}
        </div>
        {cal?.active ? (
          <div className="okbox" style={{ marginBottom: 8 }}>
            gain {fmt.num(cal.mag, 4)} ×, {fmt.num(cal.phase_deg, 2)}° from {fmt.eng(cal.r_known, 'Ω')} at {fmt.eng(cal.f, 'Hz')}
          </div>
        ) : (
          <div className="hint" style={{ marginBottom: 8 }}>
            Connect a known resistor as the DUT and calibrate to remove channel-to-channel gain error.
          </div>
        )}
        <div className="row">
          <Field label="known R"><Num value={calR} onChange={setCalR} suffix="Ω" /></Field>
          <button className="btn ghost sm" style={{ alignSelf: 'end', height: 33 }}
                  onClick={() => onCalibrate(Number(calR))}
                  disabled={calBusy || running || busy}>
            {calBusy ? 'measuring…' : 'calibrate'}
          </button>
        </div>
        {cal?.active && (
          <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={onClearCal}>
            clear calibration
          </button>
        )}
      </div>

      {simulated && (
        <div className="card">
          <div className="card-title">Simulated DUT</div>
          <Field label="circuit">
            <select
              value={demo.kind}
              onChange={(e) => setDemo({ ...demo, kind: e.target.value })}
            >
              <option value="rc_parallel">R ∥ C (semicircle)</option>
              <option value="rc_series">R + C series</option>
              <option value="rl_series">R + L series</option>
              <option value="rlc_series">R + L + C series</option>
              <option value="resistor">resistor only</option>
              <option value="capacitor">capacitor only</option>
            </select>
          </Field>
          <div className="row">
            <Field label="R"><Num value={demo.r} onChange={(v) => setDemo({ ...demo, r: v })} suffix="Ω" /></Field>
            <Field label="C"><Num value={demo.c * 1e9} onChange={(v) => setDemo({ ...demo, c: v * 1e-9 })} suffix="nF" /></Field>
          </div>
        </div>
      )}

      <div className="card tight">
        <div className="card-title">Wiring</div>
        <div className="hint" style={{ fontFamily: 'var(--mono)', lineHeight: 1.7 }}>
          AWG → R_ref → DUT → GND<br />
          CH&nbsp;A across DUT&nbsp;·&nbsp;CH&nbsp;B across R_ref + DUT
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button className="btn ghost sm" style={{ flex: 1 }}
                  onClick={onCheckSignal} disabled={running || busy}>
            check signal
          </button>
          <button className="btn ghost sm" style={{ flex: 1 }} onClick={onOpenWiring}>
            how to wire
          </button>
        </div>
      </div>

      <div className="footnote">
        AWG limit 100 kHz · 4 Vpp · 600 Ω source. Keep R_ref within ~10× of |Z| for best
        SNR; phase accuracy degrades when the voltage across R_ref gets small.
      </div>
    </>
  )
}
