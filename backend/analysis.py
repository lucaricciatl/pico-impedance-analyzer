"""Signal analysis for impedance measurement.

All measurements are made with a least-squares fit of a single complex tone at
the known excitation frequency, which is exact for any record length (no
integer-cycle requirement, no window scalloping).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass
class Tone:
    phasor: complex          # complex amplitude, peak-referenced: x(t) = Re(p e^{jwt})
    rms: float               # RMS amplitude of the fitted tone
    offset: float            # DC term of the fit (volts)
    residual_rms: float      # RMS of what the fit did not explain (volts)
    snr_db: float            # 20*log10(tone_rms / residual_rms)


def fit_tone(x: np.ndarray, fs: float, f: float) -> Tone:
    """Least-squares fit of offset + a*cos(wt) + b*sin(wt) at frequency f."""
    x = np.asarray(x, dtype=np.float64)
    n = x.size
    if n < 8:
        raise ValueError("record too short for a tone fit")
    t = np.arange(n, dtype=np.float64) / fs
    w = 2.0 * math.pi * f
    c = np.cos(w * t)
    s = np.sin(w * t)
    basis = np.column_stack((np.ones(n), c, s))
    coef, *_ = np.linalg.lstsq(basis, x, rcond=None)
    offset, a, b = (float(v) for v in coef)
    phasor = complex(a, -b)                     # x = Re(p e^{jwt}) = a cos - b sin
    fitted = basis @ coef
    resid = x - fitted
    tone_rms = abs(phasor) / math.sqrt(2.0)
    res_rms = float(np.sqrt(np.mean(resid * resid)))
    snr = 20.0 * math.log10(tone_rms / res_rms) if res_rms > 0 and tone_rms > 0 else 200.0
    return Tone(phasor=phasor, rms=tone_rms, offset=offset,
                residual_rms=res_rms, snr_db=float(min(snr, 200.0)))


def impedance_from_tones(tone_a: Tone, tone_b: Tone, r_ref: float) -> complex:
    """Z_dut = R_ref * V_a / (V_b - V_a).

    Channel A sits across the DUT, channel B on the source side of R_ref, so the
    current is the drop across the reference resistor. The AWG's own output
    impedance is inside channel B's node and therefore cancels exactly.
    """
    drop = tone_b.phasor - tone_a.phasor
    if abs(drop) < 1e-15:
        raise ZeroDivisionError("no current through reference resistor")
    return r_ref * tone_a.phasor / drop


def clip_fraction(counts: np.ndarray, max_adc: int) -> float:
    """Fraction of samples sitting at the ADC rails."""
    if counts.size == 0:
        return 0.0
    hit = np.count_nonzero(np.abs(counts.astype(np.int32)) >= max_adc - 1)
    return float(hit) / float(counts.size)


def auto_range_peak(volts: np.ndarray) -> float:
    """Robust peak estimate that ignores isolated spikes."""
    if volts.size == 0:
        return 0.0
    return float(np.percentile(np.abs(volts), 99.9))


def log_frequencies(f_start: float, f_stop: float, n: int) -> np.ndarray:
    if f_start <= 0 or f_stop <= 0:
        raise ValueError("frequencies must be positive")
    if n < 2:
        raise ValueError("need at least 2 points")
    return np.geomspace(f_start, f_stop, n)


def lin_frequencies(f_start: float, f_stop: float, n: int) -> np.ndarray:
    if n < 2:
        raise ValueError("need at least 2 points")
    return np.linspace(f_start, f_stop, n)


def equivalent_series(z: complex, f: float) -> dict:
    """Series R/X and the equivalent C or L at this frequency."""
    w = 2.0 * math.pi * f
    re, im = z.real, z.imag
    out = {"rs": re, "xs": im, "c_equiv": None, "l_equiv": None}
    if w > 0 and im != 0.0:
        if im < 0:
            out["c_equiv"] = -1.0 / (w * im)
        else:
            out["l_equiv"] = im / w
    return out
