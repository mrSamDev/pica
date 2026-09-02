export const dashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pica — control room</title>
    <style>
      body { font-family: ui-monospace, monospace; background: #0b0e11; color: #d7dde3; margin: 0; padding: 2rem; }
      h1 { font-size: 1.25rem; color: #e8edf2; }
      .panel { border: 1px solid #2a3138; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
      .panel h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8b98a5; margin: 0 0 0.5rem; }
      .empty { color: #5b6672; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <h1>Pica — control room</h1>
    <div class="panel"><h2>System health</h2><p class="empty">No data yet.</p></div>
    <div class="panel"><h2>Review behavior</h2><p class="empty">No data yet.</p></div>
    <div class="panel"><h2>Learning</h2><p class="empty">No data yet.</p></div>
    <div class="panel"><h2>Recent activity</h2><p class="empty">No data yet.</p></div>
  </body>
</html>`;
