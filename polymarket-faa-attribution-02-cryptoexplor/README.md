# Polymarket FAA Outage Attribution — 4-Hour Minute-by-Minute Forecaster
**Bounty ID:** `polymarket-faa-attribution-02` (`make.fun/bounty/polymarket-faa-attribution-02`)  
**Participant Account:** `@cryptoexplor`  
**Forecast Horizon:** `240 minutes ahead (t+1m to t+240m, 1-minute resolution)`  
**Model Architecture:** `ensemble_blend` (Simplex-Constrained Log-Odds Dirichlet-OU + Hawkes Jump-Diffusion)

---

## 1. Overview & Problem Formulation

This repository forecasts Polymarket's **FAA Outage Attribution** conditional token prices minute-by-minute over a rolling **4-hour (240-minute)** horizon.

Let $\mathbf{p}_t = (p_{1,t}, \dots, p_{K,t}) \in \Delta^{K-1}$ denote the vector of implied attribution probabilities across the $K = 5$ mutually exclusive resolution buckets at minute $t \in \{1, 2, \dots, 240\}$:

| Contract Ticker | Outcome ID | Attribution Resolution Bucket | Snapshot Mid ($t=0$) | 4h Terminal Forecast ($t=+240\text{m}$) |
| :--- | :--- | :--- | :---: | :---: |
| `FAA-SW` | `notam_software` | Legacy NOTAM / Database Sync Glitch | `44.50¢` | `53.02¢` |
| `FAA-CFG` | `contractor_config` | Contractor / Engineer File Configuration Error | `25.50¢` | `34.57¢` |
| `FAA-HW` | `telecom_hardware` | Telecom Carrier / Fiber Hardware Failure | `14.50¢` | `7.45¢` |
| `FAA-CYB` | `cyber_intrusion` | Malicious Cyberattack / External Intrusion | `9.50¢` | `1.57¢` |
| `FAA-OTH` | `unattributed_other` | Unattributed / Multi-Factor Pending Deadline | `6.00¢` | `3.39¢` |

At every future minute $t \in [1, 240]$, the model evolves log-odds state variables $\mathbf{y}_t \in \mathbb{R}^K$ and projects onto the probability simplex via the logistic map $\mathbf{p}_t = \operatorname{softmax}(\mathbf{y}_t)$, guaranteeing exact no-arbitrage normalization $\sum_{k=1}^K p_{k,t} = 1.0000$.

---

## 2. Quantitative Model Specification

Each attribution contract $k$ evolves in log-odds space according to a coupled **Ornstein-Uhlenbeck (OU) + Order-Flow Microstructure + Hawkes News Excitation** stochastic differential equation discretized at $\Delta t = 1\text{ min}$:

$$dy_{k,t} = \underbrace{\alpha_{\text{flow}} I_{k,0} \, 2^{-t / \tau_{1/2}}}_{\text{CLOB Order Imbalance Decay}} dt + \underbrace{\theta_k (\bar{y}_{k,t} - y_{k,t})}_{\text{Fundamental Prior Reversion}} dt + \underbrace{\sum_{j: \tau_j \le t} \gamma_{k,j} e^{-\beta (t - \tau_j)}}_{\text{FAA / CISA Telemetry Catalysts}} dt + \sigma_{k,t} dW_{k,t} + J_{k,t} dN_t$$

### Key Alpha Signals
1. **Polymarket CLOB Microstructure ($t + 1\text{m} \to t + 45\text{m}$):** Incorporates top-of-book micro-price and L2 depth imbalance $I_{k,0} = \frac{V^{\text{bid}}_k - V^{\text{ask}}_k}{V^{\text{bid}}_k + V^{\text{ask}}_k}$ with exponential half-life $\tau_{1/2} = 22\text{ min}$.
2. **Scheduled Telemetry & Press Briefing Catalysts ($t + 30\text{m} \to t + 210\text{m}$):** Models scheduled FAA ATCSCC advisories, White House / CISA cyber exclusion readouts, and DOT engineering briefings.
3. **Bayesian Hardware/Software Base-Rate Anchor ($t + 120\text{m} \to t + 240\text{m}$):** Pulls speculative early outage spikes (e.g., initial cyberattack retail overpricing) back toward empirical historical FAA NOTAM/telecom outage base rates.

---

## 3. Repository Structure

```text
polymarket-faa-attribution-02-cryptoexplor/
├── README.md
├── bounty.json                         # make.fun bounty manifest for @cryptoexplor
├── requirements.txt                    # Python dependencies
├── src/
│   ├── data/
│   │   └── polymarket_clob.py          # Polymarket CLOB REST & WebSocket 1m bar ingester
│   ├── model/
│   │   └── forecaster.py               # 240-minute Dirichlet-OU + Hawkes Monte Carlo engine
│   └── evaluate/
│       └── backtest.py                 # CRPS, Brier Score & Calibration evaluator
├── forecasts/
│   ├── forecast_240m_latest.csv        # 240-row minute-by-minute point & quantile forecast
│   └── submission_payload.json         # Complete JSON submission bundle for make.fun
└── .github/
    └── workflows/
        └── forecast_ci.yml             # Automated validation & simplex check workflow
```

---

## 4. Quickstart & Reproduction

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Fetch live Polymarket CLOB snapshot & generate 240-minute forecast
python -m src.model.forecaster --horizon 240 --paths 200 --seed 202602 --output forecasts/forecast_240m_latest.csv

# 3. Run rolling-origin backtest evaluation (Brier, CRPS, Log-Loss)
python -m src.evaluate.backtest --input forecasts/forecast_240m_latest.csv
```
