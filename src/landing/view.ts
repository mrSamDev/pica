export const landingHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pica — a self-learning code review agent</title>
    <style>
      body {
        font-family: ui-monospace, monospace;
        background: #0b0e11;
        color: #d7dde3;
        margin: 0 auto;
        padding: 3rem 1.5rem 4rem;
        max-width: 46rem;
        line-height: 1.6;
      }
      h1 { font-size: 1.5rem; color: #e8edf2; margin: 0 0 1rem; }
      h2 {
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #8b98a5;
        margin: 3rem 0 0.75rem;
      }
      .lead { color: #d7dde3; font-size: 1rem; max-width: 42rem; margin: 0; }
      section > p { font-size: 0.95rem; margin: 0.6rem 0; }
      .loop { color: #7fb3ff; }
      pre {
        background: #161b20;
        border: 1px solid #2a3138;
        border-radius: 6px;
        padding: 1rem;
        margin: 1.5rem 0 0;
        overflow-x: auto;
        font-size: 0.85rem;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 1rem;
        margin-top: 1rem;
      }
      .panel { border: 1px solid #2a3138; border-radius: 6px; padding: 1rem 1.25rem; }
      .panel h3 { font-size: 0.95rem; color: #e8edf2; margin: 0 0 0.5rem; }
      .panel p { font-size: 0.85rem; color: #b8c2cc; margin: 0; }
      ol.story { padding-left: 1.2rem; font-size: 0.95rem; margin: 0.6rem 0; }
      ol.story li { margin: 0.7rem 0; }
      ol.story code { background: #161b20; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.85rem; }
      .story-note { color: #5b6672; font-size: 0.8rem; margin: 0.4rem 0 0; }
    </style>
  </head>
  <body>
    <h1>pica — a self-learning code review agent</h1>
    <p class="lead">
      pica reviews pull requests on GitHub with an LLM and learns from how
      humans respond. A finding humans keep dismissing stops being flagged; one
      they keep confirming gets emphasized. The learning is explicit, auditable,
      and rebuildable from an immutable event log.
    </p>

    <section>
      <h2>The loop, one story</h2>
      <p class="story-note">Illustrative walkthrough — the shape of the loop, not production numbers.</p>
      <ol class="story">
        <li>
          <strong>PR #142:</strong> pica flags <code>src/auth/session.ts:88</code> — “Session TTL is not
          enforced.” A reviewer dismisses it: <em>“handled at the gateway, not here.”</em>
        </li>
        <li>
          <strong>PRs #149, #163:</strong> the same pattern, the same dismissal. After the third,
          the learner forms a candidate rule (<code>session-ttl</code> in <code>src/auth/**</code>) —
          confidence 74%, evidence: 3 dismissals, 0 confirmations.
        </li>
        <li>
          <strong>PR #177:</strong> the same finding is <em>not posted at all</em>. The dashboard
          shows the suppression; the <code>why</code> drill-down shows the rule, its evidence,
          and the PRs it learned from.
        </li>
        <li>
          <strong>Why this was safe:</strong> suppressed patterns are ε-probed — re-flagged
          occasionally so evidence keeps flowing. If a dismissal turns out to be wrong, the
          rule loses confidence and decays. The <code>/why</code> page answers “why did this
          finding disappear?” for any finding id.
        </li>
      </ol>
    </section>

    <section>
    <pre class="loop">webhook → review job → LLM → findings → post comments → human feedback
                                                       ↓
                                     learning events → rule learner
                                                       ↓
                                          active rules → future reviews</pre>

    <section>
      <h2>Why this experiment</h2>
      <p>
        LLM reviewers flood pull requests with findings. Humans dismiss most of
        them — and after a few weeks they stop reading the bot at all. A
        reviewer that cannot learn from that response is noise with a lag.
      </p>
      <p>
        pica is an experiment in the other direction: treat every dismissal and
        confirmation as a training signal. A pattern dismissed three times stops
        being flagged; a pattern humans keep confirming gets emphasized. The bet
        is measurable — if the dismissal rate does not fall over time, the
        experiment has failed, and the numbers say so.
      </p>
    </section>

    <section>
      <h2>Scope, on purpose</h2>
      <p>
        pica is GitHub-first: PR reviews arrive via webhook and the loop is
        proven there before anything else. An on-repo Bitbucket adapter exists,
        but it is not the focus — breadth waits until the loop shows real-world
        proof. Onboarding is observe-first: install, let it review, respond as
        you normally would. The dashboard states plainly when there is not yet
        enough evidence to judge the loop at all.
      </p>
    </section>

    <section>
      <h2>Core principles</h2>
      <div class="grid">
        <div class="panel">
          <h3>Auditable</h3>
          <p>Every learned rule traces to the evidence that produced it: which findings humans dismissed, how confident it is, when it was last re-checked. No black box.</p>
        </div>
        <div class="panel">
          <h3>Falsifiable</h3>
          <p>Suppressed patterns are ε-probed — occasionally re-flagged so evidence keeps flowing. Stale rules decay and retire. A rule cannot quietly become self-confirming.</p>
        </div>
        <div class="panel">
          <h3>Safe</h3>
          <p>Secrets, auth, injection, data-loss and concurrency findings are never auto-suppressed. A dismissed error-severity finding routes to a human first.</p>
        </div>
        <div class="panel">
          <h3>Rebuildable</h3>
          <p>Human feedback is an immutable event log; rules are a projection of it. Delete the rules, replay the log, get the same rules back.</p>
        </div>
        <div class="panel">
          <h3>Measurable</h3>
          <p>Dismissal rate, suppression rate, learning lag — the time from dismissal to rule activation. Raw numbers decide whether the loop works.</p>
        </div>
        <div class="panel">
          <h3>Real or absent</h3>
          <p>Every stage of the loop is a real implementation or it is not there. No stubs, no pretending to learn.</p>
        </div>
      </div>
    </section>
  </body>
</html>`;
