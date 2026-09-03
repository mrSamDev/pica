import { Counter, Registry } from "prom-client";

// Operational counters (§8). Injected, never module-global, so tests and
// multiple app instances don't share mutable state.
export interface Metrics {
  findingsPosted: Counter<string>;
  findingsSuppressed: Counter<string>;
  outcome: Counter<string>;
  registry: Registry;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  const findingsPosted = new Counter({ name: "findings_posted_total", help: "Findings posted as comments", registers: [registry] });
  const findingsSuppressed = new Counter({ name: "findings_suppressed_total", help: "Findings dropped by the post-filter", registers: [registry] });
  const outcome = new Counter({ name: "outcome_total", help: "Outcome transitions", labelNames: ["outcome"], registers: [registry] });
  return { findingsPosted, findingsSuppressed, outcome, registry };
}
