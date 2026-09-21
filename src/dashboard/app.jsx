import { createApp, defineComponent, onMounted, onUnmounted, ref } from "vue";

import { ActivityPanel, BehaviorPanel, FailuresPanel, LearningPanel, OutcomesPanel, SystemPanel, VerdictPanel } from "./panels.jsx";

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

    onMounted(() => {
      pollOnce(state, rules).catch(() => {});
      timer = setInterval(() => {
        pollOnce(state, rules).catch(() => {});
      }, 3000);
    });
    onUnmounted(() => clearInterval(timer));

    return () => {
      if (!state.value) return <p class="empty">Loading…</p>;
      const s = state.value;
      return [
        <VerdictPanel verdict={s.verdict} />,
        <div class="grid">
          <SystemPanel system={s.system} />
          <BehaviorPanel behavior={s.reviewBehavior} />
          <OutcomesPanel outcomes={s.outcomes} />
          <LearningPanel learning={s.learning} rules={rules.value ?? []} />
          <ActivityPanel activity={s.recentActivity} />
          <FailuresPanel failures={s.failedReviews} />
        </div>,
      ];
    };
  },
});

createApp(App).mount("#app");
