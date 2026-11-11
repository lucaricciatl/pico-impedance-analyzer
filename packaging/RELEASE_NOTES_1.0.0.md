## PicoScope Impedance Analyzer 1.0.0 — macOS (Apple Silicon)

Frequency and impedance analysis for the **PicoScope 2204A**, using the scope's own
function generator and its two probes. No extra hardware, no external bridge.

### What it does

- **Frequency sweep** — Bode magnitude, Bode phase and Nyquist, log or linear spacing,
  auto-ranging per point, 0.1 Hz to 100 kHz.
- **Live tracking** — continuous single-frequency impedance at ~5 Hz with strip charts.
- **Scope** — a real oscilloscope page: manual ranges (10 mV … 20 V), manual timebase
  (1 µs … 500 ms/div), trigger (off / auto / normal, source A or B, rising or falling,
  level in volts), waveform generator (sine, square, pulse, triangle, ramp up/down,
  sinc, gaussian, half sine, DC and a draw-your-own arbitrary shape) and DC bias.
- **Setup** — every parameter the driver reports: timebase, sample rate, per-channel
  ADC resolution, generator state, limits, calibration.
- **Export** — CSV, a ZIP with one file per plot, and saved runs with full metadata.

### Install

1. Download `PicoScope-Impedance-Analyzer-1.0.0-macos-arm64.dmg` (or the `.zip`).
2. Drag **PicoScope Impedance Analyzer** into Applications.
3. First launch: **right-click → Open**, or run
   `xattr -dr com.apple.quarantine "/Applications/PicoScope Impedance Analyzer.app"`.
   The build is ad-hoc signed but not notarised (no Apple Developer ID), so Gatekeeper
   blocks a plain double-click the first time. This is expected, not a fault.

The app starts its own server on a free localhost port and opens the UI in your browser.
Nothing to launch by hand, no terminal.

### Using it with the real scope

- Install **PicoScope 7** — it ships the `libps2000a` driver this app loads.
- **Quit PicoScope 7 first**: the driver handle is exclusive, so the app cannot open the
  device while PicoScope holds it.
- Plug in the 2204A and press **find scope** in the header. Until a scope is found the
  app runs against a built-in simulator with identical node equations, so every page is
  usable without hardware.

### Wiring

AWG → R_ref → DUT → ground. CH A clips across the DUT, CH B at the generator side of
R_ref. The Wiring tab draws it and explains why the 600 Ω source impedance cancels.

### Notes

- Verified on Apple Silicon (arm64). Intel users: build from source with
  `packaging/build_macos.sh`.
- The packaged build is **simulator-tested**; the hardware path is implemented against
  the picosdk ps2000a API but was not exercised on a physical 2204A during this release.
- Calibration and saved measurements go to
  `~/Library/Application Support/PicoScope Impedance Analyzer/`.
