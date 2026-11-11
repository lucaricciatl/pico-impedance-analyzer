"""FastAPI server: REST control + WebSocket stream for the React UI."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import math
import os
import re
import threading
import zipfile
from datetime import datetime
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

import numpy as np

from .analysis import fit_tone, impedance_from_tones
from .engine import (ContinuousConfig, ContinuousEngine, PointConfig,
                     SAMPLES_PER_CYCLE, SweepConfig, SweepEngine, measure_point)
from .scope import RANGE_TABLE, MAX_RANGE_INDEX, WAVEFORMS, describe_trigger, range_index
from .scope import AWG_SOURCE_Z, DeviceManager, ScopeError

ROOT = Path(__file__).resolve().parent.parent
# both overridable so the frozen bundle can point at its unpacked UI and at a
# writable Application Support folder instead of the read-only app bundle
DIST = Path(os.environ.get("APP_DIST") or (ROOT / "frontend" / "dist")).expanduser()
DATA_DIR = Path(os.environ.get("APP_DATA_DIR") or (ROOT / "data")).expanduser()

DEVICE_MODE = os.environ.get("PICO_MODE", "auto")   # auto | hardware | simulated


class Hub:
    """Fan-out of engine events to every connected websocket."""

    def __init__(self) -> None:
        self.clients: set[asyncio.Queue] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def publish(self, message: dict) -> None:
        """Thread-safe."""
        if self.loop is None:
            return
        with self._lock:
            targets = list(self.clients)
        for q in targets:
            try:
                self.loop.call_soon_threadsafe(q.put_nowait, message)
            except RuntimeError:
                pass

    def register(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        with self._lock:
            self.clients.add(q)
        return q

    def unregister(self, q: asyncio.Queue) -> None:
        with self._lock:
            self.clients.discard(q)


hub = Hub()
devices = DeviceManager()
CAL_PATH = DATA_DIR / "calibration.json"
DATA_DIR.mkdir(parents=True, exist_ok=True)
state = {
    "engine": None,
    "kind": None,
    "sweep": [],          # last completed sweep
    "sweep_meta": {},
    "started_at": None,
    "cal": complex(1.0, 0.0),
    "cal_meta": {"r_known": None, "f": None},
}


def _load_calibration() -> None:
    try:
        import json
        raw = json.loads(CAL_PATH.read_text())
        state["cal"] = complex(float(raw["re"]), float(raw["im"]))
        state["cal_meta"] = {"r_known": raw.get("r_known"), "f": raw.get("f")}
    except Exception:
        state["cal"] = complex(1.0, 0.0)
        state["cal_meta"] = {"r_known": None, "f": None}


def _save_calibration(z: complex, r_known: float, f: float) -> None:
    import json
    CAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    CAL_PATH.write_text(json.dumps({"re": z.real, "im": z.imag,
                                    "r_known": r_known, "f": f}, indent=2))
    state["cal"] = z
    state["cal_meta"] = {"r_known": r_known, "f": f}


@asynccontextmanager
async def lifespan(app: FastAPI):
    hub.attach_loop(asyncio.get_running_loop())
    state["started_at"] = time.time()
    _load_calibration()
    try:
        devices.connect(DEVICE_MODE)
    except ScopeError as exc:
        state["error"] = str(exc)
    yield
    stop_running()
    devices.close()


app = FastAPI(title="PicoScope Impedance Analyzer", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_unhandled(request, call_next):
    """Keep full tracebacks on disk: uvicorn's console log is truncated in capture."""
    try:
        return await call_next(request)
    except Exception:
        import traceback
        with open("/tmp/pico_errors.log", "a") as fh:
            fh.write("\n=== %s %s\n%s\n" % (request.method, request.url.path,
                                           traceback.format_exc()))
        raise


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class SweepRequest(BaseModel):
    # The excitation is a zero-centred sine by design; there is no offset knob.
    f_start: float = Field(10.0, gt=0)
    f_stop: float = Field(100_000.0, gt=0)
    points: int = Field(60, ge=2, le=1000)
    spacing: Literal["log", "lin"] = "log"
    amp_vpp: float = Field(1.0, gt=0, le=4)
    r_ref: float = Field(1000.0, gt=0)
    averages: int = Field(3, ge=1, le=64)
    settle_ms: float = Field(15.0, ge=0, le=2000)
    auto_range: bool = True
    range_a: int = Field(6, ge=0, le=9)
    range_b: int = Field(6, ge=0, le=9)


class ContinuousRequest(BaseModel):
    freq: float = Field(1000.0, gt=0, le=100_000)
    interval_ms: float = Field(250.0, ge=20, le=10_000)
    window: int = Field(200, ge=10, le=5000)
    amp_vpp: float = Field(1.0, gt=0, le=4)
    r_ref: float = Field(1000.0, gt=0)
    averages: int = Field(3, ge=1, le=64)
    settle_ms: float = Field(15.0, ge=0, le=2000)
    auto_range: bool = True
    range_a: int = Field(6, ge=0, le=9)
    range_b: int = Field(6, ge=0, le=9)


class ConnectRequest(BaseModel):
    mode: Literal["auto", "hardware", "simulated"] = "auto"


class DemoRequest(BaseModel):
    kind: Literal["rc_parallel", "rc_series", "rl_series", "rlc_series",
                  "resistor", "capacitor"] = "rc_parallel"
    r: float = Field(10_000.0, gt=0)
    c: float = Field(10e-9, gt=0)
    l: float = Field(1e-3, gt=0)


class SaveRequest(BaseModel):
    name: str | None = None
    points: list[dict] | None = None
    meta: dict | None = None


class CalibrateRequest(BaseModel):
    r_known: float = Field(1000.0, gt=0)
    freq: float = Field(1000.0, gt=0, le=100_000)
    r_ref: float = Field(1000.0, gt=0)
    averages: int = Field(8, ge=1, le=64)
    amp_vpp: float = Field(1.0, gt=0, le=4)


# ---------------------------------------------------------------------------
# Run control
# ---------------------------------------------------------------------------

def _publish(msg: dict) -> None:
    run_id = msg.get("run_id")
    # Anything from a superseded run is dropped: a thread that is still finishing
    # its last capture must not append points to the new sweep.
    if run_id is not None and run_id != state.get("run_id"):
        return
    if msg.get("type") == "point":
        state["sweep"].append(msg["point"])
    if msg.get("type") in ("sweep_done", "continuous_done"):
        if run_id == state.get("run_id"):
            state["engine"] = None
            state["kind"] = None
    hub.publish(msg)


def stop_running(wait: bool = True) -> None:
    engine = state.get("engine")
    if engine is not None:
        engine.stop()
        if engine.is_alive() and wait:
            engine.join(timeout=6.0)
    state["engine"] = None
    state["kind"] = None
    state["run_id"] = None


def _start(engine) -> None:
    stop_running()
    state["engine"] = engine
    state["kind"] = engine.__class__.__name__
    state["run_id"] = engine.run_id
    if isinstance(engine, SweepEngine):
        state["sweep"] = []
        state["sweep_meta"] = {
            "f_start": engine.cfg.f_start, "f_stop": engine.cfg.f_stop,
            "points": engine.cfg.points, "spacing": engine.cfg.spacing,
            "r_ref": engine.cfg.r_ref, "amp_vpp": engine.cfg.amp_vpp,
            "averages": engine.cfg.averages,
        }
    engine.start()


def _require_device():
    if devices.scope is None:
        devices.connect(DEVICE_MODE)
    if devices.scope is None:
        raise HTTPException(status_code=503, detail="no PicoScope available")
    return devices.scope


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------

@app.get("/api/status")
def status():
    info = devices.info
    return {
        "device": info.as_dict() if info else None,
        "driver_error": devices.last_error or None,
        "busy": state["engine"] is not None and state["engine"].is_alive(),
        "running": state["kind"],
        "awg_source_z": AWG_SOURCE_Z,
        "points": len(state["sweep"]),
    }


@app.get("/api/limits")
def limits():
    return {
        "awg_max_freq": 100_000.0,
        "awg_min_freq": 0.1,
        "awg_max_vpp": 4.0,
        "awg_min_vpp": 0.002,
        "max_points": 1000,
        "ranges": [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0],
    }


@app.post("/api/connect")
def connect(req: ConnectRequest):
    stop_running()
    devices.close()
    try:
        info = devices.connect(req.mode)
    except ScopeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    hub.publish({"type": "status", "device": info.as_dict()})
    return {"device": info.as_dict(), "driver_error": devices.last_error or None}


@app.post("/api/sweep")
def start_sweep(req: SweepRequest):
    scope = _require_device()
    cfg = SweepConfig(**req.model_dump())
    try:
        cfg.frequencies()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    _start(SweepEngine(scope, _publish, cfg, state["cal"]))
    return {"ok": True}


@app.post("/api/sweep/stop")
def stop_sweep():
    stop_running()
    return {"ok": True}


@app.post("/api/continuous")
def start_continuous(req: ContinuousRequest):
    scope = _require_device()
    cfg = ContinuousConfig(**req.model_dump())
    try:
        trace = _trace_payload(scope, cfg.freq, cfg.amp_vpp, cfg.r_ref)
        hub.publish({"type": "trace", "trace": trace})
    except ScopeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    _start(ContinuousEngine(scope, _publish, cfg, state["cal"]))
    return {"ok": True}


@app.post("/api/continuous/stop")
def stop_continuous():
    stop_running()
    return {"ok": True}


@app.post("/api/awg/off")
def awg_off():
    stop_running()
    if devices.scope is not None:
        devices.scope.output_off()
    return {"ok": True}


@app.post("/api/demo")
def set_demo(req: DemoRequest):
    scope = devices.scope
    if scope is None or getattr(scope, "kind", "") != "simulated":
        raise HTTPException(status_code=400, detail="not in simulator mode")
    scope.dut = {"kind": req.kind, "r": req.r, "c": req.c, "l": req.l}
    return {"ok": True, "dut": scope.dut}


def _cal_payload() -> dict:
    cal = state["cal"]
    return {
        "re": cal.real,
        "im": cal.imag,
        "mag": abs(cal),
        "phase_deg": math.degrees(math.atan2(cal.imag, cal.real)),
        "active": cal != complex(1.0, 0.0),
        "r_known": state["cal_meta"].get("r_known"),
        "f": state["cal_meta"].get("f"),
    }


@app.get("/api/calibration")
def get_calibration():
    return _cal_payload()


@app.post("/api/calibration")
def calibrate(req: CalibrateRequest):
    """Connect a known resistor as the DUT; correct residual channel mismatch."""
    scope = _require_device()
    if state["engine"] is not None and state["engine"].is_alive():
        raise HTTPException(status_code=409, detail="stop the running measurement first")
    cfg = PointConfig(r_ref=req.r_ref, averages=req.averages, amp_vpp=req.amp_vpp,
                      auto_range=True)
    try:
        point = measure_point(scope, req.freq, cfg)
    except ScopeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    z_raw = complex(point["z_re"], point["z_im"])
    if abs(z_raw) < 1e-6:
        raise HTTPException(status_code=400, detail="no signal — check the wiring")
    cal = complex(req.r_known, 0.0) / z_raw
    _save_calibration(cal, req.r_known, req.freq)
    hub.publish({"type": "calibration", "cal": _cal_payload()})
    return {"cal": _cal_payload(), "raw": {"re": z_raw.real, "im": z_raw.imag}}


@app.delete("/api/calibration")
def clear_calibration():
    _save_calibration(complex(1.0, 0.0), None, None)
    return {"cal": _cal_payload()}


@app.get("/api/waveform")
def waveform(f: float = 1000.0, amp_vpp: float = 1.0, r_ref: float = 1000.0):
    """A short trace of both nodes, for wiring checks."""
    scope = _require_device()
    if state["engine"] is not None and state["engine"].is_alive():
        raise HTTPException(status_code=409, detail="busy")
    try:
        return _trace_payload(scope, f, amp_vpp, r_ref)
    except ScopeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _trace_payload(scope, f: float, amp_vpp: float, r_ref: float) -> dict:
    f = float(min(max(f, 0.1), 100_000.0))
    if hasattr(scope, "r_ref"):
        scope.r_ref = r_ref
    scope.set_awg(f, amp_vpp)
    time.sleep(max(0.02, min(0.2, 1.0 / f)))
    n = 1500
    va, vb, dt = scope.acquire(f, 1.0 / (f * 500), n)
    ra, rb = scope.ranges
    max_adc = getattr(scope, "max_adc", 32767)
    va_v = va.astype(float) * (ra / max_adc)
    vb_v = vb.astype(float) * (rb / max_adc)
    step = max(1, len(va_v) // 600)
    return {
        "f": f,
        "t_ms": [i * dt * 1000.0 for i in range(0, len(va_v), step)],
        "va": va_v[::step].tolist(),
        "vb": vb_v[::step].tolist(),
        "range_a": ra, "range_b": rb,
        "clipped": bool(abs(va_v).max() >= ra * 0.99 or abs(vb_v).max() >= rb * 0.99),
    }


@app.get("/api/sweep")
def get_sweep():
    z = {"points": state["sweep"], "meta": state["sweep_meta"],
         "device": devices.info.as_dict() if devices.info else None}
    return JSONResponse(z)


MEAS_DIR = DATA_DIR / "measurements"

CSV_FIELDS = ["f", "mag", "phase_deg", "z_re", "z_im", "rs", "xs", "c_equiv", "l_equiv",
              "va_rms", "vb_rms", "i_rms", "snr_db", "uncertainty_pct", "clipped",
              "range_a", "range_b", "cycles", "dc_v"]


def _points_csv(points: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_FIELDS, extrasaction="ignore")
    w.writeheader()
    for p in points:
        w.writerow(p)
    return buf.getvalue()


@app.get("/api/scope/settings")
def scope_settings():
    """Everything the driver will tell us, in one payload."""
    scope = _require_device()
    ra, rb = scope.ranges
    max_adc = getattr(scope, "max_adc", 32767)
    aq = getattr(scope, "last_aq", {}) or {}
    unit = getattr(scope, "unit_info", {}) or {}
    awg = getattr(scope, "awg_state", {}) or {}

    def chan(name, role, range_v, idx):
        return {
            "channel": name,
            "role": role,
            "enabled": True,
            "coupling": "DC",
            "range_v": range_v,
            "offset_v": 0.0,
            "resolution_bits": 8,
            "adc_max": max_adc,
            "lsb_uv": 1e6 * range_v / max_adc,
            "range_index": idx,
        }

    return {
        "device": {
            "model": scope.info.model,
            "serial": scope.info.serial,
            "kind": scope.info.kind,
            **{k: unit.get(k, "-") for k in ("driver", "usb", "hardware", "cal_date", "kernel")},
        },
        "channels": [
            chan("A", "DUT node (V_A)", ra, RANGE_TABLE.index(ra) if ra in RANGE_TABLE else -1),
            chan("B", "source node (V_B)", rb, RANGE_TABLE.index(rb) if rb in RANGE_TABLE else -1),
        ],
        "acquisition": {
            "timebase": aq.get("timebase"),
            "dt_us": (aq.get("dt_s") or 0) * 1e6,
            "sample_rate_msps": (aq.get("sample_rate_hz") or 0) / 1e6,
            "samples": aq.get("samples"),
            "record_us": (aq.get("record_s") or 0) * 1e6,
            "trigger": aq.get("trigger", "not yet acquired"),
            "max_samples": scope.info.max_samples,
            "mode": "block",
            "oversampling": 1,
        },
        "generator": {
            "waveform": awg.get("waveform", "sine"),
            "freq_hz": awg.get("freq", 0.0),
            "amplitude_vpp": awg.get("vpp", 0.0),
            "offset_v": awg.get("offset_v", 0.0),
            "source_impedance_ohm": AWG_SOURCE_Z,
            "sweep": "none",
            "trigger": "none",
            "output": "on" if awg.get("on") else "off",
        },
        "limits": {
            "freq_min_hz": 0.1,
            "freq_max_hz": 100_000.0,
            "vpp_min": 0.002,
            "vpp_max": 4.0,
            "ranges_v": RANGE_TABLE,
        },
        "calibration": _cal_payload(),
        "app": {
            "build": _build_id(),
            "uptime_s": round(time.time() - (state.get("started_at") or time.time()), 1),
            "busy": state["engine"] is not None and state["engine"].is_alive(),
        },
    }


DIVISIONS = 10.0          # horizontal divisions, the way PicoScope draws its grid


def parse_custom(s: str):
    """'0.1,-0.4,…' -> list of floats clipped to ±1, at most 256 points."""
    if not s:
        return None
    out = []
    for part in str(s).split(",")[:256]:
        part = part.strip()
        if not part:
            continue
        try:
            v = float(part)
        except ValueError:
            continue
        out.append(max(-1.0, min(1.0, v)))
    return out or None


def _capture(scope, f: float, dt_target: float, n: int, trig: dict | None,
             range_a: float, range_b: float):
    """Acquire once, auto-ranging only the channels the user left on 'auto'.

    Returns (va_v, vb_v, dt, ra, rb, clip_a, clip_b). A manual range is respected
    even if it clips — that is the point of setting it by hand.
    """
    idx_a, idx_b = scope.range_indices
    want_a = range_index(range_a) if range_a and range_a > 0 else None
    want_b = range_index(range_b) if range_b and range_b > 0 else None
    if want_a is not None:
        idx_a = want_a
    if want_b is not None:
        idx_b = want_b
    max_adc = getattr(scope, "max_adc", 32767)

    va_v = vb_v = None
    dt = dt_target
    peak_a = peak_b = 0.0
    for _ in range(4):
        scope.set_ranges(idx_a, idx_b)
        va, vb, dt = scope.acquire(f, dt_target, n, trig=trig)
        ra, rb = scope.ranges
        va_v = va.astype(float) * (ra / max_adc)
        vb_v = vb.astype(float) * (rb / max_adc)
        peak_a, peak_b = float(np.abs(va_v).max()), float(np.abs(vb_v).max())
        moved = False
        if want_a is None:
            if peak_a >= ra * 0.98 and idx_a < MAX_RANGE_INDEX:
                idx_a += 1
                moved = True
            elif peak_a < ra * 0.35 and idx_a > 0:
                idx_a -= 1
                moved = True
        if want_b is None:
            if peak_b >= rb * 0.98 and idx_b < MAX_RANGE_INDEX:
                idx_b += 1
                moved = True
            elif peak_b < rb * 0.35 and idx_b > 0:
                idx_b -= 1
                moved = True
        if not moved:
            break
    return (va_v, vb_v, dt, ra, rb,
            bool(peak_a >= ra * 0.98), bool(peak_b >= rb * 0.98))


@app.get("/api/scope/trace")
def scope_trace(f: float = 1000.0, cycles: float = 3.0, points: int = 700,
                amp_vpp: float = 1.0, r_ref: float = 1000.0,
                time_div_us: float = 0.0, nsamples: int = 0,
                range_a: float = 0.0, range_b: float = 0.0,
                trig_mode: str = "auto", trig_source: str = "B",
                trig_level: float = 0.0, trig_dir: str = "rising",
                waveform: str = "sine", duty: float = 0.5,
                edge: float = 0.02, custom: str = "", bias_v: float = 0.0):
    """Live dual-trace capture for the scope page, plus the generator's EMF.

    time_div_us > 0 selects the horizontal scale by hand (record = 10 divisions of
    it); 0 keeps the old "show N periods" behaviour. range_a/range_b in volts pick
    the vertical scale by hand; 0 leaves the channel auto-ranging. waveform picks
    the generator shape; pulse and custom are uploaded as an arbitrary buffer of
    `custom` values (comma separated, -1..1).
    """
    scope = _require_device()
    if state["engine"] is not None and state["engine"].is_alive():
        raise HTTPException(status_code=409, detail="measurement running — stop it to view the scope")
    f = float(min(max(f, 0.1), 100_000.0))
    cycles = float(min(max(cycles, 1.0), 50.0))
    if hasattr(scope, "r_ref"):
        scope.r_ref = r_ref

    shape = parse_custom(custom)
    wf = str(waveform or "sine").lower()
    if wf not in WAVEFORMS:
        wf = "sine"
    duty = float(min(max(duty, 0.02), 0.98))

    manual_tb = float(time_div_us) > 0
    if manual_tb:
        record_s = DIVISIONS * float(time_div_us) * 1e-6
        n = int(nsamples) if nsamples and nsamples > 0 else 4000
        n = int(min(max(n, 256), scope.info.max_samples))
        dt_target = record_s / n
    else:
        n = int(min(4000, max(128, cycles * SAMPLES_PER_CYCLE)))
        dt_target = 1.0 / (f * SAMPLES_PER_CYCLE)

    mode = str(trig_mode).lower()
    trig = None if mode in ("off", "none", "0", "false") else {
        "mode": "normal" if mode == "normal" else "auto",
        "source": "A" if str(trig_source).upper() == "A" else "B",
        "dir": "falling" if str(trig_dir).lower() == "falling" else "rising",
        "level_v": float(trig_level),
    }

    try:
        scope.set_awg(f, amp_vpp, float(bias_v), waveform=wf, duty=duty,
                      edge=float(edge), custom=shape)
        applied_bias = float(scope.awg_state.get("offset_v", 0.0))
        time.sleep(min(0.15, max(0.005, 1.0 / f)))
        va_v, vb_v, dt, ra, rb, clip_a, clip_b = _capture(
            scope, f, dt_target, n, trig, float(range_a), float(range_b))
    except ScopeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # The generator EMF sits behind its 600 ohm output resistance: V_emf = V_B + I*600,
    # and I is known from the drop across R_ref.
    emf = vb_v + (AWG_SOURCE_Z / r_ref) * (vb_v - va_v)

    # Fit on a whole number of periods. A block never lands on an exact cycle, and
    # with a non-sine drive the harmonics then leak into the fundamental bin — a
    # 25 % pulse read 7.8 kΩ where 8.47 kΩ was right. Cropping fixes it for any shape.
    sp = 1.0 / (f * dt)
    n_per = int(np.floor(len(va_v) / sp)) if sp > 0 else 0
    fit_va, fit_vb = va_v, vb_v
    if n_per >= 1:
        cut = int(round(n_per * sp))
        if cut >= 32:
            fit_va, fit_vb = va_v[:cut], vb_v[:cut]

    try:
        ta = fit_tone(fit_va, 1.0 / dt, f)
        tb = fit_tone(fit_vb, 1.0 / dt, f)
        z = impedance_from_tones(ta, tb, r_ref)
        z_info = {"mag": abs(z), "phase_deg": math.degrees(math.atan2(z.imag, z.real))}
        phase_deg = math.degrees(math.atan2(ta.phasor.imag, ta.phasor.real)) - \
                    math.degrees(math.atan2(tb.phasor.imag, tb.phasor.real))
        phase_deg = (phase_deg + 180) % 360 - 180
    except Exception:
        z_info = None
        phase_deg = None

    step = max(1, len(va_v) // max(points, 50))
    idx = range(0, len(va_v), step)
    return {
        "f": f,
        "dt_us": dt * 1e6,
        "samples": int(len(va_v)),
        "record_ms": dt * len(va_v) * 1000.0,
        "time_div_us": dt * len(va_v) / DIVISIONS * 1e6,
        "divisions": DIVISIONS,
        "timebase": "manual" if manual_tb else "%g periods" % cycles,
        "trigger": describe_trigger(trig),
        "trig": trig or {"mode": "off"},
        "waveform": wf,
        "bias_v": applied_bias,
        "bias_limit_v": max(0.0, 2.5 - float(amp_vpp) / 2.0),
        "dc_a": float(np.mean(va_v)), "dc_b": float(np.mean(vb_v)),
        "duty": duty if wf in ("square", "pulse") else None,
        "custom_points": len(shape) if shape else 0,
        "t_ms": [i * dt * 1000.0 for i in idx],
        "va": va_v[::step].tolist(),
        "vb": vb_v[::step].tolist(),
        "emf": emf[::step].tolist(),
        "range_a": ra, "range_b": rb,
        "range_a_auto": not float(range_a) > 0,
        "range_b_auto": not float(range_b) > 0,
        "clip_a": clip_a, "clip_b": clip_b,
        "clipped": bool(clip_a or clip_b),
        "lsb_a_uv": 1e6 * ra / getattr(scope, "max_adc", 32767),
        "lsb_b_uv": 1e6 * rb / getattr(scope, "max_adc", 32767),
        "rms_a": float(np.sqrt(np.mean(va_v ** 2))),
        "rms_b": float(np.sqrt(np.mean(vb_v ** 2))),
        "vpp_a": float(va_v.max() - va_v.min()),
        "vpp_b": float(vb_v.max() - vb_v.min()),
        "phase_a_vs_b_deg": phase_deg,
        "z": z_info,
        "awg_source_z": AWG_SOURCE_Z,
    }


@app.post("/api/measurements/save")
def save_measurement(req: SaveRequest):
    """Write the current (or supplied) points to measurements/ as CSV + JSON."""
    points = req.points if req.points is not None else state["sweep"]
    if not points:
        raise HTTPException(status_code=400, detail="nothing to save yet")
    meta = req.meta if req.meta is not None else state["sweep_meta"]
    name = (req.name or "measurement").strip() or "measurement"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", name)[:48].strip("-") or "measurement"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = "%s_%s" % (stamp, slug)
    MEAS_DIR.mkdir(parents=True, exist_ok=True)

    csv_path = MEAS_DIR / (base + ".csv")
    csv_path.write_text(_points_csv(points))

    payload = {
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "name": name,
        "device": devices.info.as_dict() if devices.info else None,
        "calibration": _cal_payload(),
        "meta": meta or {},
        "points": points,
    }
    json_path = MEAS_DIR / (base + ".json")
    json_path.write_text(json.dumps(payload, indent=2))

    hub.publish({"type": "saved", "csv": str(csv_path), "points": len(points)})
    return {"csv": str(csv_path), "json": str(json_path), "points": len(points)}


def _csv_rows(fields: list[str], rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


ZIP_README = """Impedance sweep export
======================

sweep_all.csv        every measured quantity, one row per frequency
bode_magnitude.csv   frequency, |Z| in ohms and in dB-ohm (20*log10(|Z|))
bode_phase.csv       frequency, impedance phase in degrees and radians
nyquist.csv          Re(Z), -Im(Z) per frequency (the Nyquist plotting data)
metadata.json        device, calibration, fixture configuration, timestamp

Sign convention: phase is the angle of Z, so a capacitive DUT is negative and
-Im(Z) is plotted upward, the usual EIS convention.

Circuit:          Z = R_ref * V_A / (V_B - V_A)
                  Ch A across the DUT, Ch B on the source side of R_ref

Each point is a least-squares fit of a zero-centred sine at the excitation
frequency, averaged over the configured number of captures. Uncertainty is
derived from the fit residuals, so it grows when the signal-to-noise ratio of
the measurement degrades.
"""


@app.post("/api/export/zip")
def export_zip(req: SaveRequest):
    """One archive holding every dataset the three plots need."""
    points = req.points if req.points is not None else state["sweep"]
    if not points:
        raise HTTPException(status_code=400, detail="nothing to export yet")
    meta = req.meta if req.meta is not None else state["sweep_meta"]
    name = (req.name or "sweep").strip() or "sweep"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", name)[:48].strip("-") or "sweep"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    bode_mag = [{"frequency_hz": p["f"],
                 "z_mag_ohm": p["mag"],
                 "z_mag_db": 20.0 * math.log10(p["mag"]) if p["mag"] > 0 else None}
                for p in points]
    bode_phase = [{"frequency_hz": p["f"],
                   "phase_deg": p["phase_deg"],
                   "phase_rad": math.radians(p["phase_deg"])}
                  for p in points]
    nyquist = [{"frequency_hz": p["f"],
                "re_ohm": p["z_re"],
                "neg_im_ohm": -p["z_im"],
                "z_mag_ohm": p["mag"],
                "phase_deg": p["phase_deg"]}
               for p in points]

    payload = {
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "name": name,
        "device": devices.info.as_dict() if devices.info else None,
        "calibration": _cal_payload(),
        "meta": meta or {},
        "points": len(points),
        "files": ["sweep_all.csv", "bode_magnitude.csv", "bode_phase.csv",
                  "nyquist.csv", "metadata.json", "README.txt"],
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("sweep_all.csv", _points_csv(points))
        z.writestr("bode_magnitude.csv",
                   _csv_rows(["frequency_hz", "z_mag_ohm", "z_mag_db"], bode_mag))
        z.writestr("bode_phase.csv",
                   _csv_rows(["frequency_hz", "phase_deg", "phase_rad"], bode_phase))
        z.writestr("nyquist.csv",
                   _csv_rows(["frequency_hz", "re_ohm", "neg_im_ohm", "z_mag_ohm",
                              "phase_deg"], nyquist))
        z.writestr("metadata.json", json.dumps(payload, indent=2))
        z.writestr("README.txt", ZIP_README)

    filename = "impedance_%s_%s.zip" % (stamp, slug)
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="%s"' % filename})


@app.get("/api/measurements")
def list_measurements():
    if not MEAS_DIR.exists():
        return {"files": []}
    files = []
    for p in sorted(MEAS_DIR.glob("*.json"), reverse=True)[:50]:
        try:
            files.append({"name": p.stem, "size": p.stat().st_size,
                          "when": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")})
        except OSError:
            pass
    return {"files": files}


@app.get("/api/export.csv")
def export_csv():
    points = state["sweep"]
    if not points:
        raise HTTPException(status_code=404, detail="no sweep data yet")
    buf = io.StringIO()
    buf.write(_points_csv(points))
    meta = state["sweep_meta"]
    name = "impedance_sweep_%g_%gHz.csv" % (meta.get("f_start", 0), meta.get("f_stop", 0))
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="%s"' % name})


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    q = hub.register()
    try:
        info = devices.info
        await sock.send_json({
            "type": "hello",
            "device": info.as_dict() if info else None,
            "driver_error": devices.last_error or None,
            "running": state["kind"],
            "points": state["sweep"],
            "meta": state["sweep_meta"],
        })
        while True:
            msg = await q.get()
            await sock.send_json(msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.unregister(q)


# ---------------------------------------------------------------------------
# Static frontend (only when built)
# ---------------------------------------------------------------------------

def _build_id() -> str:
    try:
        return "%x" % int((DIST / "index.html").stat().st_mtime)
    except OSError:
        return "dev"


@app.get("/api/version")
def version():
    return {"build": _build_id()}


if DIST.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        # Never let the browser keep an old shell around: the hashed bundle name
        # changes on every build, and a stale index.html pins the old one.
        return FileResponse(DIST / "index.html",
                            headers={"Cache-Control": "no-store, must-revalidate"})
