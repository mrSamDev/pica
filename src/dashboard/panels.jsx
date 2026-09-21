import { defineComponent } from "vue";

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
    return () => (
      <div class="panel">
        <h2>Review behavior</h2>
        <StatRow k="Findings / PR" v={props.behavior.findingsPerPr} />
        <StatRow k="Posted" v={props.behavior.posted} />
        <StatRow k="Suppressed" v={props.behavior.suppressed} />
        <StatRow k="Duplicate" v={props.behavior.duplicate} />
      </div>
    );
  },
});

export const OutcomesPanel = defineComponent({
  props: { outcomes: { type: Object, required: true } },
  setup(props) {
    return () => (
      <div class="panel">
        <h2>Outcomes</h2>
        <StatRow k="Posted" v={props.outcomes.posted} />
        <StatRow k="Replied" v={props.outcomes.replied} />
        <StatRow k="Resolved" v={props.outcomes.resolved} />
        <StatRow k="Dismissed" v={props.outcomes.dismissed} />
      </div>
    );
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
      const trend = props.learning.dismissalRateTrend;
      return (
        <div class="panel">
          <h2>Learning</h2>
          <StatRow k="Active rules" v={props.learning.activeRules} />
          <StatRow k="Candidate rules" v={props.learning.candidateRules} />
          <StatRow k="Retired rules" v={props.learning.retiredRules} />
          {props.learning.learningLagMs !== null ? <StatRow k="Learning lag (s)" v={Math.round(props.learning.learningLagMs)} /> : <p class="empty">Learning lag: no rule has activated yet.</p>}
          {trend.length > 0 ? <StatRow k="Dismissal rate / review" v={trend.map((r) => Math.round(r * 100) + "%").join(" → ")} /> : null}
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
