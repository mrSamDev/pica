import { createApp, defineComponent, onMounted, onUnmounted, ref } from "vue";

import { ActivityPanel, BehaviorPanel, FailuresPanel, LearningPanel, OutcomesPanel, SystemPanel, VerdictPanel } from "./panels.jsx";
import { LlmPanel } from "./llm-panel.jsx";

// Poll keeps the last good state on transient errors: the control room must
// not blank out because one request hiccuped. In-flight guard: a slow poll
// must not let the next interval fire overlap and land responses out of order.
let inFlight = false;
async function pollOnce(state, rules) {
  if (inFlight) return;
  inFlight = true;
  try {
    const [dashboard, ruleList] = await Promise.all([fetch("/api/dashboard"), fetch("/api/rules")]);
    if (dashboard.ok) state.value = await dashboard.json();
    if (ruleList.ok) rules.value = await ruleList.json();
  } finally {
    inFlight = false;
  }
}

const App = defineComponent({
  setup() {
    const state = ref(null);
    const rules = ref(null);
    let timer = null;

    const refresh = () => pollOnce(state, rules).catch(() => {});

    onMounted(() => {
      refresh();
      timer = setInterval(refresh, 3000);
    });
    onUnmounted(() => clearInterval(timer));

    // Panel order follows the operator's questions: is it working (verdict),
    // can it run (LLM + system), what happened (behavior/outcomes/learning),
    // what broke (failures/activity).
    return () => {
      if (!state.value) return <p class="empty">Loading…</p>;
      const s = state.value;
      return [
        <VerdictPanel verdict={s.verdict} />,
        <div class="status-row">
          <LlmPanel status={s.llm} onCheck={refresh} />
          <SystemPanel system={s.system} />
        </div>,
        <div class="grid">
          <BehaviorPanel behavior={s.reviewBehavior} />
          <OutcomesPanel outcomes={s.outcomes} />
          <LearningPanel learning={s.learning} rules={rules.value ?? []} />
          <FailuresPanel failures={s.failedReviews} />
          <ActivityPanel activity={s.recentActivity} />
        </div>,
      ];
    };
  },
});

createApp(App).mount("#app");
