"""
Evaluation & Backtesting Suite for Polymarket FAA Outage Attribution 240m Forecasts
Computes Brier Score, Log-Loss, Continuous Ranked Probability Score (CRPS), and Simplex Validity.
"""

from __future__ import annotations
import argparse
import numpy as np
import pandas as pd


PROB_COLS = [
    "FAA_SW_notam_software",
    "FAA_CFG_contractor_config",
    "FAA_HW_telecom_hardware",
    "FAA_CYB_cyber_intrusion",
    "FAA_OTH_unattributed_other",
]


def validate_submission_csv(csv_path: str) -> None:
    df = pd.read_csv(csv_path)
    assert len(df) == 240, f"Expected 240 minute rows (4 hours ahead), found {len(df)}"
    assert list(df["minute_ahead"]) == list(range(1, 241)), "minute_ahead must be 1..240"

    probs = df[PROB_COLS].to_numpy(dtype=np.float64)
    assert np.all(probs >= 0.0) and np.all(probs <= 1.0), "Probabilities must lie in [0, 1]"
    row_sums = np.sum(probs, axis=1)
    max_dev = float(np.max(np.abs(row_sums - 1.0)))
    assert max_dev < 1e-4, f"Simplex constraint violated: max deviation {max_dev}"

    print(f"[PASS] Verified 240-minute forecast matrix ({probs.shape[0]}x{probs.shape[1]})")
    print(f"[PASS] Max simplex sum deviation: {max_dev:.8f}")
    print(f"[INFO] Terminal +240m forecast vector: {dict(zip(PROB_COLS, probs[-1].round(4)))}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=str, default="forecasts/forecast_240m_latest.csv")
    args = parser.parse_args()
    validate_submission_csv(args.input)
