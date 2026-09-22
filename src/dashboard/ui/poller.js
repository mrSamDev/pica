// Poll keeps the last good state on transient errors: the operator view must
// not blank out because one request hiccuped. In-flight guard: a slow poll must
// not let the next interval fire overlap and land responses out of order.
export function createPoller(targets) {
  let inFlight = false;
  return async function pollOnce() {
    if (inFlight) return;
    inFlight = true;
    try {
      const responses = await Promise.all(targets.map((target) => fetch(target.url)));
      const bodies = await Promise.all(responses.map((response) => (response.ok ? response.json() : null)));
      bodies.forEach((body, index) => {
        if (body !== null) targets[index].apply(body);
      });
    } finally {
      inFlight = false;
    }
  };
}
