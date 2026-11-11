import { fmt } from '../api'
import Tex from './Tex'
import { DirectNum } from './Fields'

function Ground({ x, y, s = 1 }) {
  return (
    <g stroke="#5b7285" strokeWidth={1.6 * s} fill="none">
      <line x1={x - 17 * s} y1={y} x2={x + 17 * s} y2={y} />
      <line x1={x - 11 * s} y1={y + 8 * s} x2={x + 11 * s} y2={y + 8 * s} />
      <line x1={x - 5 * s} y1={y + 16 * s} x2={x + 5 * s} y2={y + 16 * s} />
    </g>
  )
}

export function SchematicSeries({ rRef }) {
  const Y = 120
  return (
    <svg viewBox="0 0 860 420" className="schematic" role="img"
         aria-label="Series reference resistor fixture: generator through R_ref into the DUT, channel A across the DUT, channel B at the source node">
      <defs>
        <marker id="arw" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
          <path d="M0,0 L7,3 L0,6 z" fill="#5b7285" />
        </marker>
      </defs>

      {/* generator */}
      <circle cx="80" cy={Y} r="32" fill="#0d151c" stroke="#3d5464" strokeWidth="1.6" />
      <path d="M 60 120 q 10 -16 20 0 t 20 0" fill="none" stroke="#22d3ee"
            strokeWidth="1.9" strokeLinecap="round" />
      <text x="80" y="176" textAnchor="middle" className="sc-l">AWG</text>
      <text x="80" y="191" textAnchor="middle" className="sc-s">0.1–100 kHz</text>

      <line x1="112" y1={Y} x2="196" y2={Y} className="sc-wire" />

      {/* internal source resistance */}
      <rect x="196" y="92" width="104" height="56" rx="5" fill="#0c141a"
            stroke="#3d5464" strokeWidth="1.3" strokeDasharray="6 4" />
      <text x="248" y="116" textAnchor="middle" className="sc-v">600 Ω</text>
      <text x="248" y="133" textAnchor="middle" className="sc-s">internal</text>
      <text x="248" y="168" textAnchor="middle" className="sc-s">inside the generator, cancels</text>

      <line x1="300" y1={Y} x2="386" y2={Y} className="sc-wire" />

      {/* node B — the probe taps the wire mid-span, label sits on the wire beside it */}
      <circle cx="343" cy={Y} r="5.5" fill="#38bdf8" />
      <rect x="306" y="112" width="30" height="16" rx="3" fill="#0e151c" />
      <text x="321" y="124" textAnchor="middle" className="sc-node" fill="#38bdf8">V_B</text>

      {/* R_ref */}
      <rect x="386" y="90" width="140" height="60" rx="7" fill="#101a12"
            stroke="#fbbf24" strokeWidth="1.8" />
      <text x="456" y="114" textAnchor="middle" className="sc-v" fill="#fbbf24">R_ref</text>
      <text x="456" y="136" textAnchor="middle" className="sc-node" fill="#fde68a">
        {fmt.eng(rRef, 'Ω')}
      </text>

      <line x1="526" y1={Y} x2="604" y2={Y} className="sc-wire" />

      {/* node A */}
      <circle cx="565" cy={Y} r="5.5" fill="#a78bfa" />
      <rect x="572" y="112" width="30" height="16" rx="3" fill="#0e151c" />
      <text x="587" y="124" textAnchor="middle" className="sc-node" fill="#a78bfa">V_A</text>

      {/* DUT */}
      <rect x="604" y="90" width="140" height="60" rx="7" fill="#141026"
            stroke="#a78bfa" strokeWidth="1.8" />
      <text x="674" y="114" textAnchor="middle" className="sc-v" fill="#c4b5fd">DUT</text>
      <text x="674" y="136" textAnchor="middle" className="sc-s">Z(f)</text>

      <path d={`M 744 ${Y} L 800 ${Y} L 800 268`} className="sc-wire" fill="none" />
      <Ground x={800} y={268} />
      <text x="828" y="280" textAnchor="middle" className="sc-s">0 V</text>

      {/* current direction */}
      <line x1="752" y1="86" x2="790" y2="86" stroke="#5b7285" strokeWidth="1.2"
            markerEnd="url(#arw)" />
      <text x="771" y="74" textAnchor="middle" className="sc-s">I</text>

      {/* probes — drop from the mid-wire tap, not from the resistor terminals */}
      <line x1="343" y1={Y + 6} x2="343" y2="316" stroke="#38bdf8" strokeWidth="1.4"
            strokeDasharray="5 4" />
      <line x1="565" y1={Y + 6} x2="565" y2="316" stroke="#a78bfa" strokeWidth="1.4"
            strokeDasharray="5 4" />
      <text x="333" y="250" textAnchor="end" className="sc-tag" fill="#38bdf8">CH B</text>
      <text x="575" y="250" textAnchor="start" className="sc-tag" fill="#a78bfa">CH A</text>

      {/* scope */}
      <rect x="300" y="316" width="398" height="64" rx="9" fill="#0b1218"
            stroke="#253644" strokeWidth="1.6" />
      <text x="499" y="342" textAnchor="middle" className="sc-t">PicoScope 2204A</text>
      <text x="499" y="361" textAnchor="middle" className="sc-s">
        CH A across the DUT · CH B across R_ref + DUT
      </text>
      <path d="M 340 380 L 340 392" stroke="#5b7285" strokeWidth="1.6" fill="none" />
      <Ground x={340} y={392} s={0.85} />
      <text x="368" y="402" textAnchor="start" className="sc-s">same ground as the DUT</text>
    </svg>
  )
}

const NOTES = [
  ['Two probes, two nodes',
   'Ch A clips on the DUT terminal, Ch B on the generator side of R_ref. Both are sampled in the same block, so the phase is measured between the channels, not against the generator.'],
  ['One ground',
   'Generator, both probes and the DUT share a single ground point. A floating DUT measures your ground loop instead of the component.'],
  ['Keep R_ref near |Z|',
   'Within a factor of 3 is ideal. Too large and the DUT voltage sinks into the noise floor; too small and the drop across R_ref does.'],
  ['Probe loading is real',
   'Each channel is 1 MΩ ∥ ~15 pF. That is fine for kΩ-range parts, but 15 pF is only 106 kΩ at 100 kHz — for high-impedance samples, correct for it or keep the leads short.'],
  ['Short leads at high frequency',
   'Above ~10 kHz, cable inductance and probe capacitance dominate a poorly built fixture. Twist the signal and ground return together.'],
  ['Amplitude is your SNR knob',
   '1 Vpp is a good default. Raise it for low-impedance parts, lower it if the sample is voltage-sensitive. Over 4 Vpp is not available.'],
]

export default function WiringView({ rRef, setRRef }) {
  return (
    <>
      <div className="wiring-grid">
        <div className="card">
          <div className="card-title">
            <span>Measurement circuit</span>
            <DirectNum label="R_ref" value={rRef} onChange={setRRef} width={96} />
          </div>

          <SchematicSeries rRef={rRef} />

          <div className="eqstrip">
            <Tex block>{String.raw`I=\frac{V_B-V_A}{R_{ref}}`}</Tex>
            <Tex block>{String.raw`Z_{dut}=\frac{R_{ref}\,V_A}{V_B-V_A}`}</Tex>
          </div>

          <div className="legend" style={{ marginTop: 2, paddingLeft: 4, flexWrap: 'wrap' }}>
            <span><i style={{ background: '#fbbf24' }} />reference</span>
            <span><i style={{ background: '#a78bfa' }} />DUT</span>
            <span><i style={{ background: '#38bdf8' }} />CH B</span>
            <span><i style={{ background: '#a78bfa' }} />CH A</span>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Why this works</div>
          <p className="para">
            A single probe cannot separate voltage from current. Putting a reference resistor in
            series turns the measurement into a divider: the voltage across <em>R_ref</em> is the
            current, and two channels give the complex ratio directly.
          </p>
          <p className="para">
            Because Ch B sits after the generator's internal 600 Ω, that resistance lands inside{' '}
            <Tex>{String.raw`V_B`}</Tex> and drops out of the algebra. You never have to know or
            calibrate it.
          </p>
          <p className="para">
            Simultaneous sampling is what makes the phase trustworthy — the generator has no phase
            lock to the ADC, so any single-channel phase reference would drift between captures.
            The A/B difference does not.
          </p>
          <div className="formula">
            <Tex block>{String.raw`Z_{dut}=R_{ref}\,\frac{V_A}{V_B-V_A}`}</Tex>
          </div>
        </div>
      </div>

      <div className="wiring-grid" style={{ marginTop: 12 }}>
        <div className="card">
          <div className="card-title">Procedure</div>
          <ol className="steps">
            <li>Power down. Wire AWG → R_ref → DUT → ground as drawn.</li>
            <li>Clip Ch A on the DUT terminal, Ch B between R_ref and the generator.</li>
            <li>Choose R_ref near the |Z| you expect.</li>
            <li>Close PicoScope 7, plug in the 2204A, press <span className="kbd">find scope</span>.</li>
            <li>Press <span className="kbd">check signal</span> — V_B should be the larger trace.</li>
            <li>If both traces look identical, Ch A is on the wrong node.</li>
            <li>Sweep, then <span className="kbd">save</span> or <span className="kbd">export all</span>.</li>
            <li>Optionally swap in a known resistor and <span className="kbd">calibrate</span>.</li>
          </ol>
        </div>

        <div className="card">
          <div className="card-title">Notes</div>
          <dl className="notes">
            {NOTES.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </>
  )
}
