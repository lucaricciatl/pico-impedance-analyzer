import { Field, Num, Presets } from './Fields'
import { fmt } from '../api'

export default function LivePanel({ p, setP, running, onStart, onStop, stats, busy }) {
  const set = (k) => (v) => setP({ ...p, [k]: v })

  return (
    <>
      <div className="card">
        <div className="card-title">Continuous measurement</div>

        <Field label="test frequency">
          <Num value={p.freq} onChange={set('freq')} suffix="Hz" />
        </Field>
        <Presets
          value={p.freq}
          onPick={(v) => setP({ ...p, freq: v })}
          disabled={running}
          items={[
            { label: '100', value: 100 },
            { label: '1 k', value: 1000 },
            { label: '10 k', value: 10000 },
            { label: '100 k', value: 100000 },
          ]}
        />

        <div className="row" style={{ marginTop: 9 }}>
          <Field label="interval"><Num value={p.interval_ms} onChange={set('interval_ms')} suffix="ms" /></Field>
          <Field label="averages"><Num value={p.averages} onChange={set('averages')} step="1" min="1" max="64" /></Field>
        </div>

        <div className="row">
          <Field label="amplitude"><Num value={p.amp_vpp} onChange={set('amp_vpp')} suffix="Vpp" /></Field>
          <Field label="R_ref"><Num value={p.r_ref} onChange={set('r_ref')} suffix="Ω" /></Field>
        </div>

        <Field label="stats window">
          <Num value={p.window} onChange={set('window')} step="1" min="10" max="5000" />
        </Field>
      </div>

      {running ? (
        <button className="btn danger" onClick={onStop}>Stop</button>
      ) : (
        <button className="btn primary" onClick={onStart} disabled={busy}>Start tracking</button>
      )}

      {stats && (
        <div className="card">
          <div className="card-title">Window statistics · {stats.n} pts</div>
          <div className="kv"><span>|Z| mean</span><span>{fmt.eng(stats.mag_mean, 'Ω')}</span></div>
          <div className="kv"><span>|Z| σ</span><span>{fmt.eng(stats.mag_std, 'Ω')}</span></div>
          <div className="kv"><span>|Z| min / max</span>
            <span>{fmt.eng(stats.mag_min, 'Ω')} / {fmt.eng(stats.mag_max, 'Ω')}</span></div>
          <div className="kv"><span>φ mean</span><span>{fmt.num(stats.phase_mean, 2)}°</span></div>
          <div className="kv"><span>φ σ</span><span>{fmt.num(stats.phase_std, 3)}°</span></div>
          <div className="kv"><span>Re mean</span><span>{fmt.eng(stats.re_mean, 'Ω')}</span></div>
          <div className="kv"><span>Im mean</span><span>{fmt.eng(stats.im_mean, 'Ω')}</span></div>
        </div>
      )}

      <div className="footnote">
        Each sample is a full block acquisition with its own averaging, so the interval is a
        floor, not a guarantee. Useful for drift, self-heating and settling tests.
      </div>
    </>
  )
}
