export const dashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pica — control room</title>
    <style>
      body { font-family: ui-monospace, monospace; background: #0b0e11; color: #d7dde3; margin: 0; padding: 2rem; }
      h1 { font-size: 1.25rem; color: #e8edf2; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }
      .panel { border: 1px solid #2a3138; border-radius: 6px; padding: 1rem; }
      .panel h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8b98a5; margin: 0 0 0.5rem; }
      .row { display: flex; justify-content: space-between; padding: 0.2rem 0; font-size: 0.9rem; }
      .row .k { color: #8b98a5; }
      .row .v { color: #e8edf2; }
      .empty { color: #5b6672; font-size: 0.9rem; }
      ul.activity { list-style: none; margin: 0; padding: 0; }
      ul.activity li { padding: 0.3rem 0; border-bottom: 1px solid #1c2228; font-size: 0.85rem; }
      .tag { color: #7fb3ff; }
      .muted { color: #5b6672; }
    </style>
  </head>
  <body>
    <h1>Pica — control room</h1>
    <div class="grid">
      <div class="panel"><h2>System health</h2><div id="system"><p class="empty">Loading…</p></div></div>
      <div class="panel"><h2>Review behavior</h2><div id="behavior"><p class="empty">Loading…</p></div></div>
      <div class="panel"><h2>Outcomes</h2><div id="outcomes"><p class="empty">Loading…</p></div></div>
      <div class="panel"><h2>Learning</h2><div id="learning"><p class="empty">Loading…</p></div></div>
      <div class="panel"><h2>Recent activity</h2><div id="activity"><p class="empty">Loading…</p></div></div>
    </div>
    <script>
      function row(k, v) { return '<div class="row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
      function render(state) {
        document.getElementById('system').innerHTML =
          row('Running', state.system.reviewsRunning) +
          row('Completed', state.system.reviewsCompleted) +
          row('Failed', state.system.reviewsFailed) +
          row('Queue depth', state.system.queueDepth) +
          row('Failed jobs (DLQ)', state.system.failedJobs) +
          '<p class="empty">Failed jobs are retained as the DLQ; re-drive via redis-cli.</p>';
        document.getElementById('behavior').innerHTML =
          row('Findings / PR', state.reviewBehavior.findingsPerPr) +
          row('Posted', state.reviewBehavior.posted) +
          row('Suppressed', state.reviewBehavior.suppressed) +
          row('Duplicate', state.reviewBehavior.duplicate);
        document.getElementById('outcomes').innerHTML =
          row('Posted', state.outcomes.posted) +
          row('Replied', state.outcomes.replied) +
          row('Resolved', state.outcomes.resolved) +
          row('Dismissed', state.outcomes.dismissed);
        document.getElementById('learning').innerHTML =
          row('Active rules', state.learning.activeRules) +
          row('Candidate rules', state.learning.candidateRules) +
          row('Retired rules', state.learning.retiredRules);
        var activity = document.getElementById('activity');
        if (state.recentActivity.length === 0) {
          activity.innerHTML = '<p class="empty">No activity yet.</p>';
        } else {
          activity.innerHTML = '<ul class="activity">' + state.recentActivity.map(function (a) {
            return '<li><span class="tag">' + a.eventType + '</span> <span class="muted">' + a.repo + '</span></li>';
          }).join('') + '</ul>';
        }
      }
      async function poll() {
        try {
          var res = await fetch('/api/dashboard');
          render(await res.json());
        } catch (e) { /* keep last state on transient errors */ }
      }
      poll();
      setInterval(poll, 3000);
    </script>
  </body>
</html>`;
