// Replays a webhook fixture. Signature is recomputed over the fixture bytes, so
// the file does not need to match GitHub's original wire format byte-for-byte.
//
// Usage:
//   pnpm webhook:replay <fixture> <url> <event>
//   e.g. pnpm webhook:replay tools/webhook-fixtures/pull-request-opened.json \
//          https://<tunnel>/webhooks/github pull_request
//
// Env: WEBHOOK_SECRET (required, from .env)
// eslint-disable no-console -- CLI script, console is the output

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const [fixtureArg, urlArg, eventArg] = process.argv.slice(2);
if (!fixtureArg || !urlArg || !eventArg) {
  console.error("usage: pnpm webhook:replay <fixture> <url> <event>");
  process.exit(1);
}

const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error("WEBHOOK_SECRET not set (check .env)");

const rawBody = readFileSync(fixtureArg, "utf8");
try {
  JSON.parse(rawBody);
} catch {
  throw new Error(`fixture is not valid JSON: ${fixtureArg}`);
}

const signature = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");

// A hung endpoint must not park the CLI until the OS network stack gives up.
const response = await fetch(urlArg, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "user-agent": "GitHub-Hookshot/replay",
    "x-github-delivery": randomUUID(),
    "x-github-event": eventArg,
    "x-hub-signature-256": signature,
  },
  body: rawBody,
  signal: AbortSignal.timeout(30_000),
});

console.log(`POST ${urlArg}`);
console.log(`fixture: ${fixtureArg} (${eventArg})`);
console.log(`status: ${response.status}`);
const body = await response.text();
if (body) console.log(`body: ${body}`);

if (!response.ok) process.exit(1);
