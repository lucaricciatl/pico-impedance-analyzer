"""Measurement engines: single-point acquisition, frequency sweep, live tracking."""

from __future__ import annotations

import math
import threading
import uuid
import time
from collections import deque
from dataclasses import asdict, dataclass, field

import numpy as np

from .analysis import auto_range_peak, equivalent_series, fit_tone, impedance_from_tones
from .scope import MAX_RANGE_INDEX, RANGE_TABLE, ScopeError

MAX_SAMPLES = 4000
SAMPLES_PER_CYCLE = 64


@dataclass
class PointConfig:
    amp_vpp: float = 1.0
    offset_v: float = 0.0
    r_ref: float = 1000.0
    averages: int = 3
    settle_ms: float = 15.0
    auto_range: bool = True
    range_a: int = 6
    range_b: int = 6
    def validated(self) -> "PointConfig":
        cfg = PointConfig(**asdict(self))
        cfg.amp_vpp = float(min(max(cfg.amp_vpp, 0.002), 4.0))
        cfg.offset_v = float(min(max(cfg.offset_v, -2.0), 2.0))
        cfg.r_ref = float(min(max(cfg.r_ref, 0.1), 1e7))
        cfg.averages = int(min(max(cfg.averages, 1), 64))
        cfg.settle_ms = float(min(max(cfg.settle_ms, 0.0), 2000.0))
        # The excitation is always a zero-centred sine: any DC offset only eats
        # ADC range and would have to be removed again by the tone fit.
        cfg.offset_v = 0.0
        cfg.range_a = int(min(max(cfg.range_a, 0), MAX_RANGE_INDEX))
        cfg.range_b = int(min(max(cfg.range_b, 0), MAX_RANGE_INDEX))
        return cfg


def range_index_for(peak_v: float) -> int:
    """Smallest range whose full scale comfortably contains the peak."""
    need = max(peak_v, 1e-4) * 1.25 + 0.001
    for i, full in enumerate(RANGE_TABLE[: MAX_RANGE_INDEX + 1]):
        if need <= full:
            return i
    return MAX_RANGE_INDEX


def plan_capture(f: float) -> tuple[int, float]:
    """Sample count and target sample interval for a measurement at f."""
    cycles = max(3, min(64, int(round(0.05 * f))))
    # Never let one capture run longer than ~2 s, or Stop feels unresponsive.
    if cycles / f > 2.0:
        cycles = max(2, int(2.0 * f))
    n = max(128, cycles * SAMPLES_PER_CYCLE)
    n = min(MAX_SAMPLES, n)
    dt_target = 1.0 / (f * SAMPLES_PER_CYCLE)
    return n, dt_target


def measure_point(scope, f: float, cfg: PointConfig, cal: complex = 1 + 0j) -> dict:
    """Measure Z_dut at one frequency. Blocking; call from a worker thread."""
    t0 = time.perf_counter()
    cfg = cfg.validated()
    n_samples, dt_target = plan_capture(f)

    if hasattr(scope, "r_ref"):
        scope.r_ref = cfg.r_ref

    scope.set_awg(f, cfg.amp_vpp, cfg.offset_v)
    settle = max(cfg.settle_ms / 1000.0, min(0.2, 1.0 / f))
    time.sleep(settle)

    if not cfg.auto_range:
        scope.set_ranges(cfg.range_a, cfg.range_b)

    va = vb = None
    dt = dt_target
    range_a_v, range_b_v = RANGE_TABLE[cfg.range_a], RANGE_TABLE[cfg.range_b]
    max_adc = getattr(scope, "max_adc", 32767)

    for attempt in range(3):
        va, vb, dt = scope.acquire(f, dt_target, n_samples)
        range_a_v, range_b_v = scope.ranges
        if not cfg.auto_range:
            break
        peak_a = auto_range_peak(_volts(va, range_a_v, max_adc))
        peak_b = auto_range_peak(_volts(vb, range_b_v, max_adc))
        want = (range_index_for(peak_a), range_index_for(peak_b))
        cur = _indices_for(range_a_v, range_b_v)
        if want == cur or attempt == 2:
            break
        scope.set_ranges(*want)
        time.sleep(0.004)

    n = va.size
    cycles = n / SAMPLES_PER_CYCLE

    # --- average complex impedance over repeated captures -------------------
    z_sum = 0j
    va_rms_sum = vb_rms_sum = 0.0
    snr_min = 200.0
    balance = 0.0          # |V_B - V_A| / |V_B|: the drop across R_ref
    rel_sigma_sum = 0.0
    dc_max = 0.0           # largest fitted DC term on either channel
    used = 0
    for _ in range(cfg.averages):
        if used:
            va, vb, dt = scope.acquire(f, dt_target, n_samples)
            range_a_v, range_b_v = scope.ranges
            n = va.size
        va_v = _volts(va, range_a_v, max_adc)
        vb_v = _volts(vb, range_b_v, max_adc)
        ta = fit_tone(va_v, 1.0 / dt, f)
        tb = fit_tone(vb_v, 1.0 / dt, f)
        z, stress, bal = _solve(cfg, ta, tb)
        z_sum += z
        va_rms_sum += ta.rms
        vb_rms_sum += tb.rms
        snr_min = min(snr_min, ta.snr_db, tb.snr_db)
        balance += bal
        dc_max = max(dc_max, abs(ta.offset), abs(tb.offset))
        sa = _rel_sigma(ta, n) * abs(ta.phasor)
        sb = _rel_sigma(tb, n) * abs(tb.phasor)
        rel_sigma_sum += math.hypot(sa, sb) * stress + _rel_sigma(ta, n)
        used += 1

    z = cal * (z_sum / used)
    mag = abs(z)
    phase = math.degrees(math.atan2(z.imag, z.real))
    equiv = equivalent_series(z, f)
    i_rms = (va_rms_sum / used) / mag if mag > 0 else 0.0

    return {
        "f": float(f),
        "z_re": float(z.real),
        "z_im": float(z.imag),
        "mag": float(mag),
        "phase_deg": float(phase),
        "va_rms": float(va_rms_sum / used),
        "vb_rms": float(vb_rms_sum / used),
        "i_rms": float(i_rms),
        "snr_db": float(snr_min),
        "drop_ratio": float(balance / used),
        "dc_v": float(dc_max),
        "range_a": float(range_a_v),
        "range_b": float(range_b_v),
        "n_samples": int(n),
        "cycles": float(cycles),
        "dt": float(dt),
        "clipped": bool(_clipped(va, max_adc) or _clipped(vb, max_adc)),
        "rs": float(equiv["rs"]),
        "xs": float(equiv["xs"]),
        "c_equiv": equiv["c_equiv"],
        "l_equiv": equiv["l_equiv"],
        "uncertainty_pct": float(min(100.0, 100.0 * rel_sigma_sum / used)),
        "elapsed_ms": (time.perf_counter() - t0) * 1000.0,
    }


def _solve(cfg: "PointConfig", ta, tb) -> tuple[complex, float, float]:
    """Z_dut = R_ref · V_A / (V_B − V_A).

    Returns (z, error_stress, balance); error_stress amplifies the tone errors
    through the divider ratio and balance is the drop across R_ref.
    """
    drop = abs(tb.phasor - ta.phasor)
    if drop < 1e-15:
        raise ZeroDivisionError("no current through the reference resistor")
    z = cfg.r_ref * ta.phasor / (tb.phasor - ta.phasor)
    return z, 1.0 / max(drop, 1e-12), drop / max(abs(tb.phasor), 1e-12)


def _volts(counts: np.ndarray, full_scale: float, max_adc: int) -> np.ndarray:
    return counts.astype(np.float64) * (full_scale / float(max_adc))


def _clipped(counts: np.ndarray, max_adc: int) -> bool:
    if counts.size == 0:
        return False
    return bool(np.any(np.abs(counts.astype(np.int32)) >= max_adc - 1))


def _rel_sigma(tone, n: int) -> float:
    """Relative standard error of the fitted tone amplitude."""
    if tone.rms <= 0:
        return 1.0
    return (tone.residual_rms / tone.rms) * math.sqrt(2.0 / max(n, 1))


def _indices_for(range_a_v: float, range_b_v: float) -> tuple[int, int]:
    def idx(v: float) -> int:
        return min(range(len(RANGE_TABLE)), key=lambda i: abs(RANGE_TABLE[i] - v))
    return idx(range_a_v), idx(range_b_v)


@dataclass
class SweepConfig:
    f_start: float = 10.0
    f_stop: float = 100_000.0
    points: int = 60
    spacing: str = "log"
    amp_vpp: float = 1.0
    offset_v: float = 0.0
    r_ref: float = 1000.0
    averages: int = 3
    settle_ms: float = 15.0
    auto_range: bool = True
    range_a: int = 6
    range_b: int = 6
    def frequencies(self) -> list[float]:
        n = int(min(max(self.points, 2), 1000))
        lo = float(max(self.f_start, 0.1))
        hi = float(min(self.f_stop, 100_000.0))
        if hi <= lo:
            raise ValueError("stop frequency must exceed start frequency")
        if self.spacing == "lin":
            return list(np.linspace(lo, hi, n))
        return list(np.geomspace(lo, hi, n))

    def point_config(self) -> PointConfig:
        return PointConfig(amp_vpp=self.amp_vpp, offset_v=self.offset_v,
                           r_ref=self.r_ref, averages=self.averages,
                           settle_ms=self.settle_ms, auto_range=self.auto_range,
                           range_a=self.range_a, range_b=self.range_b)


class _Engine(threading.Thread):
    def __init__(self, scope, publish, name: str):
        super().__init__(name=name, daemon=True)
        self.scope = scope
        self.run_id = uuid.uuid4().hex[:8]
        self._emit = publish
        # Every message carries the run id so a slow-to-stop engine cannot
        # contaminate the next sweep's data.
        self.publish = lambda msg: self._emit({**msg, "run_id": self.run_id})
        self._halt = threading.Event()  # never name this _stop: Thread._stop() is internal

    def stop(self) -> None:
        self._halt.set()

    @property
    def stopped(self) -> bool:
        return self._halt.is_set()


class SweepEngine(_Engine):
    def __init__(self, scope, publish, cfg: SweepConfig, cal: complex = 1 + 0j):
        super().__init__(scope, publish, name="sweep")
        self.cfg = cfg
        self.cal = cal

    def run(self) -> None:
        try:
            freqs = self.cfg.frequencies()
        except ValueError as exc:
            self.publish({"type": "error", "message": str(exc)})
            return
        pcfg = self.cfg.point_config()
        t0 = time.perf_counter()
        self.publish({"type": "sweep_start", "total": len(freqs),
                      "f_start": freqs[0], "f_stop": freqs[-1],
                      "spacing": self.cfg.spacing, "r_ref": pcfg.r_ref})
        done = 0
        for i, f in enumerate(freqs):
            if self.stopped:
                self.publish({"type": "sweep_done", "completed": done,
                              "total": len(freqs), "stopped": True,
                              "elapsed": time.perf_counter() - t0})
                return
            try:
                point = measure_point(self.scope, f, pcfg, self.cal)
            except ScopeError as exc:
                self.publish({"type": "error", "message": str(exc)})
                return
            except Exception as exc:  # keep the UI alive, report honestly
                self.publish({"type": "error", "message": "%s: %s" % (type(exc).__name__, exc)})
                return
            done += 1
            point.update({"index": i, "total": len(freqs)})
            self.publish({"type": "point", "point": point})
        self.publish({"type": "sweep_done", "completed": done, "total": len(freqs),
                      "stopped": False, "elapsed": time.perf_counter() - t0})


@dataclass
class ContinuousConfig:
    freq: float = 1000.0
    interval_ms: float = 250.0
    window: int = 200
    amp_vpp: float = 1.0
    offset_v: float = 0.0
    r_ref: float = 1000.0
    averages: int = 3
    settle_ms: float = 15.0
    auto_range: bool = True
    range_a: int = 6
    range_b: int = 6
    def point_config(self) -> PointConfig:
        return PointConfig(amp_vpp=self.amp_vpp, offset_v=self.offset_v,
                           r_ref=self.r_ref, averages=self.averages,
                           settle_ms=self.settle_ms, auto_range=self.auto_range,
                           range_a=self.range_a, range_b=self.range_b)


class ContinuousEngine(_Engine):
    def __init__(self, scope, publish, cfg: ContinuousConfig, cal: complex = 1 + 0j):
        super().__init__(scope, publish, name="continuous")
        self.cfg = cfg
        self.cal = cal
        self.history: deque = deque(maxlen=max(10, min(int(cfg.window), 5000)))

    def run(self) -> None:
        pcfg = self.cfg.point_config()
        interval = max(0.02, self.cfg.interval_ms / 1000.0)
        self.publish({"type": "continuous_start", "freq": self.cfg.freq,
                      "interval_ms": interval * 1000.0})
        t_start = time.perf_counter()
        while not self.stopped:
            tick = time.perf_counter()
            try:
                point = measure_point(self.scope, float(self.cfg.freq), pcfg, self.cal)
            except ScopeError as exc:
                self.publish({"type": "error", "message": str(exc)})
                return
            except Exception as exc:
                self.publish({"type": "error", "message": "%s: %s" % (type(exc).__name__, exc)})
                return
            self.history.append(point)
            stats = self._stats(point)
            self.publish({"type": "continuous", "point": point, "stats": stats,
                          "t": time.perf_counter() - t_start})
            slack = interval - (time.perf_counter() - tick)
            if slack > 0:
                if self._halt.wait(slack):
                    break
        self.publish({"type": "continuous_done", "samples": len(self.history)})

    def _stats(self, latest: dict) -> dict:
        arr = list(self.history)
        mags = np.array([p["mag"] for p in arr])
        phases = np.array([p["phase_deg"] for p in arr])
        res = np.array([p["z_re"] for p in arr])
        ims = np.array([p["z_im"] for p in arr])
        return {
            "n": len(arr),
            "mag_mean": float(mags.mean()),
            "mag_std": float(mags.std()),
            "phase_mean": float(phases.mean()),
            "phase_std": float(phases.std()),
            "re_mean": float(res.mean()),
            "im_mean": float(ims.mean()),
            "mag_min": float(mags.min()),
            "mag_max": float(mags.max()),
            "phase_min": float(phases.min()),
            "phase_max": float(phases.max()),
            "latest": latest,
        }
