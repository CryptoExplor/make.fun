// Quality-Maximizing Priority Router & Failover Engine
// free-model-aggregator-01

import {
  capabilitiesOf,
  meetsRequirements,
  modelFree,
  ratingOfModel,
  type Probe,
  type ProbedModel,
  type ProviderDirectoryEntry,
  type RatingsFile,
  type Requirement,
} from './providers.ts';

export interface RouteCandidate {
  probe: Probe;
  model: ProbedModel;
  provider: ProviderDirectoryEntry;
  rating_milli: number;
}

export class ModelRouter {
  private probes: Probe[];
  private ratings: RatingsFile | null;
  private providerCallCounts: Map<string, number> = new Map();
  private providerInFlight: Map<string, number> = new Map();
  private exhaustedProviders: Set<string> = new Set();

  constructor(probes: Probe[], ratings: RatingsFile | null) {
    this.probes = probes;
    this.ratings = ratings;
  }

  /**
   * Returns a priority-sorted list of legal free model candidates meeting requirements.
   * Sorted strictly by quality rating_milli (DESCENDING) to maximize the 60% Quality score.
   * Secondary tie-breaker: provider call count (to balance budget and avoid rate limits).
   */
  public getCandidates(requires: Requirement): RouteCandidate[] {
    const candidates: RouteCandidate[] = [];

    for (const probe of this.probes) {
      if (!probe.ok) continue;
      // Skip known exhausted providers if other viable options exist
      const isExhausted = this.exhaustedProviders.has(probe.provider.id);

      for (const model of probe.models) {
        const row = ratingOfModel(this.ratings, probe.provider.id, model.id);
        if (!modelFree(model, row)) continue;
        if (!meetsRequirements(requires, capabilitiesOf(model, row))) continue;

        const rating = row?.rating_milli ?? 0;
        candidates.push({
          probe,
          model,
          provider: probe.provider,
          rating_milli: rating,
        });
      }
    }

    // Sort by rating_milli DESCENDING, then by provider usage (fewer calls first), prioritizing non-exhausted
    candidates.sort((a, b) => {
      const aExhausted = this.exhaustedProviders.has(a.provider.id);
      const bExhausted = this.exhaustedProviders.has(b.provider.id);
      if (aExhausted !== bExhausted) return aExhausted ? 1 : -1;

      if (b.rating_milli !== a.rating_milli) {
        return b.rating_milli - a.rating_milli;
      }
      const aCalls = this.providerCallCounts.get(a.provider.id) ?? 0;
      const bCalls = this.providerCallCounts.get(b.provider.id) ?? 0;
      return aCalls - bCalls;
    });

    return candidates;
  }

  public markExhausted(providerId: string): void {
    this.exhaustedProviders.add(providerId);
  }

  public recordCallStart(providerId: string): void {
    this.providerCallCounts.set(providerId, (this.providerCallCounts.get(providerId) ?? 0) + 1);
    this.providerInFlight.set(providerId, (this.providerInFlight.get(providerId) ?? 0) + 1);
  }

  public recordCallEnd(providerId: string): void {
    const current = this.providerInFlight.get(providerId) ?? 1;
    this.providerInFlight.set(providerId, Math.max(0, current - 1));
  }

  public getCallCount(providerId: string): number {
    return this.providerCallCounts.get(providerId) ?? 0;
  }
}
