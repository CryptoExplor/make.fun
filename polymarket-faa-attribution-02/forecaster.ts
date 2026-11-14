/**
 * Polymarket FAA Outage Attribution Forecaster (polymarket-faa-attribution-02)
 *
 * Forecasts the Yes price of every trading market in Polymarket's FAA outage
 * attribution family minute-by-minute over a 240-minute horizon across 5 quantiles:
 * [0.05, 0.25, 0.5, 0.75, 0.95].
 *
 * Algorithm:
 * - Market-adaptive volatility estimated from historical 1-minute price returns.
 * - Bayesian shrinkage towards prior volatility (0.002).
 * - Bounded diffusion factor scaling variance as prices approach boundaries [0, 1].
 * - Exponentially decaying momentum drift.
 * - Strictly non-decreasing quantile enforcement and 6-decimal rounding.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

interface CaseMarket {
  id: string;
  name?: string;
  slug?: string;
  yes_token?: string;
  start?: string;
  prices: number[];
}

interface Case {
  schema?: string;
  competition?: string;
  case: string;
  at: string;
  horizon_minutes: number;
  quantiles: number[];
  event?: unknown;
  markets: CaseMarket[];
}

const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

export function forecastMarket(m: CaseMarket, horizon: number): number[][] {
  const prices = m.prices;
  const n = prices.length;
  if (n === 0) throw new Error(`Market ${m.id} has no prices`);

  const x = prices[n - 1] as number;

  // 1. Empirical rolling volatility
  const window = Math.min(n - 1, 240);
  let sumSq = 0;
  let diffCount = 0;
  for (let k = n - window; k < n; k++) {
    const d = (prices[k] as number) - (prices[k - 1] as number);
    sumSq += d * d;
    diffCount++;
  }
  const empSigma = diffCount > 10 ? Math.sqrt(sumSq / diffCount) : 0.0025;
  const sigma = 0.65 * empSigma + 0.35 * 0.002;

  // 2. Bounded diffusion scaling near 0 and 1
  const boundFactor = Math.sqrt(Math.max(0.04, 4 * x * (1 - x)));
  const effSigma = sigma * boundFactor;

  // 3. Short-term drift with exponential decay
  const momWindow = Math.min(n - 1, 30);
  const rawDrift = momWindow > 5 ? ((prices[n - 1] as number) - (prices[n - 1 - momWindow] as number)) / momWindow : 0;
  const clampedDrift = Math.max(-0.0005, Math.min(0.0005, rawDrift)) * 0.2;
  const lambda = 0.03;

  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const cumDrift = clampedDrift * (1 - Math.exp(-lambda * h)) / lambda;
    const center = Math.min(1, Math.max(0, x + cumDrift));
    const spread = effSigma * Math.sqrt(h);

    const row = Z.map((z) => price6(center + z * spread));
    for (let j = 1; j < row.length; j++) {
      if ((row[j] as number) < (row[j - 1] as number)) {
        row[j] = row[j - 1] as number;
      }
    }
    rows.push(row);
  }

  return rows;
}

export function runForecaster(inputDir: string, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  const inputs = readdirSync(inputDir).filter((f) => f.endsWith('.in')).sort();
  for (const file of inputs) {
    const id = file.slice(0, -'.in'.length);
    const content = readFileSync(join(inputDir, file), 'utf8');
    const c = JSON.parse(content) as Case;

    if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) {
      throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, expected ${JSON.stringify(QUANTILES)}`);
    }

    const forecasts = c.markets.map((m) => ({
      id: m.id,
      q: forecastMarket(m, c.horizon_minutes),
    }));

    writeFileSync(join(outputDir, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
  }
}
