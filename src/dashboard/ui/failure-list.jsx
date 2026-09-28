import { defineComponent } from "vue";

// One failed-review row, shared by the dashboard panel and the /errors page.
// The request id leads because it is the id an operator greps logs with; the
// BullMQ jobId follows because it is what a redis-cli re-drive needs.
export const FailureList = defineComponent({
  props: { failures: { type: Array, required: true } },
  setup(props) {
    return () => (
      <ul class="activity">
        {props.failures.map((f) => (
          <li key={f.requestId}>
            <div class="failure-head">
              <code class="req">{f.requestId}</code>
              <span class="muted">
                {f.repo} #{f.prId}
              </span>
              <span class="muted">{f.completedAt ? f.completedAt.slice(0, 19) : "undated"}</span>
            </div>
            <div class="err">{f.error}</div>
            <div class="muted">
              re-drive: <code>{f.jobId}</code>
            </div>
          </li>
        ))}
      </ul>
    );
  },
});
