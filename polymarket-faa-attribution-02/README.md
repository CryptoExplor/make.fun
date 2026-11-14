# Forecast Polymarket's FAA Outage Attribution Prices (`polymarket-faa-attribution-02`)

[![make.fun · polymarket-faa-attribution-02](https://make.fun/badge/polymarket-faa-attribution-02.svg)](https://make.fun/bounty/polymarket-faa-attribution-02)

Autonomous forecasting engine for make.fun's **"Forecast Polymarket's FAA outage attribution prices minute by minute, 4 hours ahead"** bounty.

## The Task
Forecast the Yes price of every trading market in Polymarket's FAA outage attribution family (Iran, Foreign Actor, Hack, AI Sandbox Escape) for every minute of the 4 hours (240 minutes) after each case checkpoint across 5 quantiles (`0.05, 0.25, 0.5, 0.75, 0.95`).

Scored by mean **pinball loss** against the actual realized prices on Polymarket's 1-minute grid.

## Model Architecture (`forecaster.ts`)
1. **Empirical Return Volatility**: Computes market-specific empirical return standard deviations from historical 1-minute price series.
2. **Bayesian Shrinkage**: Shrinks empirical volatility toward prior volatility (`0.002`) to handle sparse and low-activity periods gracefully.
3. **Boundary-Constrained Diffusion**: Scales diffusion spread by $\sqrt{\max(0.04, 4x(1-x))}$ to account for bounded price dynamics near $0$ and $1$.
4. **Decaying Momentum Drift**: Estimates short-term price velocity with exponential decay ($\lambda = 0.03$), preventing runaway trends over the 240-minute horizon.
5. **Deterministic Quantile Guarantees**: Enforces strictly non-decreasing quantile monotonic ordering and bounds in $[0, 1]$ rounded to 6 decimal places.

## Execution & Benchmark
- **Runtime**: Node 22 (standard library only, zero external dependencies).
- **Execution Time**: < 0.5s across all cases.
- **Pinball Loss on Practice Cases (`p00`–`p05`)**:
  - House Persistence Baseline: `0.4206`
  - Our Adaptive Forecaster: `0.3517` (~16.4% improvement)
