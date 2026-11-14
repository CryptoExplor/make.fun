"""
Polymarket FAA Outage Attribution Forecaster (Minute-by-Minute, 4 Hours Ahead)
Bounty: polymarket-faa-attribution-02 | Account: @cryptoexplor
"""

from __future__ import annotations
import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, List
import numpy as np
import pandas as pd


OUTCOME_IDS: List[str] = [
    "notam_software",
    "contractor_config",
    "telecom_hardware",
    "cyber_intrusion",
    "unattributed_other",
]


@dataclass
class ContractSpec:
    outcome_id: str
    ticker: str
    current_price: float
    order_imbalance: float
    long_term_prior: float
    mean_reversion_speed: float
    volatility: float


DEFAULT_CONTRACTS: List[ContractSpec] = [
    ContractSpec("notam_software", "FAA-SW", 0.445, 0.34, 0.48, 0.022, 0.018),
    ContractSpec("contractor_config", "FAA-CFG", 0.255, 0.18, 0.28, 0.025, 0.019),
    ContractSpec("telecom_hardware", "FAA-HW", 0.145, -0.12, 0.13, 0.02, 0.016),
    ContractSpec("cyber_intrusion", "FAA-CYB", 0.095, -0.45, 0.05, 0.032, 0.026),
    ContractSpec("unattributed_other", "FAA-OTH", 0.06, -0.08, 0.06, 0.018, 0.014),
]


class DirichletOUHawkesForecaster:
    """
    Simplex-constrained log-odds Ornstein-Uhlenbeck + Hawkes jump-diffusion
    forecaster producing 1-minute resolution trajectories over a 240-minute horizon.
    """

    def __init__(
        self,
        contracts: List[ContractSpec],
        horizon_minutes: int = 240,
        num_paths: int = 200,
        order_flow_half_life_min: float = 22.0,
        vol_multiplier: float = 1,
        mean_rev_strength: float = 1,
        hawkes_intensity: float = 0.35,
        seed: int = 202602,
    ) -> None:
        self.contracts = contracts
        self.horizon_minutes = horizon_minutes
        self.num_paths = num_paths
        self.order_flow_half_life_min = order_flow_half_life_min
        self.vol_multiplier = vol_multiplier
        self.mean_rev_strength = mean_rev_strength
        self.hawkes_intensity = hawkes_intensity
        self.rng = np.random.default_rng(seed)

    @staticmethod
    def _softmax(logits: np.ndarray) -> np.ndarray:
        shifted = logits - np.max(logits, axis=-1, keepdims=True)
        exps = np.exp(shifted)
        return exps / np.sum(exps, axis=-1, keepdims=True)

    def simulate_trajectories(self) -> Dict[str, np.ndarray]:
        k = len(self.contracts)
        prices_0 = np.array([max(1e-4, c.current_price) for c in self.contracts], dtype=np.float64)
        prices_0 /= np.sum(prices_0)

        priors = np.array([max(1e-4, c.long_term_prior) for c in self.contracts], dtype=np.float64)
        priors /= np.sum(priors)

        imbalances = np.array([c.order_imbalance for c in self.contracts], dtype=np.float64)
        thetas = np.array([c.mean_reversion_speed for c in self.contracts], dtype=np.float64) * self.mean_rev_strength
        sigmas = np.array([c.volatility for c in self.contracts], dtype=np.float64) * self.vol_multiplier

        # Scheduled telemetry catalyst shocks (minute -> delta logits)
        catalysts: Dict[int, np.ndarray] = {
            35: np.array([0.14, 0.09, -0.06, -0.18, -0.05], dtype=np.float64),
            85: np.array([0.11, 0.16, 0.02, -0.52, -0.04], dtype=np.float64),
            150: np.array([0.18, 0.24, -0.18, -0.22, -0.14], dtype=np.float64),
            210: np.array([0.08, 0.15, -0.12, -0.1, -0.12], dtype=np.float64),
        }

        logits = np.tile(np.log(prices_0), (self.num_paths, 1))
        target_logits = np.tile(np.log(priors), (self.num_paths, 1))
        hawkes_state = np.zeros((self.num_paths, k), dtype=np.float64)

        all_paths = np.zeros((self.num_paths, self.horizon_minutes, k), dtype=np.float64)

        for minute in range(1, self.horizon_minutes + 1):
            vol_boost = 1.0
            if minute in catalysts:
                shock = catalysts[minute]
                target_logits += shock * 0.85
                hawkes_state += shock * 0.45
                vol_boost = 1.6

            flow_decay = 0.5 ** (minute / max(3.0, self.order_flow_half_life_min))
            flow_drift = imbalances * 0.016 * flow_decay
            ou_drift = thetas * (target_logits - logits)
            hawkes_step = hawkes_state * 0.22
            hawkes_state *= 0.78

            noise = self.rng.standard_normal((self.num_paths, k)) * (sigmas * vol_boost)
            jump_mask = self.rng.random((self.num_paths, k)) < (self.hawkes_intensity * 0.03)
            jump_noise = jump_mask * self.rng.standard_normal((self.num_paths, k)) * (sigmas * 1.9)

            logits = logits + flow_drift + ou_drift + hawkes_step + noise + jump_noise
            all_paths[:, minute - 1, :] = self._softmax(logits)

        mean_forecast = np.mean(all_paths, axis=0)
        mean_forecast /= np.sum(mean_forecast, axis=-1, keepdims=True)

        return {
            "mean": mean_forecast,
            "p10": np.quantile(all_paths, 0.10, axis=0),
            "p90": np.quantile(all_paths, 0.90, axis=0),
            "p025": np.quantile(all_paths, 0.025, axis=0),
            "p975": np.quantile(all_paths, 0.975, axis=0),
        }

    def to_dataframe(self, start_time: datetime | None = None) -> pd.DataFrame:
        if start_time is None:
            start_time = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        sim = self.simulate_trajectories()
        mean_probs = sim["mean"]
        p10_probs = sim["p10"]
        p90_probs = sim["p90"]

        rows = []
        for m in range(1, self.horizon_minutes + 1):
            idx = m - 1
            ts = start_time + timedelta(minutes=m)
            probs = mean_probs[idx]
            entropy = float(-np.sum(probs * np.log2(np.clip(probs, 1e-12, 1.0))))
            rows.append({
                "minute_ahead": m,
                "timestamp_utc": ts.isoformat(),
                "FAA_SW_notam_software": round(float(probs[0]), 6),
                "FAA_CFG_contractor_config": round(float(probs[1]), 6),
                "FAA_HW_telecom_hardware": round(float(probs[2]), 6),
                "FAA_CYB_cyber_intrusion": round(float(probs[3]), 6),
                "FAA_OTH_unattributed_other": round(float(probs[4]), 6),
                "simplex_sum": round(float(np.sum(probs)), 6),
                "shannon_entropy_bits": round(entropy, 4),
                "FAA_SW_p10": round(float(p10_probs[idx, 0]), 6),
                "FAA_SW_p90": round(float(p90_probs[idx, 0]), 6),
            })
        return pd.DataFrame(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Polymarket FAA Outage Attribution 240m Forecaster")
    parser.add_argument("--horizon", type=int, default=240, help="Forecast horizon in minutes (default: 240)")
    parser.add_argument("--paths", type=int, default=200, help="Number of Monte Carlo paths")
    parser.add_argument("--seed", type=int, default=202602, help="Random seed")
    parser.add_argument("--output", type=str, default="forecasts/forecast_240m_latest.csv", help="Output CSV path")
    args = parser.parse_args()

    forecaster = DirichletOUHawkesForecaster(
        contracts=DEFAULT_CONTRACTS,
        horizon_minutes=args.horizon,
        num_paths=args.paths,
        seed=args.seed,
    )
    df = forecaster.to_dataframe()
    df.to_csv(args.output, index=False)
    print(f"[OK] Saved {len(df)} minute-by-minute forecast rows to {args.output}")


if __name__ == "__main__":
    main()
