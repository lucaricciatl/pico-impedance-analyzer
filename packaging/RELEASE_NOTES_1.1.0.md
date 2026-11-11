## PicoScope Impedance Analyzer 1.1.0 — now a real desktop app

The UI is unchanged React. What changed is the shell: this build is an **Electron
application**, so it opens in its own window with its own Dock icon and menu bar
instead of a browser tab.

### What's new

- **Native window.** Launch it like any Mac app — it starts its bundled measurement
  server on a free localhost port, waits for it to answer, then loads the UI. No
  terminal, no browser, no `localhost` URL to remember.
- **Splash while it boots**, because loading numpy and the driver takes a couple of
  seconds and a blank window looks broken.
- **Single instance.** Double-clicking again focuses the running window instead of
  starting a second server that would fight for the scope's exclusive driver handle.
- **Clean shutdown.** The bundled backend is terminated when the app quits, and it
  also exits on its own if the app is force-killed, so no orphan keeps the port or the
  instrument.
- **Downloads work** — exported CSVs and ZIPs go through the normal save dialog.

Everything from 1.0.0 is in here: sweep (Bode magnitude, Bode phase, Nyquist), live
tracking, the Scope page with manual ranges / timebase / trigger / waveform generator
/ bias, the Setup page with every driver parameter, calibration, CSV/ZIP export.

### Install

1. Download the `.dmg` and drag **PicoScope Impedance Analyzer** to Applications.
2. First launch: **right-click → Open** (or
   `xattr -dr com.apple.quarantine "/Applications/PicoScope Impedance Analyzer.app"`).
   The app is ad-hoc signed but not notarised — there is no Apple Developer ID on this
   project — so Gatekeeper blocks a plain double-click exactly once.

### Using the real scope

Install **PicoScope 7** (it provides `libps2000a`), **quit it** — the driver handle is
exclusive — plug in the 2204A, then press **find scope**. Without a scope the app runs
against a built-in simulator with the same node equations, so every page works.

### Notes

- arm64 (Apple Silicon). Intel users: `packaging/build_desktop.sh`.
- 113 MB: Electron plus a frozen Python runtime. The 1.0.0 standalone build is still
  attached to its own release if you prefer the lighter browser-based app.
- The hardware path is implemented against the picosdk ps2000a API but has not been
  exercised on a physical 2204A.
