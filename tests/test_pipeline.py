"""Numeric self-check: recover a known impedance from the simulated instrument.

Run: .venv/bin/python -m tests.test_pipeline
"""

import cmath
import math

from backend.engine import PointConfig, measure_point
from backend.scope import SimulatedScope


def check(kind, r, c, l, r_ref, freqs, tol=0.02):
    scope = SimulatedScope()
    scope.open()
    scope.dut = {"kind": kind, "r": r, "c": c, "l": l}
    cfg = PointConfig(r_ref=r_ref, averages=3, auto_range=True)
    worst = 0.0
    print("\n%s  R=%g C=%gF L=%gH  R_ref=%g" % (kind, r, c, l, r_ref))
    print("     f[Hz]      |Z| meas      |Z| true     err%    phase meas  phase true   err deg")
    for f in freqs:
        p = measure_point(scope, f, cfg)
        z_true = scope.dut_impedance(f)
        mag_err = 100.0 * (p["mag"] - abs(z_true)) / abs(z_true)
        ph_err = p["phase_deg"] - math.degrees(cmath.phase(z_true))
        ph_err = (ph_err + 180) % 360 - 180
        worst = max(worst, abs(mag_err), abs(ph_err))
        print("%10.1f  %12.3f  %12.3f  %7.2f  %10.2f  %10.2f  %8.3f"
              % (f, p["mag"], abs(z_true), mag_err, p["phase_deg"],
                 math.degrees(cmath.phase(z_true)), ph_err))
    print("worst error: %.3f (%% or deg)" % worst)
    return worst


if __name__ == "__main__":
    freqs = [10, 100, 1000, 1591.5, 10_000, 50_000, 100_000]
    w = check("rc_parallel", 10_000, 10e-9, 1e-3, 1000, freqs)
    w = max(w, check("rc_series", 470, 100e-9, 1e-3, 1000, freqs))
    w = max(w, check("rl_series", 100, 10e-9, 1e-3, 100, freqs))
    w = max(w, check("resistor", 2200, 10e-9, 1e-3, 1000, freqs))
    print("\nPIPELINE %s (worst %.3f)" % ("OK" if w < 1.0 else "FAIL", w))
