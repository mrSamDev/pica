import { describe, expect, it } from "vitest";

import { canTransition, isTerminal, reopen, transition } from "../src/learning/feedback/state.ts";

describe("outcome state machine", () => {
  it("accepts valid transitions", () => {
    expect(transition("pending", "posted")).toBe("posted");
    expect(transition("posted", "replied")).toBe("replied");
    expect(transition("posted", "resolved")).toBe("resolved");
    expect(transition("posted", "dismissed")).toBe("dismissed");
    expect(transition("replied", "resolved")).toBe("resolved");
    expect(transition("replied", "dismissed")).toBe("dismissed");
    expect(transition("posted", "inconclusive")).toBe("inconclusive");
    expect(transition("replied", "inconclusive")).toBe("inconclusive");
  });

  it("rejects invalid transitions", () => {
    expect(() => transition("resolved", "posted")).toThrow();
    expect(() => transition("dismissed", "replied")).toThrow();
    expect(() => transition("pending", "resolved")).toThrow();
    expect(() => transition("replied", "posted")).toThrow();
    expect(() => transition("inconclusive", "resolved")).toThrow();
  });

  it("marks terminal states", () => {
    expect(isTerminal("resolved")).toBe(true);
    expect(isTerminal("dismissed")).toBe(true);
    expect(isTerminal("stale")).toBe(true);
    expect(isTerminal("inconclusive")).toBe(true);
    expect(isTerminal("posted")).toBe(false);
    expect(isTerminal("replied")).toBe(false);
    expect(isTerminal("pending")).toBe(false);
  });

  it("terminal states reopen only via probe/manual, never silently", () => {
    // reopen() is the explicit probe/manual path.
    expect(reopen("resolved", "posted")).toBe("posted");
    expect(reopen("dismissed", "posted")).toBe("posted");
    // A normal transition out of a terminal state is rejected.
    expect(() => transition("resolved", "posted")).toThrow();
    // reopen() refuses non-terminal sources and terminal targets.
    expect(() => reopen("posted", "resolved")).toThrow();
    expect(() => reopen("resolved", "dismissed")).toThrow();
  });

  it("canTransition is the non-throwing guard", () => {
    expect(canTransition("posted", "resolved")).toBe(true);
    expect(canTransition("resolved", "posted")).toBe(false);
  });
});
