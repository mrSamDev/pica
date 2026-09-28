import { createApp, defineComponent, onMounted, onUnmounted, ref } from "vue";

import { ErrorsApp } from "./errors-app.jsx";
import { ActivityPanel, BehaviorPanel, FailuresPanel, LearningPanel, OutcomesPanel, SystemPanel, VerdictPanel } from "./panels.jsx";
import { LlmPanel } from "./llm-panel.jsx";
import { createPoller } from "./poller.js";

const App = defineComponent({
  setup() {
    const state = ref(null);
    const rules = ref(null);
    let timer = null;

    const poll = createPoller([
      {
        url: "/api/dashboard",
        apply: (body) => {
          state.value = body;
        },
      },
      {
        url: "/api/rules",
        apply: (body) => {
          rules.value = body;
        },
      },
    ]);
    const refresh = () => poll().catch(() => {});

    onMounted(() => {
      refresh();
      timer = setInterval(refresh, 3000);
    });
    onUnmounted(() => clearInterval(timer));

    // Panel order follows the operator's questions: is it working (verdict),
    // can it run (LLM + system), what broke (dedicated failures row), then
    // what happened (behavior/outcomes/learning/activity).
    return () => {
      if (!state.value) return <p class="empty">Loading…</p>;
      const s = state.value;
      return [
        <VerdictPanel verdict={s.verdict} />,
        <div class="status-row">
          <LlmPanel status={s.llm} onCheck={refresh} />
          <SystemPanel system={s.system} />
        </div>,
        <FailuresPanel failures={s.failedReviews} />,
        <div class="grid">
          <BehaviorPanel behavior={s.reviewBehavior} />
          <OutcomesPanel outcomes={s.outcomes} />
          <LearningPanel learning={s.learning} rules={rules.value ?? []} />
          <ActivityPanel activity={s.recentActivity} />
        </div>,
      ];
    };
  },
});

// One bundle serves both operator pages; the path decides which root mounts.
const Root = location.pathname.startsWith("/errors") ? ErrorsApp : App;
createApp(Root).mount("#app");
