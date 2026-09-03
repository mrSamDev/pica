import { Counter, Gauge, Registry } from "prom-client";

// Operational counters (§8). Injected, never module-global, so tests and
// multiple app instances don't share mutable state.
export interface Metrics {
  findingsPosted: Counter<string>;
  findingsSuppressed: Counter<string>;
  // §5.7: ε-probed findings promoted back into comments (evidence kept flowing).
  probes: Counter<string>;
  outcome: Counter<string>;
  // learning_lag_seconds: time from a pattern's first dismissal to its rule
  // activation. The north-star proof the loop closes. Registered lazily by the
  // /metrics handler so the series is absent (not 0) until a rule activates.
  learningLag: Gauge<string>;
  // §8: rolling-30d share of dismissals among decisive outcomes.
  dismissalRate: Gauge<string>;
  registry: Registry;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  const findingsPosted = new Counter({ name: "findings_posted_total", help: "Findings posted as comments", registers: [registry] });
  const findingsSuppressed = new Counter({ name: "findings_suppressed_total", help: "Findings dropped by the post-filter", registers: [registry] });
  const probes = new Counter({ name: "findings_probed_total", help: "Findings promoted to ε-probes so suppressed patterns keep generating evidence", registers: [registry] });
  const outcome = new Counter({ name: "outcome_total", help: "Outcome transitions", labelNames: ["outcome"], registers: [registry] });
  // registers: [] keeps it out of the registry until the /metrics handler has
  // real data; a registered gauge would otherwise scrape as 0 (misleading).
  const learningLag = new Gauge({ name: "learning_lag_seconds", help: "Time from a pattern's first dismissal to its rule activation", registers: [] });
  const dismissalRate = new Gauge({ name: "pattern_dismissal_rate", help: "Share of dismissals among decisive outcomes in the rolling 30d window", registers: [] });
  return { findingsPosted, findingsSuppressed, probes, outcome, learningLag, dismissalRate, registry };
}
