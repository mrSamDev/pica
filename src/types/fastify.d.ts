import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    // Set by the application/json content type parser before JSON.parse runs.
    rawBody?: string;
  }
}
