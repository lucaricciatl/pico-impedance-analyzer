"""Device layer: real PicoScope 2204A (ps2000a driver) and a simulator.

The driver is imported lazily so the whole application runs with no PicoScope
attached (simulator mode); that mode also lets the measurement pipeline be
tested end-to-end against a known impedance.
"""

from __future__ import annotations

import glob
import math
import os
import platform
import threading
import time
from dataclasses import dataclass, field

import numpy as np

from .analysis import clip_fraction

PICO_OK = 0

AWG_MIN_FREQ = 0.1
AWG_MAX_FREQ = 100_000.0
AWG_MAX_VPP = 4.0
AWG_MIN_VPP = 0.002
AWG_SOURCE_Z = 600.0

# ps2000a voltage range index -> full scale volts
RANGE_TABLE = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0]
MAX_RANGE_INDEX = 9
MAX_ADC_DEFAULT = 32767

# PS2000A_THRESHOLD_DIRECTION: ABOVE=0 BELOW=1 RISING=2 FALLING=3 RISING_OR_FALLING=4
TRIG_DIR = {"rising": 2, "falling": 3, "either": 4}

# PS2000A_WAVE_TYPE: the built-in shapes the 2204A generator can make on its own
WAVE_TYPES = {"sine": 0, "square": 1, "triangle": 2, "dc": 3, "ramp_up": 4,
              "ramp_down": 5, "sinc": 6, "gaussian": 7, "half_sine": 8}

# names the UI may ask for; pulse and custom are uploaded as an arbitrary buffer
WAVEFORMS = list(WAVE_TYPES) + ["pulse", "custom"]


def _circ_smooth(y: np.ndarray, k: int) -> np.ndarray:
    """Circular moving average — gives the edges a finite rise time, as a real
    generator has, without breaking the period."""
    if k <= 1 or y.size < k:
        return y
    kern = np.ones(k) / float(k)
    pad = k // 2 + 1
    yp = np.r_[y[-pad:], y, y[:pad]]
    return np.convolve(yp, kern, mode="same")[pad:pad + y.size]


def wave_samples(name: str, n: int = 256, duty: float = 0.5, edge: float = 0.02,
                 custom=None) -> np.ndarray:
    """One cycle of a waveform, normalised to -1..+1.

    This is the single definition of every shape: the simulator renders from it,
    and the real generator gets it uploaded as an arbitrary buffer when the shape
    is not one of the driver's built-ins.
    """
    name = str(name or "sine").lower()
    t = np.arange(n, dtype=float) / float(n)
    duty = min(max(float(duty), 0.02), 0.98)
    edge = min(max(float(edge), 0.0), 0.45)

    if name == "custom":
        if custom is None or len(custom) < 2:
            y = np.sin(2.0 * np.pi * t)
        else:
            a = np.asarray(custom, dtype=float)
            y = np.interp(t * a.size, np.arange(a.size), a)
    elif name == "sine":
        y = np.sin(2.0 * np.pi * t)
    elif name in ("square", "pulse"):
        y = np.where(t < duty, 1.0, -1.0)
        y = _circ_smooth(y, max(1, int(round(edge * n))))
    elif name == "triangle":
        y = 1.0 - 4.0 * np.abs(t - 0.5)
    elif name == "ramp_up":
        y = 2.0 * t - 1.0
    elif name == "ramp_down":
        y = 1.0 - 2.0 * t
    elif name == "sinc":
        x = (t - 0.5) * 8.0
        y = np.where(np.abs(x) < 1e-6, 1.0, np.sin(np.pi * x) / (np.pi * np.where(x == 0, 1, x)))
    elif name == "gaussian":
        g = np.exp(-0.5 * ((t - 0.5) / 0.09) ** 2)
        y = 2.0 * (g - g.min()) / max(1e-12, g.max() - g.min()) - 1.0
    elif name == "half_sine":
        y = 2.0 * np.sin(np.pi * t) - 1.0
    elif name == "dc":
        return np.zeros(n, dtype=float)
    else:
        y = np.sin(2.0 * np.pi * t)

    # the generator runs at zero offset, so any shape with a DC component (pulses
    # at duty != 50 %, gaussian, half sine) is centred before it is normalised
    y = y - y.mean()
    peak = float(np.abs(y).max())
    if peak > 1e-9:
        y = y / peak
    return y


def clamp_offset(offset_v: float, amp_vpp: float) -> float:
    """The AWG output can only swing to ±2.5 V, so a large amplitude leaves little
    room for bias. Returns the bias the instrument can actually produce."""
    limit = max(0.0, 2.5 - float(amp_vpp) / 2.0)
    return float(max(-limit, min(limit, float(offset_v))))


def range_index(volts: float) -> int:
    """Smallest full-scale range that still contains `volts` (clamped)."""
    v = abs(float(volts))
    for i, full in enumerate(RANGE_TABLE):
        if full >= v:
            return i
    return MAX_RANGE_INDEX


def describe_trigger(trig: dict | None) -> str:
    if not trig:
        return "free run (no trigger)"
    mode = str(trig.get("mode", "auto")).lower()
    src = str(trig.get("source", "B")).upper()
    slope = str(trig.get("dir", "rising")).lower()
    return "CH %s %s @ %+.3f V (%s)" % (src, slope, float(trig.get("level_v", 0.0)),
                                        "auto" if mode == "auto" else "normal")


class ScopeError(RuntimeError):
    """Anything the user has to fix on the instrument side."""


@dataclass
class DeviceInfo:
    kind: str = "simulated"
    model: str = "PicoScope 2204A (simulated)"
    serial: str = "SIM-0001"
    driver: str = "-"
    usb: str = "-"
    channels: int = 2
    awg_max_freq: float = AWG_MAX_FREQ
    awg_max_vpp: float = AWG_MAX_VPP
    awg_source_z: float = AWG_SOURCE_Z
    max_samples: int = 8000

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "model": self.model,
            "serial": self.serial,
            "driver": self.driver,
            "usb": self.usb,
            "channels": self.channels,
            "awg_max_freq": self.awg_max_freq,
            "awg_max_vpp": self.awg_max_vpp,
            "awg_source_z": self.awg_source_z,
            "max_samples": self.max_samples,
        }


def _candidate_library_dirs() -> list[str]:
    dirs = []
    env = os.environ.get("PS2000A_LIB_DIR")
    if env:
        dirs.append(env)
    if platform.system() == "Darwin":
        dirs += [
            "/Applications/PicoScope 7 T&M.app/Contents/Resources",
            "/Applications/PicoScope 7 T&M.app/Contents/MonoBundle",
            "/Applications/PicoScope 6.app/Contents/Resources",
            "/Library/Frameworks",
            "/opt/homebrew/lib",
            "/usr/local/lib",
        ]
    elif platform.system() == "Windows":
        dirs += [r"C:\Program Files\Pico Technology\SDK\lib",
                 r"C:\Program Files (x86)\Pico Technology\SDK\lib"]
    else:
        dirs += ["/opt/picoscope/lib", "/usr/local/lib", "/usr/lib"]
    return dirs


def find_ps2000a_library() -> str | None:
    pattern = "libps2000a*.dylib" if platform.system() == "Darwin" else "libps2000a.so*"
    for d in _candidate_library_dirs():
        if not os.path.isdir(d):
            continue
        hits = sorted(glob.glob(os.path.join(d, pattern)))
        if hits:
            return hits[0]
    return None


def _prepare_library_path() -> str | None:
    lib = find_ps2000a_library()
    if not lib:
        return None
    d = os.path.dirname(lib)
    for var in ("DYLD_LIBRARY_PATH", "LD_LIBRARY_PATH"):
        parts = [p for p in os.environ.get(var, "").split(":") if p]
        if d not in parts:
            os.environ[var] = ":".join([d] + parts)
    return lib


# --------------------------------------------------------------------------
# Real hardware
# --------------------------------------------------------------------------

class Ps2000aScope:
    kind = "hardware"

    def __init__(self) -> None:
        import ctypes

        self._ctypes = ctypes
        self._lock = threading.Lock()
        self.handle = None
        self.info = DeviceInfo(kind="hardware", model="PicoScope 2204A")
        self._max_adc = MAX_ADC_DEFAULT
        self._range_a = 6
        self._range_b = 6
        self._lib = None
        self._awg_on = False
        self._last_freq = None
        self._last_wave = None
        self._arb_buf = None            # must outlive the call: the driver reads it
        self._arb_min = -32767
        self._arb_max = 32767
        self.last_error = ""
        self.unit_info: dict = {}
        self.last_aq: dict = {}
        self.awg_state: dict = {"waveform": "sine", "freq": 0.0, "vpp": 0.0,
                                "offset_v": 0.0, "on": False}

    # -- lifecycle ---------------------------------------------------------
    def open(self, serial: str | None = None) -> DeviceInfo:
        lib_path = _prepare_library_path()
        try:
            from picosdk.ps2000a import ps2000a as ps
        except Exception as exc:
            raise ScopeError(
                "PicoSDK ps2000a wrapper not importable (%s). Try "
                "'.venv/bin/pip install picosdk'." % exc
            ) from exc
        self._lib = ps

        if self._enumerate(ps) == 0:
            raise ScopeError(
                "No PicoScope on USB. Check the cable and close PicoScope 7 — "
                "the driver is exclusive%s."
                % ("" if lib_path else " (libps2000a not found either)")
            )

        handle = ps.c_int16()
        status = ps.ps2000aOpenUnit(ps.byref(handle),
                                    serial.encode() if serial else None)
        if status != PICO_OK:
            raise ScopeError("ps2000aOpenUnit failed: %s" % self._status_text(status))
        self.handle = handle

        self._max_adc = self._read_max_adc(ps, handle)
        names = {0: "driver", 1: "usb", 2: "hardware", 3: "variant",
                 4: "serial", 5: "cal_date", 6: "kernel"}
        self.unit_info = {label: self._unit_info(ps, handle, code)
                          for code, label in names.items()}
        model = self._unit_info(ps, handle, 3) or "PicoScope 2000 series"
        self.info = DeviceInfo(
            kind="hardware",
            model=model,
            serial=self._unit_info(ps, handle, 4) or "-",
            driver=self._unit_info(ps, handle, 0) or "-",
            usb=self._unit_info(ps, handle, 1) or "-",
            channels=2,
            max_samples=min(self._max_block_samples(ps, handle), 1_000_000),
        )
        self.set_ranges(6, 6)
        self._read_arb_limits(ps, handle)
        return self.info

    def _read_arb_limits(self, ps, handle) -> None:
        """How big an arbitrary buffer the driver accepts, and its value range."""
        try:
            c = self._ctypes
            lo, hi = c.c_int16(0), c.c_int16(0)
            nmin, nmax = c.c_uint32(0), c.c_uint32(0)
            status = ps.ps2000aSigGenArbitraryMinMaxValues(
                handle, c.byref(lo), c.byref(hi), c.byref(nmin), c.byref(nmax))
            if status == PICO_OK:
                self._arb_min, self._arb_max = int(lo.value), int(hi.value)
                self._arb_size = (int(nmin.value), int(nmax.value))
        except Exception:
            pass

    def close(self) -> None:
        if self.handle is not None and self._lib is not None:
            try:
                self.output_off()
            except Exception:
                pass
            try:
                self._lib.ps2000aCloseUnit(self.handle)
            finally:
                self.handle = None

    @property
    def connected(self) -> bool:
        return self.handle is not None

    @property
    def ranges(self) -> tuple[float, float]:
        return RANGE_TABLE[self._range_a], RANGE_TABLE[self._range_b]

    # -- helpers -----------------------------------------------------------
    def _status_text(self, status: int) -> str:
        table = getattr(self._lib, "PICO_STATUS_LOOKUP", {})
        if isinstance(table, dict) and status in table:
            return "%s (%d)" % (table[status], status)
        return "status %d" % status

    def _check(self, status: int, what: str) -> None:
        if status != PICO_OK:
            raise ScopeError("%s failed: %s" % (what, self._status_text(status)))

    def _enumerate(self, ps) -> int:
        c = self._ctypes
        count = c.c_int16()
        length = c.c_int16(64)
        buf = c.create_string_buffer(64)
        status = ps.ps2000aEnumerateUnits(c.byref(count), buf, c.byref(length))
        return int(count.value) if status == PICO_OK else 0

    def _unit_info(self, ps, handle, info_type: int) -> str:
        c = self._ctypes
        buf = c.create_string_buffer(256)
        needed = c.c_int16()
        try:
            status = ps.ps2000aGetUnitInfo(handle, buf, c.c_int16(256),
                                           c.byref(needed), info_type)
        except Exception:
            return ""
        return buf.value.decode(errors="replace").strip() if status == PICO_OK else ""

    def _read_max_adc(self, ps, handle) -> int:
        c = self._ctypes
        val = c.c_int16()
        status = ps.ps2000aMaximumValue(handle, c.byref(val))
        return int(val.value) if status == PICO_OK and val.value > 0 else MAX_ADC_DEFAULT

    def _max_block_samples(self, ps, handle) -> int:
        c = self._ctypes
        dt = c.c_float()
        maxs = c.c_int32()
        try:
            status = ps.ps2000aGetTimebase2(handle, 10, 1000, c.byref(dt),
                                            c.c_int16(1), c.byref(maxs), 0)
            if status == PICO_OK and maxs.value > 0:
                return int(maxs.value)
        except Exception:
            pass
        return 8000

    # -- configuration -----------------------------------------------------
    def set_ranges(self, range_a: int, range_b: int) -> None:
        ps = self._lib
        for ch, idx in ((0, range_a), (1, range_b)):
            idx = max(0, min(int(idx), MAX_RANGE_INDEX))
            status = ps.ps2000aSetChannel(self.handle, ch, 1, 1, idx, 0.0)
            if status != PICO_OK:
                for fallback in range(idx - 1, -1, -1):
                    if ps.ps2000aSetChannel(self.handle, ch, 1, 1, fallback, 0.0) == PICO_OK:
                        idx = fallback
                        break
                else:
                    raise ScopeError("could not configure channel %s: %s"
                                     % ("AB"[ch], self._status_text(status)))
            if ch == 0:
                self._range_a = idx
            else:
                self._range_b = idx

    def find_timebase(self, target_dt: float, min_samples: int) -> tuple[int, float, int]:
        ps, c = self._lib, self._ctypes
        best = None
        for tb in range(0, 64):
            dt = c.c_float()
            maxs = c.c_int32()
            status = ps.ps2000aGetTimebase2(self.handle, tb, int(min_samples),
                                            c.byref(dt), c.c_int16(1), c.byref(maxs), 0)
            if status != PICO_OK:
                continue
            dt_s = dt.value * 1e-9
            if dt_s <= 0:
                continue
            if dt_s >= target_dt and maxs.value >= min_samples:
                return tb, dt_s, int(maxs.value)
            if best is None:
                best = (tb, dt_s, int(maxs.value))
        if best is None:
            raise ScopeError("no usable timebase for %.3g s" % target_dt)
        return best

    # -- generator ---------------------------------------------------------
    def set_awg(self, freq: float, amp_vpp: float, offset_v: float = 0.0,
                waveform: str = "sine", duty: float = 0.5,
                edge: float = 0.02, custom=None) -> None:
        """Program the generator.

        Built-in shapes go through ps2000aSetSigGenBuiltIn; pulse and custom are
        rendered to one cycle and uploaded with ps2000aSetSigGenArbitrary, which
        is how PicoScope's own generator does arbitrary waveforms.
        """
        name = str(waveform or "sine").lower()
        freq = float(max(AWG_MIN_FREQ, min(AWG_MAX_FREQ, freq)))
        amp_vpp = float(max(AWG_MIN_VPP, min(AWG_MAX_VPP, amp_vpp)))
        offset_v = clamp_offset(offset_v, amp_vpp)

        if name in WAVE_TYPES:
            # same shape, new frequency: the cheap properties-only call is exact
            if (self._awg_on and self._last_freq is not None
                    and self._last_wave == name):
                status = self._lib.ps2000aSetSigGenPropertiesBuiltIn(
                    self.handle, freq, freq, 0.0, 0.0, 0, 0, 0, 0, 0, 0)
                if status == PICO_OK:
                    self._last_freq = freq
                    self.awg_state.update({"freq": freq, "vpp": amp_vpp,
                                           "waveform": name, "duty": None,
                                           "on": True})
                    return
            status = self._lib.ps2000aSetSigGenBuiltIn(
                self.handle,
                int(round(offset_v * 1e6)), int(round(amp_vpp * 1000.0)),
                WAVE_TYPES[name],
                freq, freq, 0.0, 0.0,    # start, stop, increment, dwell
                0, 0,                    # sweep type UP, extra operation OFF
                0, 0,                    # shots, sweeps (endless)
                0, 0, 0)                 # no trigger
            if status != PICO_OK:
                raise ScopeError("could not set generator to %s %g Hz: %s"
                                 % (name, freq, self._status_text(status)))
        else:
            self._set_arbitrary(freq, amp_vpp, offset_v, name, duty, edge, custom)

        self._awg_on = True
        self._last_freq = freq
        self._last_wave = name
        self.awg_state = {"waveform": name, "freq": freq, "vpp": amp_vpp,
                          "offset_v": offset_v,
                          "duty": float(duty) if name in ("square", "pulse", "custom") else None,
                          "on": True}

    def _set_arbitrary(self, freq, amp_vpp, offset_v, name, duty, edge, custom) -> None:
        ps, c = self._lib, self._ctypes
        y = wave_samples(name, 256, duty, edge, custom)
        lo, hi = self._arb_min, self._arb_max
        span = float(min(hi, -lo)) or 32767.0
        counts = np.rint(y * span).astype(np.int16)
        # the driver keeps reading this buffer while the output runs
        self._arb_buf = (c.c_int16 * counts.size)(*counts.tolist())

        phase = c.c_uint32(0)
        status = ps.ps2000aSigGenFrequencyToPhase(
            self.handle, c.c_double(freq), 0, c.c_uint32(counts.size),
            c.cast(c.byref(phase), c.c_void_p))
        if status != PICO_OK:
            raise ScopeError("could not compute the arbitrary phase step: %s"
                             % self._status_text(status))

        status = ps.ps2000aSetSigGenArbitrary(
            self.handle,
            int(round(offset_v * 1e6)), int(round(amp_vpp * 1000.0)),
            0, 0, int(phase.value), 0,          # start, stop, step, dwell
            self._arb_buf, int(counts.size),
            0, 0, 0,                            # sweep type, operation, index mode
            0, 0,                               # shots, sweeps
            0, 0, 0)                            # trigger type, source, threshold
        if status != PICO_OK:
            raise ScopeError("could not upload the %s waveform (%d points): %s"
                             % (name, counts.size, self._status_text(status)))

    def output_off(self) -> None:
        if self.handle is None or self._lib is None:
            return
        try:
            self._lib.ps2000aSetSigGenBuiltIn(self.handle, 0, 0, 0, 1.0, 1.0,
                                              0.0, 0.0, 0, 0, 0, 0, 0, 0, 0)
        except Exception:
            pass
        self._awg_on = False
        self._last_freq = None
        self.awg_state.update({"on": False})

    # -- acquisition -------------------------------------------------------
    def _block(self, timebase: int, n_samples: int,
               trig: dict | None = None) -> tuple[np.ndarray, np.ndarray]:
        ps, c = self._lib, self._ctypes
        with self._lock:
            ps.ps2000aStop(self.handle)
            if trig:
                ch = 0 if str(trig.get("source", "B")).upper() == "A" else 1
                full = self._range_a if ch == 0 else self._range_b
                level = float(trig.get("level_v", 0.0))
                frac = max(-1.0, min(1.0, level / full if full else 0.0))
                threshold = int(round(frac * self._max_adc))
                direction = TRIG_DIR.get(str(trig.get("dir", "rising")).lower(),
                                         TRIG_DIR["rising"])
                # autoTrigger_ms = 0 means "wait forever"; a real scope in auto mode
                # fires anyway after ~200 ms so the display never freezes
                auto_ms = 0 if str(trig.get("mode", "auto")).lower() == "normal" else 200
                status = ps.ps2000aSetSimpleTrigger(self.handle, 1, ch, threshold,
                                                    direction, 0, auto_ms)
                self._check(status, "ps2000aSetSimpleTrigger")
            else:
                ps.ps2000aSetSimpleTrigger(self.handle, 0, 1, 0, 2, 0, 200)
            time_indisposed = c.c_int32()
            status = ps.ps2000aRunBlock(self.handle, 0, int(n_samples), timebase, 1,
                                        c.byref(time_indisposed), 0, None, None)
            self._check(status, "ps2000aRunBlock")

            deadline = time.time() + 5.0
            ready = c.c_int16(0)
            while time.time() < deadline:
                self._check(ps.ps2000aIsReady(self.handle, c.byref(ready)), "ps2000aIsReady")
                if ready.value:
                    break
                time.sleep(0.0005)
            else:
                ps.ps2000aStop(self.handle)
                raise ScopeError("acquisition timed out")

            buf = (c.c_int16 * (n_samples * 2))()
            got = c.c_uint32(n_samples)
            overflow = c.c_int16(0)
            status = ps.ps2000aGetValues(self.handle, 0, c.byref(got), 1, 0, 0,
                                         c.byref(overflow))
            self._check(status, "ps2000aGetValues")
            if overflow.value:
                raise ScopeError("ADC overflow — reduce generator amplitude")

            raw = np.frombuffer(buf, dtype=np.int16, count=int(got.value) * 2)
            if raw.size < n_samples * 2:
                raise ScopeError("short acquisition (%d of %d samples)"
                                 % (raw.size // 2, n_samples))
            pairs = raw.reshape(-1, 2)
            return (np.array(pairs[:, 0], dtype=np.int16),
                    np.array(pairs[:, 1], dtype=np.int16))

    def acquire(self, freq: float, dt_target: float, n_samples: int,
                trig: dict | None = None) -> tuple[np.ndarray, np.ndarray, float]:
        tb, dt, maxs = self.find_timebase(dt_target, n_samples)
        n = int(min(n_samples, maxs, self.info.max_samples))
        if n < 8:
            raise ScopeError("not enough sample memory for this capture")
        va, vb = self._block(tb, n, trig=trig)
        self.last_aq = {"timebase": tb, "dt_s": dt, "samples": n,
                        "sample_rate_hz": 1.0 / dt if dt else 0.0,
                        "record_s": dt * n, "trigger": describe_trigger(trig)}
        return va, vb, dt

    @property
    def range_indices(self) -> tuple[int, int]:
        return self._range_a, self._range_b

    @property
    def max_adc(self) -> int:
        return self._max_adc


# --------------------------------------------------------------------------
# Simulator
# --------------------------------------------------------------------------

class SimulatedScope:
    """Same node equations as the real fixture, with 8-bit ADC quantisation.

    Wiring model: AWG EMF -> 600 ohm -> node B -> R_ref -> node A -> Z_dut -> gnd.
    """

    kind = "simulated"

    def __init__(self) -> None:
        self.info = DeviceInfo(kind="simulated")
        self._range_a = 6
        self._range_b = 6
        self._max_adc = MAX_ADC_DEFAULT
        self._rng = np.random.default_rng(20240517)
        self.dut = {"kind": "rc_parallel", "r": 10_000.0, "c": 10e-9, "l": 1e-3}
        self.r_ref = 1000.0
        self._awg = {"freq": 1000.0, "vpp": 1.0, "on": False}
        self._wave = wave_samples("sine")
        self._wave_name = "sine"
        self.last_aq: dict = {}
        self.unit_info = {"driver": "simulated", "usb": "-", "hardware": "-",
                          "variant": "2204A (simulated)", "serial": "SIM-0001",
                          "cal_date": "-", "kernel": "-"}
        self.awg_state = {"waveform": "sine", "freq": 0.0, "vpp": 0.0,
                          "offset_v": 0.0, "on": False}

    def open(self, serial: str | None = None) -> DeviceInfo:
        return self.info

    def close(self) -> None:
        self._awg["on"] = False

    @property
    def connected(self) -> bool:
        return True

    @property
    def ranges(self) -> tuple[float, float]:
        return RANGE_TABLE[self._range_a], RANGE_TABLE[self._range_b]

    @property
    def max_adc(self) -> int:
        return self._max_adc

    def set_ranges(self, range_a: int, range_b: int) -> None:
        self._range_a = max(0, min(int(range_a), MAX_RANGE_INDEX))
        self._range_b = max(0, min(int(range_b), MAX_RANGE_INDEX))

    def find_timebase(self, target_dt: float, min_samples: int) -> tuple[int, float, int]:
        dt, tb = 4e-9, 0
        while dt < target_dt and tb < 32:
            dt *= 2.0
            tb += 1
        return tb, dt, 1_000_000

    def set_awg(self, freq: float, amp_vpp: float, offset_v: float = 0.0,
                waveform: str = "sine", duty: float = 0.5,
                edge: float = 0.02, custom=None) -> None:
        name = str(waveform or "sine").lower()
        offset_v = clamp_offset(offset_v, amp_vpp)
        self._awg = {"freq": float(freq), "vpp": float(amp_vpp),
                     "offset": float(offset_v), "on": True}
        self._wave = wave_samples(name, 256, duty, edge, custom)
        self._wave_name = name
        self.awg_state = {"waveform": name, "freq": float(freq),
                          "vpp": float(amp_vpp), "offset_v": float(offset_v),
                          "duty": float(duty) if name in ("square", "pulse", "custom") else None,
                          "on": True}

    def output_off(self) -> None:
        self._awg["on"] = False
        self.awg_state.update({"on": False})

    def _z_dc(self):
        """DUT impedance at 0 Hz. None means 'open' — a series capacitor blocks DC."""
        d = self.dut
        kind = d["kind"]
        r = float(d["r"])
        if kind in ("rc_parallel", "resistor", "rl_series"):
            return complex(r, 0.0)
        return None

    def dut_impedance(self, f: float) -> complex:
        w = 2.0 * math.pi * f
        d = self.dut
        r, c, l = float(d["r"]), float(d["c"]), float(d["l"])
        kind = d["kind"]
        if kind == "rc_parallel":
            return r / (1.0 + 1j * w * r * c)
        if kind == "rc_series":
            return r + 1.0 / (1j * w * c)
        if kind == "rl_series":
            return r + 1j * w * l
        if kind == "rlc_series":
            return r + 1j * w * l + 1.0 / (1j * w * c)
        if kind == "resistor":
            return complex(r, 0.0)
        if kind == "capacitor":
            return 1.0 / (1j * w * c)
        raise ValueError("unknown demo DUT %r" % kind)

    def acquire(self, freq: float, dt_target: float, n_samples: int,
                trig: dict | None = None) -> tuple[np.ndarray, np.ndarray, float]:
        _, dt, _ = self.find_timebase(dt_target, n_samples)
        self.last_aq = {"timebase": 0, "dt_s": dt, "samples": n_samples,
                        "sample_rate_hz": 1.0 / dt if dt else 0.0,
                        "record_s": dt * n_samples,
                        "trigger": describe_trigger(trig)}
        if not self._awg["on"]:
            zeros = np.zeros(n_samples, np.int16)
            return zeros, zeros.copy(), dt
        t = np.arange(n_samples) / (1.0 / dt)
        freq = float(freq)
        w = 2.0 * math.pi * freq
        peak_v = self._awg["vpp"] / 2.0
        r_ref = float(self.r_ref)

        # A non-sine drive is a sum of harmonics, and the fixture is linear, so
        # render each harmonic through its own divider. This is why a square wave
        # comes out rounded on a capacitive DUT instead of square.
        cyc = self._wave if len(self._wave) else np.sin(2 * np.pi * np.arange(256) / 256)
        spec = np.fft.rfft(cyc) / cyc.size          # complex amplitude per harmonic
        kmax = min(spec.size - 1, 64, int(0.45 * (1.0 / dt) / max(freq, 1e-9)))

        def render(ph0: float) -> tuple[np.ndarray, np.ndarray]:
            size = np.size(t)
            va = np.zeros(size)
            vb = np.zeros(size)
            for k in range(1, kmax + 1):
                fk = k * freq
                if fk > AWG_MAX_FREQ:
                    break
                ck = 2.0 * spec[k] * peak_v
                if abs(ck) < 1e-12:
                    continue
                zk = self.dut_impedance(fk)
                ztot = AWG_SOURCE_Z + r_ref + zk
                va += np.real(ck * zk / ztot * np.exp(1j * (2 * np.pi * fk * t + ph0 * k)))
                vb += np.real(ck * (r_ref + zk) / ztot * np.exp(1j * (2 * np.pi * fk * t + ph0 * k)))
            # DC bias sees the divider at 0 Hz: a series capacitor blocks it, a
            # resistive path passes it
            bias = float(self._awg.get("offset", 0.0))
            if abs(bias) > 1e-12:
                z0 = self._z_dc()
                if z0 is None:
                    va += bias
                    vb += bias
                else:
                    zt = AWG_SOURCE_Z + r_ref + z0
                    va += float(np.real(bias * z0 / zt))
                    vb += float(np.real(bias * (r_ref + z0) / zt))
            return va, vb

        if trig:
            # find the first crossing of the requested level on the source channel,
            # then shift time so that crossing lands at t = 0
            src = str(trig.get("source", "B")).upper()
            level = float(trig.get("level_v", 0.0))
            want_rising = str(trig.get("dir", "rising")).lower() != "falling"
            m = 1024
            tt = np.arange(m) / (m * freq)
            saved, ph0 = t, 0.0
            t = tt
            va1, vb1 = render(0.0)
            t = saved
            probe = va1 if src == "A" else vb1
            d = probe - level
            idx = None
            for i in range(m):
                if d[i] == 0.0 or (d[i] < 0.0) != (d[(i + 1) % m] < 0.0):
                    rising = probe[(i + 1) % m] > probe[i]
                    if rising == want_rising:
                        idx = i
                        break
            if idx is None:
                ph0 = 0.0
            else:
                frac = abs(d[idx]) / max(1e-12, abs(d[(idx + 1) % m] - d[idx]))
                tau = (idx + min(max(frac, 0.0), 1.0)) / (m * freq)
                # v(t + tau) puts the crossing at t = 0: harmonic k picks up +k*2*pi*f*tau
                ph0 = 2.0 * math.pi * freq * tau
        else:
            ph0 = self._rng.uniform(0.0, 2.0 * math.pi)

        va_t, vb_t = render(ph0)

        def digitise(x, range_idx):
            full = RANGE_TABLE[range_idx]
            lsb = full / self._max_adc
            counts = np.rint(x / lsb + self._rng.normal(0.0, 0.8, x.size))
            return np.clip(counts, -self._max_adc, self._max_adc).astype(np.int16)

        return digitise(va_t, self._range_a), digitise(vb_t, self._range_b), dt

    @property
    def range_indices(self) -> tuple[int, int]:
        return self._range_a, self._range_b


# --------------------------------------------------------------------------
# Manager
# --------------------------------------------------------------------------

@dataclass
class DeviceManager:
    scope: object | None = None
    last_error: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)

    def connect(self, prefer: str = "auto") -> DeviceInfo:
        with self.lock:
            if self.scope is not None:
                return self.scope.info
            self.last_error = ""
            if prefer in ("auto", "hardware"):
                try:
                    hw = Ps2000aScope()
                    info = hw.open()
                    self.scope = hw
                    return info
                except Exception as exc:
                    self.last_error = str(exc)
                    if prefer == "hardware":
                        raise ScopeError(str(exc)) from exc
            sim = SimulatedScope()
            self.scope = sim
            return sim.open()

    def close(self) -> None:
        with self.lock:
            if self.scope is not None:
                self.scope.close()
                self.scope = None

    @property
    def info(self) -> DeviceInfo | None:
        return self.scope.info if self.scope is not None else None
