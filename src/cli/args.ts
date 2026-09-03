// Pure argv parsing for the review-agent CLI. No commander dependency — the
// command surface is small and fixed (§11), and a hand-rolled parser keeps
// usage errors explicit.

import { z } from "zod";

import type { ManualRulePayload } from "../learning/rules/manual.ts";

export type Command =
  | { name: "review"; repo: string; prId: string; diffHref: string; dryRun: boolean }
  | { name: "explain-rule"; repo: string; ruleId?: string; patternId?: string }
  | { name: "rule-add"; repo: string; ruleType: string; glob: string | null; payload: ManualRulePayload }
  | { name: "rule-retire"; repo: string; ruleId?: string; patternId?: string; glob?: string; retiredBy: string }
  | { name: "eval"; casesPath: string; goldenPath: string }
  | { name: "report"; weekly: boolean; repo?: string }
  | { name: "confirm-dismissal"; repo: string; findingId: string; confirmedBy: string }
  | { name: "rebuild-read-model" };

const USAGE = `usage: review-agent <command> [args]

  review --dry-run --repo <repo> --pr <id> --diff-href <url>
  explain-rule <repo> [--rule <id> | --pattern <uuid>]
  rule add <repo> (--ignore <glob> | --emphasize <pattern> | --style <text> | --scope <prefix>) [--reason <text>] [--review-depth <d>]
  rule retire <repo> (--rule <id> | --pattern <uuid> | --ignore <glob>) [--by <user>]
  eval --replay <cases.json> --golden <golden.json>
  report --weekly [--repo <repo>]
  confirm-dismissal <repo> --finding <id> [--by <user>]
  rebuild-read-model`;

interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseFlags(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const next = argv[i + 1];
    if (inline !== undefined) {
      flags.set(key, inline);
    } else if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { positionals, flags };
}

function required(flags: Parsed["flags"], name: string): string {
  const parsed = z.string().min(1).safeParse(flags.get(name));
  if (!parsed.success) {
    throw new Error(`missing required flag --${name}\n${USAGE}`);
  }
  return parsed.data;
}

function optional(flags: Parsed["flags"], name: string): string | undefined {
  const parsed = z.string().min(1).safeParse(flags.get(name));
  return parsed.success ? parsed.data : undefined;
}

export function parseArgs(argv: string[]): Command {
  if (argv.length === 0) {
    throw new Error(USAGE);
  }
  const [command, ...rest] = argv;
  const { positionals, flags } = parseFlags(rest);

  switch (command) {
    case "review": {
      if (flags.get("dry-run") !== true) {
        throw new Error("only --dry-run is supported in this phase\n" + USAGE);
      }
      return { name: "review", repo: required(flags, "repo"), prId: required(flags, "pr"), diffHref: required(flags, "diff-href"), dryRun: true };
    }
    case "explain-rule": {
      const repo = positionals[0];
      if (!repo) throw new Error(`explain-rule needs a repo\n${USAGE}`);
      const ruleId = optional(flags, "rule");
      const patternId = optional(flags, "pattern");
      if (ruleId !== undefined && patternId !== undefined) {
        throw new Error(`explain-rule takes --rule or --pattern, not both\n${USAGE}`);
      }
      if (ruleId === undefined && patternId === undefined && positionals.length > 1) {
        throw new Error(`explain-rule takes --rule or --pattern, not positional ids\n${USAGE}`);
      }
      return { name: "explain-rule", repo, ruleId, patternId };
    }
    case "rule": {
      const sub = positionals[0];
      const repo = positionals[1];
      if (!sub || !repo) throw new Error(`rule needs <add|retire> <repo>\n${USAGE}`);
      if (sub === "add") {
        const ignore = optional(flags, "ignore");
        const emphasize = optional(flags, "emphasize");
        const style = optional(flags, "style");
        const scope = optional(flags, "scope");
        const chosen = [ignore, emphasize, style, scope].filter((v) => v !== undefined);
        if (chosen.length !== 1) {
          throw new Error(`rule add needs exactly one of --ignore/--emphasize/--style/--scope\n${USAGE}`);
        }
        const reason = optional(flags, "reason");
        if (ignore !== undefined) return { name: "rule-add", repo, ruleType: "ignore", glob: ignore, payload: reason ? { reason } : {} };
        if (emphasize !== undefined) return { name: "rule-add", repo, ruleType: "emphasize", glob: null, payload: reason ? { pattern: emphasize, reason } : { pattern: emphasize } };
        if (style !== undefined) return { name: "rule-add", repo, ruleType: "style", glob: null, payload: { description: style } };
        return { name: "rule-add", repo, ruleType: "scope", glob: null, payload: { pathPrefix: scope, reviewDepth: optional(flags, "review-depth") ?? "standard" } };
      }
      if (sub === "retire") {
        const ruleId = optional(flags, "rule");
        const patternId = optional(flags, "pattern");
        const glob = optional(flags, "ignore");
        if (ruleId === undefined && patternId === undefined && glob === undefined) {
          throw new Error(`rule retire needs --rule, --pattern, or --ignore\n${USAGE}`);
        }
        return { name: "rule-retire", repo, ruleId, patternId, glob, retiredBy: optional(flags, "by") ?? "cli" };
      }
      throw new Error(`unknown rule subcommand ${sub}\n${USAGE}`);
    }
    case "eval":
      return { name: "eval", casesPath: required(flags, "replay"), goldenPath: required(flags, "golden") };
    case "report":
      if (flags.get("weekly") !== true) {
        throw new Error(`report currently supports --weekly only\n${USAGE}`);
      }
      return { name: "report", weekly: true, repo: optional(flags, "repo") };
    case "confirm-dismissal": {
      const repo = positionals[0];
      if (!repo) throw new Error(`confirm-dismissal needs a repo\n${USAGE}`);
      const findingId = required(flags, "finding");
      return { name: "confirm-dismissal", repo, findingId, confirmedBy: optional(flags, "by") ?? "cli" };
    }
    case "rebuild-read-model":
      return { name: "rebuild-read-model" };
    case "help":
    case "--help":
      throw new Error(USAGE);
    default:
      throw new Error(`unknown command ${command}\n${USAGE}`);
  }
}
