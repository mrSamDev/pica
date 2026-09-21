import { defineComponent } from "vue";

import { trendDirection } from "./verdict.ts";

// One muted line under each panel header: what it measures and what "good"
// looks like, so an operator never has to guess at a number.

export const StatRow = defineComponent({
  props: {
    k: { type: String, required: true },
    v: { type: [String, Number], required: true },
  },
  setup(props) {
    return () => (
      <div class="row">
        <span class="k">{props.k}</span>
        <span class="v">{String(props.v)}</span>
      </div>
    );
  },
});

function sparkPoints(rates) {
  if (rates.length < 2) return null;
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const span = max - min || 1;
  return rates.map((r, i) => `${(i / (rates.length - 1)) * 100},${30 - ((r - min) / span) * 26 - 2}`).join(" ");
}

function trendLabel(rates) {
  const first = rates[0];
  const last = rates[rates.length - 1];
  const span = first !== undefined && last !== undefined ? ` ${Math.round(first * 100)}% → ${Math.round(last * 100)}% ·` : "";
  const meaning = {
    falling: "falling = the loop is learning",
    rising: "rising = reviews are getting noisier — investigate",
    steady: "steady — the loop has not yet shown movement",
    short: "not enough reviewed PRs to call a trend yet",
  }[trendDirection(rates)];
  return `${span} ${meaning}`;
}

export const TrendSection = defineComponent({
  props: { rates: { type: Array, required: true } },
  setup(props) {
    return () => {
      if (props.rates.length === 0) {
        return [<p class="empty">No dismissal-rate trend yet — it appears once reviews produce decisive outcomes.</p>];
      }
      const points = sparkPoints(props.rates);
      return [
        points ? (
          <svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="Dismissal rate per review over time">
            <polyline points={points} />
          </svg>
        ) : (
          <StatRow k="Dismissal rate / review" v={Math.round(props.rates[0] * 100) + "%"} />
        ),
        <p class="insight">
          Dismissal rate per review{points ? ", oldest → newest" : ""}: {trendLabel(props.rates)}
        </p>,
      ];
    };
  },
});

export const VerdictPanel = defineComponent({
  props: { verdict: { type: Object, required: true } },
  setup(props) {
    return () => (
      <div class={["panel", "verdict", props.verdict.status]}>
        <h2>Verdict</h2>
        <p class="headline">{props.verdict.headline}</p>
        <ul class="reasons">
          {props.verdict.reasons.map((r) => (
            <li>{r}</li>
          ))}
        </ul>
        <p class="next">
          <span class="k">Next </span>
          {props.verdict.nextActions.join(" · ")}
        </p>
      </div>
    );
  },
});

export const SystemPanel = defineComponent({
  props: { system: { type: Object, required: true } },
  setup(props) {
    return () => (
      <div class="panel">
        <h2>System health</h2>
        <p class="explain">Queue depth is work waiting to run. Anything failed or stuck in the DLQ needs a human — that is what the verdict's attention state watches.</p>
        <StatRow k="Running" v={props.system.reviewsRunning} />
        <StatRow k="Completed" v={props.system.reviewsCompleted} />
        <StatRow k="Failed" v={props.system.reviewsFailed} />
        <StatRow k="Queue depth" v={props.system.queueDepth} />
        <StatRow k="Failed jobs (DLQ)" v={props.system.failedJobs} />
        <p class="empty">Failed jobs are retained as the DLQ; re-drive via redis-cli.</p>
      </div>
    );
  },
});

export const BehaviorPanel = defineComponent({
  props: { behavior: { type: Object, required: true } },
  setup(props) {
    return () => {
      const reviewed = props.behavior.posted + props.behavior.suppressed;
      const share = reviewed > 0 && props.behavior.suppressed > 0 ? Math.round((props.behavior.suppressed / reviewed) * 100) + "%" : null;
      return (
        <div class="panel">
          <h2>Review behavior</h2>
          <p class="explain">What pica did with findings. Suppressed findings were filtered by learned rules before they ever reached you — that is noise the loop already removed.</p>
          <StatRow k="Findings / PR" v={props.behavior.findingsPerPr} />
          <StatRow k="Posted" v={props.behavior.posted} />
          <StatRow k="Suppressed" v={props.behavior.suppressed} />
          <StatRow k="Duplicate" v={props.behavior.duplicate} />
          {share ? <p class="insight">{share} of posted-side findings were auto-suppressed by learned rules.</p> : null}
        </div>
      );
    };
  },
});

export const OutcomesPanel = defineComponent({
  props: { outcomes: { type: Object, required: true } },
  setup(props) {
    return () => {
      const decisive = props.outcomes.dismissed + props.outcomes.resolved;
      const dismissalShare = decisive > 0 ? Math.round((props.outcomes.dismissed / decisive) * 100) + "%" : null;
      return (
        <div class="panel">
          <h2>Outcomes</h2>
          <p class="explain">How humans responded to posted findings. Every dismissal or resolution is a training signal; replies are treated as neutral.</p>
          <StatRow k="Posted" v={props.outcomes.posted} />
          <StatRow k="Replied" v={props.outcomes.replied} />
          <StatRow k="Resolved" v={props.outcomes.resolved} />
          <StatRow k="Dismissed" v={props.outcomes.dismissed} />
          {dismissalShare ? (
            <p class="insight">
              Humans dismissed {dismissalShare} of the {decisive} decisive outcomes — that share feeding the learned rules.
            </p>
          ) : null}
        </div>
      );
    };
  },
});

export const ProbesSection = defineComponent({
  props: { probes: { type: Array, required: true } },
  setup(props) {
    return () => {
      if (props.probes.length === 0) {
        return [<h2>ε-probes</h2>, <p class="empty">None yet — nothing suppressed to re-check.</p>];
      }
      return [
        <h2>ε-probes (suppressed patterns still generating evidence)</h2>,
        <ul class="activity">
          {props.probes.map((p) => (
            <li key={p.patternId}>
              <code>{p.filePath}</code> <span class="muted">{p.at ? p.at.slice(0, 10) : ""}</span>
            </li>
          ))}
        </ul>,
      ];
    };
  },
});

export const RulesSection = defineComponent({
  props: { rules: { type: Array, required: true } },
  setup(props) {
    return () => {
      if (props.rules.length === 0) {
        return [<h2>Rules</h2>, <p class="empty">No rules yet. Dismissed findings accumulate here as candidate and active rules.</p>];
      }
      return [
        <h2>Rules</h2>,
        ...props.rules.map((r) => (
          <div class="rule" key={r.id}>
            <span class="tag">
              {r.ruleType}:{r.status}
            </span>
            <span class="k">{r.pattern || r.id}</span>
            <span class="muted">
              conf {r.confidence !== null ? Math.round(r.confidence * 100) + "%" : "—"} · ev {r.evidenceCount} (neg {r.negativeCount}, pos {r.positiveCount}) · {r.createdAt ? r.createdAt.slice(0, 10) : ""}
            </span>
          </div>
        )),
      ];
    };
  },
});

export const LearningPanel = defineComponent({
  props: { learning: { type: Object, required: true }, rules: { type: Array, required: true } },
  setup(props) {
    return () => {
      return (
        <div class="panel">
          <h2>Learning</h2>
          <p class="explain">Rules are the loop's memory: active rules shape future reviews, candidates are still collecting evidence, retired ones decayed away. The trend is the whole bet.</p>
          <StatRow k="Active rules" v={props.learning.activeRules} />
          <StatRow k="Candidate rules" v={props.learning.candidateRules} />
          <StatRow k="Retired rules" v={props.learning.retiredRules} />
          {props.learning.learningLagMs !== null ? <StatRow k="Learning lag (s)" v={Math.round(props.learning.learningLagMs)} /> : <p class="empty">Learning lag: no rule has activated yet.</p>}
          <TrendSection rates={props.learning.dismissalRateTrend} />
          <ProbesSection probes={props.learning.probes} />
          <RulesSection rules={props.rules} />
        </div>
      );
    };
  },
});

export const ActivityPanel = defineComponent({
  props: { activity: { type: Array, required: true } },
  setup(props) {
    return () => (
      <div class="panel">
        <h2>Recent activity</h2>
        <p class="explain">The raw learning-event stream — the audit trail every rule and metric on this page is derived from.</p>
        {props.activity.length === 0 ? (
          <p class="empty">No activity yet.</p>
        ) : (
          <ul class="activity">
            {props.activity.map((a, i) => (
              <li key={i}>
                <span class="tag">{a.eventType}</span> <span class="muted">{a.repo}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
});

export const FailuresPanel = defineComponent({
  props: { failures: { type: Array, required: true } },
  setup(props) {
    return () => (
      <div class="panel">
        <h2>Failed reviews</h2>
        <p class="explain">Reviews that errored, with the reason each one failed. Empty here means the pipeline is not silently dropping anything.</p>
        {props.failures.length === 0 ? (
          <p class="empty">No failed reviews.</p>
        ) : (
          props.failures.map((f) => (
            <div class="rule" key={f.jobId}>
              <code>{f.jobId}</code>
              <span class="muted">{f.completedAt ? f.completedAt.slice(0, 19) : ""}</span>
              <div class="err">{f.error}</div>
            </div>
          ))
        )}
      </div>
    );
  },
});
