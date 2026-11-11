import { StripChart, ScopeTraces } from './Plots'
import { fmt } from '../api'

export default function LiveView({ samples, stats, trace, onSave, saving }) {
  const last = samples.length ? samples[samples.length - 1].point : null
  const eq = last
    ? last.c_equiv
      ? `${fmt.eng(last.c_equiv, 'F')}`
      : last.l_equiv
      ? `${fmt.eng(last.l_equiv, 'H')}`
      : '—'
    : '—'

  return (
    <>
      <div className="readouts">
        <div className="readout">
          <div className="k">|Z| live</div>
          <div className="v c-cyan">{last ? fmt.num(last.mag, 2) : '—'}<small>Ω</small></div>
          <div className="sub">{last ? fmt.eng(last.mag, 'Ω') : 'not running'}</div>
        </div>
        <div className="readout">
          <div className="k">phase</div>
          <div className="v c-amber">{last ? fmt.num(last.phase_deg, 2) : '—'}<small>°</small></div>
          <div className="sub">{stats ? `σ ${fmt.num(stats.phase_std, 3)}°` : ''}</div>
        </div>
        <div className="readout">
          <div className="k">Re / Im</div>
          <div className="v c-violet" style={{ fontSize: 17 }}>{last ? fmt.num(last.z_re, 1) : '—'}</div>
          <div className="sub">{last ? `Im ${fmt.eng(last.z_im, 'Ω')}` : ''}</div>
        </div>
        <div className="readout">
          <div className="k">equivalent</div>
          <div className="v c-green" style={{ fontSize: 17 }}>{eq}</div>
          <div className="sub">{last ? `I ${fmt.eng(last.i_rms, 'A')}` : ''}</div>
        </div>
        <div className="readout">
          <div className="k">quality</div>
          <div className={`v ${last && last.snr_db < 30 ? 'c-amber' : 'c-green'}`} style={{ fontSize: 17 }}>
            {last ? fmt.num(last.snr_db, 1) : '—'}<small>dB</small>
          </div>
          <div className="sub">{last ? `±${fmt.num(last.uncertainty_pct, 2)}%` : ''}</div>
        </div>
      </div>

      <div className="toolbar" style={{ justifyContent: 'flex-end', marginTop: -2 }}>
        <span className="hint" style={{ marginRight: 'auto' }}>
          {samples.length ? `${samples.length} samples buffered` : 'no samples yet'}
        </span>
        <button className="btn ghost sm" onClick={onSave} disabled={saving || !samples.length}>
          {saving ? 'saving…' : 'save buffer'}
        </button>
      </div>

      <div className="charts" style={{ gridTemplateRows: '1fr 1fr', minHeight: 460 }}>
        <div className="chart-card">
          <div className="chart-head">
            <h3>|Z| drift</h3>
            <span className="axis">{samples.length} samples</span>
          </div>
          <div className="chart-body">
            <StripChart samples={samples} field="mag" unit="Ω" color="#22d3ee" />
          </div>
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <h3>phase drift</h3>
            <span className="axis">degrees</span>
          </div>
          <div className="chart-body">
            <StripChart samples={samples} field="phase_deg" unit="°" color="#fbbf24" />
          </div>
        </div>
        <div className="chart-card" style={{ gridColumn: '1 / span 2' }}>
          <div className="chart-head">
            <h3>Signal</h3>
            <span className="axis">
              {trace ? `${fmt.eng(trace.f, 'Hz')} · A ${trace.range_a} V · B ${trace.range_b} V` : 'press check signal'}
            </span>
          </div>
          <div className="chart-body"><ScopeTraces trace={trace} /></div>
        </div>
      </div>
    </>
  )
}
