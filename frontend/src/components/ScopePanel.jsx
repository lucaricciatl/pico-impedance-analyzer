import { useEffect } from 'react'
import { DirectNum, Num, Seg } from './Fields'
import WaveDraw from './WaveDraw'
import { fmt } from '../api'

const RANGES = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20]
const TIME_DIVS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000,
                   10000, 20000, 50000, 100000, 200000, 500000]

const WAVES = [
  { value: 'sine', label: 'sine' },
  { value: 'square', label: 'square' },
  { value: 'pulse', label: 'pulse' },
  { value: 'triangle', label: 'triangle' },
  { value: 'ramp_up', label: 'ramp ↑' },
  { value: 'ramp_down', label: 'ramp ↓' },
  { value: 'sinc', label: 'sinc' },
  { value: 'gaussian', label: 'gauss' },
  { value: 'half_sine', label: '½ sine' },
  { value: 'dc', label: 'DC' },
  { value: 'custom', label: 'custom' },
]

const vlabel = (v) => (v >= 1 ? String(v) : `${Math.round(v * 1000)}m`)
const tlabel = (us) => (us < 1000 ? `${us}µ` : `${us / 1000}ms`)

function Chips({ items, value, onPick, disabled, autoLabel = 'auto' }) {
  return (
    <div className="chips">
      <button type="button" disabled={disabled}
              className={!value ? 'on' : ''} onClick={() => onPick(0)}>
        {autoLabel}
      </button>
      {items.map((it) => (
        <button key={it.value} type="button" disabled={disabled}
                className={Math.abs(Number(value) - it.value) < 1e-12 ? 'on' : ''}
                onClick={() => onPick(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  )
}

function ChannelRange({ name, role, value, onChange, disabled }) {
  return (
    <div className="chan-block">
      <div className="chan-head">
        <span className={`chan-dot ${name === 'A' ? 'a' : 'b'}`} />
        <b>CH {name}</b>
        <span className="chan-role">{role}</span>
        <span className="chan-now">{value ? `±${vlabel(value)} V`.replace('m V', ' mV') : 'auto'}</span>
      </div>
      <Chips
        items={RANGES.map((v) => ({ value: v, label: vlabel(v) }))}
        value={value}
        onPick={onChange}
        disabled={disabled}
      />
    </div>
  )
}

export default function ScopePanel({ sp, setSp, running, onStart, onStop, busy, data }) {
  // functional form: two controls clicked in quick succession must not clobber
  // each other with a stale copy of sp
  const set = (k, v) => setSp((cur) => ({ ...cur, [k]: v }))
  const trigOff = sp.trig_mode === 'off'

  // the output can only swing to ±2.5 V, so bias headroom shrinks with amplitude
  const biasLimit = Math.max(0, 2.5 - (sp.amp_vpp || 0) / 2)
  useEffect(() => {
    const b = Number(sp.bias_v) || 0
    const clamped = Math.max(-biasLimit, Math.min(biasLimit, b))
    if (Math.abs(clamped - b) > 1e-9) set('bias_v', clamped)
  }, [sp.amp_vpp, sp.bias_v, biasLimit])

  return (
    <>
      <div className="card">
        <div className="card-title">Signal source</div>
        <div className="field">
          <label>frequency</label>
          <DirectNum value={sp.freq} onChange={(v) => set('freq', v)} width="100%" suffix="Hz"
                     disabled={running} />
        </div>
        <div className="presets">
          {[100, 1000, 10000, 100000].map((v) => (
            <button key={v} type="button" disabled={running}
                    className={Math.abs(sp.freq - v) < 1e-9 ? 'on' : ''}
                    onClick={() => set('freq', v)}>
              {fmt.eng(v, 'Hz')}
            </button>
          ))}
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>amplitude</label>
          <DirectNum value={sp.amp_vpp} onChange={(v) => set('amp_vpp', v)} width="100%"
                     suffix="Vpp" disabled={running} />
        </div>
        <div className="field">
          <label>bias</label>
          <Num value={sp.bias_v ?? 0}
               onChange={(v) => set('bias_v', v)}
               clamp={(v) => Math.max(-biasLimit, Math.min(biasLimit, v))}
               suffix="V" step={0.1} />
        </div>
        <div className="hint">
          ±{biasLimit.toFixed(2)} V available at this amplitude
          (the output swings to ±2.5 V). Sweeps and tracking always use 0 V bias.
        </div>
        <div className="field">
          <label>R_ref in the fixture</label>
          <DirectNum value={sp.r_ref} onChange={(v) => set('r_ref', v)} width="100%" suffix="Ω"
                     disabled={running} />
        </div>
      </div>

      <div className="card">
        <div className="card-title">Waveform</div>
        {/* live: the generator is re-programmed on every capture, so you can
            change shape while the scope is running and watch it respond */}
        <div className="chips">
          {WAVES.map((w) => (
            <button key={w.value} type="button"
                    className={sp.waveform === w.value ? 'on' : ''}
                    onClick={() => set('waveform', w.value)}>
              {w.label}
            </button>
          ))}
        </div>

        {(sp.waveform === 'square' || sp.waveform === 'pulse') && (
          <div className="field" style={{ marginTop: 8 }}>
            <label>duty cycle</label>
            <DirectNum value={Math.round((sp.duty ?? 0.5) * 100)}
                       onChange={(v) => set('duty', v / 100)}
                       width="100%" suffix="%" min={2} />
          </div>
        )}

        {sp.waveform === 'custom' && (
          <div style={{ marginTop: 8 }}>
            <WaveDraw value={sp.custom} onChange={(v) => set('custom', v)} />
            <div className="hint" style={{ marginTop: 6 }}>
              drag one cycle · left edge is t = 0 · top is +1
            </div>
          </div>
        )}

        <div className="hint" style={{ marginTop: 8 }}>
          pulse and custom are uploaded as an arbitrary buffer (256 points). Any shape is
          centred on zero — the generator offset stays at 0. Sweeps always use a sine.
        </div>
      </div>

      <div className="card">
        <div className="card-title">Channels · vertical</div>
        <ChannelRange name="A" role="DUT" value={sp.range_a}
                      onChange={(v) => set('range_a', v)} disabled={running} />
        <ChannelRange name="B" role="source" value={sp.range_b}
                      onChange={(v) => set('range_b', v)} disabled={running} />
        <div className="hint">A manual range is honoured even if the trace clips.</div>
      </div>

      <div className="card">
        <div className="card-title">Timebase · horizontal</div>
        <Chips
          items={TIME_DIVS.map((v) => ({ value: v, label: tlabel(v) }))}
          value={sp.time_div_us}
          onPick={(v) => set('time_div_us', v)}
          disabled={running}
          autoLabel="auto"
        />
        {sp.time_div_us ? (
          <div className="hint" style={{ marginTop: 8 }}>
            10 divisions × {fmt.eng(sp.time_div_us * 1e-6, 's')} = {fmt.eng(sp.time_div_us * 1e-5, 's')} on screen
          </div>
        ) : (
          <div className="field" style={{ marginTop: 8 }}>
            <label>periods on screen</label>
            <DirectNum value={sp.cycles} onChange={(v) => set('cycles', v)} width="100%"
                       suffix="cycles" min={1} disabled={running} />
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Trigger</div>
        <Seg
          options={[{ value: 'off', label: 'off' }, { value: 'auto', label: 'auto' },
                    { value: 'normal', label: 'normal' }]}
          value={sp.trig_mode}
          onChange={(v) => set('trig_mode', v)}
          disabled={running}
          cols={3}
        />
        {!trigOff && (
          <>
            <div className="field" style={{ marginTop: 10 }}>
              <label>source</label>
              <Seg
                options={[{ value: 'B', label: 'CH B · source' }, { value: 'A', label: 'CH A · DUT' }]}
                value={sp.trig_source}
                onChange={(v) => set('trig_source', v)}
                disabled={running}
              />
            </div>
            <div className="field">
              <label>slope</label>
              <Seg
                options={[{ value: 'rising', label: 'rising' }, { value: 'falling', label: 'falling' }]}
                value={sp.trig_dir}
                onChange={(v) => set('trig_dir', v)}
                disabled={running}
              />
            </div>
            <div className="field">
              <label>level</label>
              <Num value={sp.trig_level} onChange={(v) => set('trig_level', v)}
                   suffix="V" step={0.05} disabled={running} />
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              Auto fires after ~200 ms even without a crossing; normal waits for the edge.
            </div>
          </>
        )}
      </div>

      <div className="footnote">
        The scope shares the generator and both input channels with the measurement modes, so
        only one of them can drive the instrument at a time.
      </div>

      <div className="dock">
        {running ? (
          <button className="btn danger" onClick={onStop}>Hold</button>
        ) : (
          <button className="btn primary" onClick={onStart} disabled={busy}>Run</button>
        )}

        {busy && (
          <div className="warnbox" style={{ marginTop: 8 }}>
            A sweep or continuous run owns the instrument. Stop it to use the scope.
          </div>
        )}
      </div>
    </>
  )
}
