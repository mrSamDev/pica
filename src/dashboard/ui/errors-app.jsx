import { defineComponent, onMounted, onUnmounted, ref } from "vue";

import { FailureList } from "./failure-list.jsx";
import { createPoller } from "./poller.js";

// The dedicated failed-reviews page. Same bundle as the dashboard, mounted here
// when location.pathname starts with /errors (see app.jsx).
export const ErrorsApp = defineComponent({
  setup() {
    const state = ref(null);
    let timer = null;

    const poll = createPoller([
      {
        url: "/api/errors",
        apply: (body) => {
          state.value = body;
        },
      },
    ]);
    const refresh = () => poll().catch(() => {});

    onMounted(() => {
      refresh();
      timer = setInterval(refresh, 3000);
    });
    onUnmounted(() => clearInterval(timer));

    return () => {
      if (!state.value) return <p class="empty">Loading…</p>;
      const { total, failures } = state.value;
      return (
        <div class="panel">
          <p class="explain">Every errored review, oldest first. The request id is the same id in the webhook, queue job, and logs — grep it to follow one failure end to end.</p>
          <p class="insight">
            Showing {failures.length} of {total} failed {total === 1 ? "review" : "reviews"}.
          </p>
          {failures.length === 0 ? <p class="empty">No failed reviews.</p> : <FailureList failures={failures} />}
        </div>
      );
    };
  },
});
