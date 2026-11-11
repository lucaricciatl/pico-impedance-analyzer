# PicoScope 2204A — Impedance Analyzer

Frequency and impedance analysis with a PicoScope 2204A: Bode (magnitude and phase),
Nyquist, and a continuous live measurement mode. React front end, Python backend,
PicoSDK `ps2000a` driver.

The scope's built-in function generator drives the DUT; Ch A and Ch B sample the two nodes
of a reference-resistor divider in the same acquisition block.

```
   AWG ──[ 600 Ω internal ]──┬─────────── R_ref ──────────┬───────── Z_dut ───────── GND
                             │                            │
                          CH B  (source node)          CH A  (DUT node)
```

Channel A across the DUT, channel B on the source side of R_ref. The current is the drop
across R_ref, so

```
Z_dut = R_ref · V_A / (V_B − V_A)
```

Three consequences worth knowing:

- The AWG's 600 Ω output impedance sits *inside* channel B's node and cancels exactly. It
  does not need to be known.
- Both channels are sampled at the same instants in one block, so the generator having no
  phase lock to the ADC clock is irrelevant — only the A/B phase difference matters.
- Nothing depends on trigger stability. Each capture is analysed on its own, and complex
  Z is averaged across repeats.

## Download

Packaged macOS builds are attached to the [latest release](https://github.com/lucaricciatl/pico-impedance-analyzer/releases/latest):

| build | what it is |
|---|---|
| `PicoScope-Impedance-Analyzer-1.1.0-macos-arm64.dmg` | **desktop app** — Electron window, starts its own server, ~113 MB |
| `PicoScope-Impedance-Analyzer-1.1.0-macos-arm64.zip` | same app, zipped |
| `…1.0.0-macos-arm64.dmg` | older standalone build: frozen Python + opens your browser, 24 MB |

First launch of either: **right-click → Open**, or
`xattr -dr com.apple.quarantine "/Applications/PicoScope Impedance Analyzer.app"` —
both are ad-hoc signed but not notarised (no Apple Developer ID), so Gatekeeper blocks
a plain double-click once.

Rebuild with `packaging/build_desktop.sh` (Electron) or `packaging/build_macos.sh`
(standalone). Both write into `release/`.

## Run

```bash
./run.sh                    # detects hardware, falls back to the simulator
PICO_MODE=hardware ./run.sh # refuse to start without a scope
PORT=8770 ./run.sh
```

Then open http://127.0.0.1:8765. First run creates `.venv` and builds the frontend.

Close PicoScope 7 before connecting — the driver is exclusive and `openUnit` will fail
while it holds the device.

## Wiring notes

The app has a **Wiring** tab with the schematic, a step-by-step procedure and a reference
resistor picker (including an E24 suggestion from the impedance you expect). Use it rather
than this README when you are at the bench.

The fixture is a series reference resistor:

```
Z = R_ref · V_A / (V_B − V_A)
```

Ch A across the DUT, Ch B on the source side of R_ref.

- Keep `R_ref` within roughly 10× of |Z|. Too large and the DUT voltage collapses into the
  ADC noise floor; too small and the drop across R_ref does. The UI shows both the drop
  ratio and a per-point uncertainty so a bad choice is visible rather than silent.
- Probe loading is 1 MΩ ∥ ~15 pF per channel. That is negligible below a few kΩ at
  100 kHz, and **not** negligible for high-impedance DUTs — 15 pF is 106 kΩ at 100 kHz.
- Grounds are common: the AWG, both probes and the DUT must share ground. Do not float the
  DUT or you will measure the ground loop.

## Method

Each frequency point:

1. Set the generator (frequency-only update via `ps2000aSetSigGenPropertiesBuiltIn`, so the
   DAC is not restarted mid-sweep).
2. Wait for settling — at least one period, at least `settle_ms`.
3. Choose the timebase from `ps2000aGetTimebase2` for ~64 samples per cycle, and the sample
   count for ~50 ms of signal (3–64 cycles, capped at 4000 samples; the 2204A has little
   memory).
4. Block capture, auto-range both inputs to the smallest range with 25 % headroom, re-capture.
5. Least-squares fit of `offset + a·cos(ωt) + b·sin(ωt)` per channel. This is exact for any
   record length — no integer-cycle requirement, no window scalloping.
6. Complex-average `Z` over `averages` repeats.

Uncertainty per point is propagated from the fit residuals through the divider ratio, so it
grows correctly when the R_ref drop shrinks.

## Calibration

Auto-ranging puts the two channels on different ranges, and channel-to-channel gain error
(typically 0.1–0.5 % on an 8-bit 2204A) divides straight into |Z|. To remove it:

1. Connect a known resistor (1 kΩ 0.1 % is ideal) as the DUT.
2. Set "known R" and press **calibrate**.

The residual complex ratio is stored in `data/calibration.json` and applied to every
subsequent measurement. Clear it from the UI at any time.

## Limits

| | |
|---|---|
| Generator | 0.1 Hz – 100 kHz, 2 mV – 4 Vpp, 600 Ω source |
| Inputs | ±10 mV … ±20 V ranges, DC coupled, 8-bit |
| Sample memory | 8 kS class — captures capped at 4000 samples/channel |
| Sweep | 2 – 1000 points, log or linear |
| Continuous | ≥ 20 ms interval (a sample is a full block acquisition, so the interval is a floor) |

## API

| | |
|---|---|
| `GET /api/status` | device, busy state |
| `GET /api/limits` | generator and range limits |
| `POST /api/connect` | `{mode: auto\|hardware\|simulated}` |
| `POST /api/sweep` | sweep config → starts a worker |
| `POST /api/sweep/stop` | |
| `POST /api/continuous` | single-frequency tracking |
| `POST /api/continuous/stop` | |
| `POST /api/awg/off` | generator off |
| `GET /api/waveform?f&r_ref` | short two-channel trace for wiring checks |
| `GET/POST/DELETE /api/calibration` | known-resistor correction |
| `GET /api/export.csv` | last sweep as a download |
| `POST /api/export/zip` | one ZIP: `sweep_all.csv`, `bode_magnitude.csv`, `bode_phase.csv`, `nyquist.csv`, `metadata.json`, `README.txt` |
| `POST /api/measurements/save` | write the run to `measurements/` (CSV + JSON, with device, calibration and fixture metadata) |
| `GET /api/measurements` | list saved runs |
| `GET /api/scope/settings` | every driver parameter: device, channels, acquisition, generator, limits |
| `GET /api/scope/trace` | live dual trace + reconstructed AWG EMF. `f`, `amp_vpp`, `r_ref`, `cycles`, `time_div_us` (0 = auto), `nsamples`, `range_a`/`range_b` (volts, 0 = auto), `trig_mode` (off\|auto\|normal), `trig_source` (A\|B), `trig_dir` (rising\|falling), `trig_level` (V), `waveform` (sine\|square\|pulse\|triangle\|ramp_up\|ramp_down\|sinc\|gaussian\|half_sine\|dc\|custom), `duty`, `edge`, `custom` (comma-separated −1…1 points) |
| `WS /ws` | `point`, `continuous`, `stats`, `sweep_done`, `error` |

## Scope page controls

The Scope tab drives the instrument the way the PicoScope software does, with manual
vertical, horizontal and trigger settings:

- **Channels · vertical** — `auto` or a fixed range per channel (10 mV … 20 V full scale).
  A manual range is honoured even when it clips, so the trace is reported as clipped
  instead of being silently rescaled.
- **Timebase · horizontal** — `auto` (N periods on screen) or a fixed time/div;
  the record is always 10 divisions, `range_a`/`range_b` are full-scale ±volts.
- **Trigger** — off / auto / normal, source CH A or CH B, rising or falling, level in volts.
  `auto` uses a 200 ms auto-trigger timeout, `normal` waits indefinitely. On real hardware
  the level is converted to an ADC threshold against that channel's own range.
- **Waveform** — sine, square, pulse, triangle, ramp up/down, sinc, gaussian, half sine, DC,
  and custom (drag one cycle). Built-in shapes go through `ps2000aSetSigGenBuiltIn`; pulse
  and custom are rendered to 256 points and uploaded with `ps2000aSetSigGenArbitrary`, so
  any shape the UI can draw is a shape the generator can output. Square and pulse take a
  duty cycle. Shapes are changeable while the scope is running.

Every shape is centred on zero at upload: a 25 % pulse would otherwise carry a −25 % DC
term baked into the shape itself. On top of that you can add a **bias** in the signal source
card, which is the real generator offset (`ps2000aSetSigGenBuiltIn` offsetVoltage, µV). It is
clamped to ±(2.5 − Vpp/2) because the output can only swing to ±2.5 V, and the applied value
is echoed back in the status line. Sweeps and continuous tracking always program a sine at
0 V bias — the impedance maths is a single-tone fit and it wants one clean tone.

The Z readout on the scope page is derived from the *fundamental* of whatever you generate,
so it stays valid for a non-sine drive or a biased signal on a linear DUT (the tone fit has
a DC term, so bias cannot leak into it). The fit uses a whole number of periods for exactly
that reason: a 25 % pulse over 3.146 periods read 7.8 kΩ where the true value is 8.47 kΩ, and
cropping to 3 whole periods brought every shape back within 0.06 %.

`/api/scope/trace` returns `time_div_us`, `clip_a`/`clip_b`, `range_*_auto`, `lsb_*_uv`
and the echo of the trigger actually applied, so the UI can show what the instrument is
really doing rather than what was requested.

## Files

```
measurements/         saved runs (CSV + JSON), written by the save button
backend/analysis.py   tone fit, impedance algebra, equivalent C/L
backend/scope.py      Ps2000aScope (real) and SimulatedScope (same node equations)
backend/engine.py     measure_point, SweepEngine, ContinuousEngine
backend/main.py       FastAPI app, websocket hub, CSV, calibration
frontend/src/         React UI (Plotly)
tests/test_pipeline.py  recovers known impedances from the simulator
```

## Self-check

```bash
.venv/bin/python -m tests.test_pipeline
```

Recovers four known DUTs from 10 Hz to 100 kHz; worst error is reported and the run fails
loudly if it exceeds 1 %.

## Simulator

With no scope attached the app runs against a simulator that uses the same divider node
equations and 8-bit quantisation, so the UI, sweeps, auto-ranging and plots are all
exercised. Pick the demo circuit in the sidebar (R∥C, R+C, R+L, R+L+C, plain R, plain C).
The header shows a amber "simulated" badge whenever the data is synthetic.

## Troubleshooting

**"No PicoScope on USB"** — check the cable, and close PicoScope 7. `driver_error` in
`/api/status` carries the reason hardware was skipped.

**"PicoSDK ps2000a wrapper not importable"** — `.venv/bin/pip install picosdk`, or point
`PS2000A_LIB_DIR` at the folder holding `libps2000a.dylib` (normally
`/Applications/PicoScope 7 T&M.app/Contents/Resources`, which the backend finds on its own).

**"stream down" in the header** — websocket did not connect; `pip install websockets` into
the venv.

**Phase looks wrong** — channels swapped. A must be on the DUT, B on the source side of
R_ref. Use "check signal": V_B should be the larger, cleaner waveform, and V_A should
collapse as |Z| falls.

**Noisy or clipping** — watch the SNR and ±% columns. Clipping raises "ADC overflow"; reduce
amplitude or let auto-range work. Unhandled tracebacks are written to `/tmp/pico_errors.log`.
