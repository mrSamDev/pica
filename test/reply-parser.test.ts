import { describe, expect, it } from "vitest";

import { parseReply } from "../src/learning/feedback/reply-parser.ts";

describe("reply-parser", () => {
  it("classifies dismiss / not useful / false positive as dismissal, with reason", () => {
    expect(parseReply("dismiss: this rule is useless")).toEqual({ class: "dismiss", reason: "this rule is useless" });
    expect(parseReply("dismiss")).toEqual({ class: "dismiss" });
    expect(parseReply("not useful")).toEqual({ class: "dismiss" });
    expect(parseReply("not useful because the caller guarantees X")).toEqual({ class: "dismiss" });
    expect(parseReply("false positive")).toEqual({ class: "dismiss" });
  });

  it("classifies good catch / fixed / resolved as positive", () => {
    expect(parseReply("good catch")).toEqual({ class: "positive" });
    expect(parseReply("fixed")).toEqual({ class: "positive" });
    expect(parseReply("resolved")).toEqual({ class: "positive" });
    expect(parseReply("Good catch, thanks!")).toEqual({ class: "positive" });
  });

  it("classifies everything else as neutral", () => {
    expect(parseReply("what about the refresh token?")).toEqual({ class: "neutral" });
    expect(parseReply("")).toEqual({ class: "neutral" });
    expect(parseReply("dismissing users is bad")).toEqual({ class: "neutral" });
    expect(parseReply("can you explain this more?")).toEqual({ class: "neutral" });
  });
});
