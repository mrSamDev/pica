import { defineComponent, onMounted, ref } from "vue";

import { StatRow } from "./panels.jsx";

// Probes once on first load when no status is cached; after that the button is
// the only trigger, so the 3s poll never generates a model request.
export const LlmPanel = defineComponent({
  props: {
    status: { type: Object, default: null },
    onCheck: { type: Function, required: true },
  },
  setup(props) {
    const checking = ref(false);

    const runCheck = async () => {
      if (checking.value) return;
      checking.value = true;
      try {
        const res = await fetch("/api/llm-status", { method: "POST" }).catch(() => null);
        if (res?.ok) await props.onCheck();
      } finally {
        checking.value = false;
      }
    };

    onMounted(() => {
      if (!props.status) runCheck();
    });

    return () => {
      const status = props.status;
      const label = status === null ? "Run check" : status.reachable ? "Re-check" : "Retry";
      return (
        <div class="panel">
          <h2>LLM provider</h2>
          <p class="explain">The model every review runs through. The check is a real request down the same path a review takes, so a green status means reviews can run.</p>
          {status === null ? (
            <p class="empty">Not checked yet.</p>
          ) : (
            <>
              <StatRow k="Provider" v={status.provider} />
              <StatRow k="Model" v={status.model} />
              <StatRow k="Status" v={status.reachable ? "reachable" : "unreachable"} />
              {status.reachable ? <StatRow k="Latency (ms)" v={status.latencyMs ?? "—"} /> : null}
              <StatRow k="Checked" v={status.checkedAt.replace("T", " ").slice(0, 19)} />
              {status.error ? <div class="err">{status.error}</div> : null}
            </>
          )}
          <button class="action" onClick={runCheck} disabled={checking.value}>
            {checking.value ? "Checking…" : label}
          </button>
        </div>
      );
    };
  },
});
