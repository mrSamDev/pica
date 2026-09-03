import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface BasicAuthConfig {
  username?: string;
  password?: string;
}

const CHALLENGE = 'Basic realm="dashboard"';

// HTTP Basic auth for the operational endpoints. The browser auto-attaches
// credentials on the page's own /api/dashboard fetch, so the dashboard HTML
// needs no changes. When no credentials are configured (dev), the hook is a
// no-op. Timing-safe comparison mirrors the webhook signature code.
export function basicAuthHook(config: BasicAuthConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.username || !config.password) {
      return;
    }

    const header = request.headers.authorization;
    if (!header || !header.startsWith("Basic ")) {
      return unauthorized(reply);
    }

    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep === -1) {
      return unauthorized(reply);
    }

    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (!safeEqual(user, config.username) || !safeEqual(pass, config.password)) {
      return unauthorized(reply);
    }
  };
}

function unauthorized(reply: FastifyReply) {
  return reply
    .code(401)
    .header("WWW-Authenticate", CHALLENGE)
    .send({ error: { statusCode: 401, message: "Unauthorized" } });
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // SAFETY: timingSafeEqual requires equal-length buffers; comparing the
    // shorter buffer to itself keeps the operation constant-time. The result
    // is discarded because the lengths already differ.
    const shorter = bufA.length < bufB.length ? bufA : bufB;
    timingSafeEqual(shorter, shorter);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
