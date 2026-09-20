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
    </style>
  </head>
  <body>
    <h1>pica — a self-learning code review agent</h1>
    <p class="lead">
      pica reviews pull requests with an LLM and learns from how humans respond.
      A finding humans keep dismissing stops being flagged; one they keep
      confirming gets emphasized. The learning is explicit, auditable, and
      rebuildable from an immutable event log.
    </p>
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
