import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/**
 * Verify an HMAC-SHA256 webhook signature over the raw request body.
 *
 * Timing-safe: a length mismatch still runs a constant-time comparison so the
 * response time does not reveal whether the length matched.
 */
export function verifySignature(secret: string, rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(PREFIX)) {
    return false;
  }

  const received = Buffer.from(signatureHeader.slice(PREFIX.length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();

  if (received.length !== expected.length) {
    // SAFETY: timingSafeEqual requires equal-length buffers; comparing the
    // shorter buffer to itself keeps the operation constant-time. The result
    // is discarded because the lengths already differ.
    const shorter = received.length < expected.length ? received : expected;
    timingSafeEqual(shorter, shorter);
    return false;
  }

  return timingSafeEqual(expected, received);
}
