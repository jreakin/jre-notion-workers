import { mock } from "bun:test";

/** Bun has no `cloudflare:workers`; provide the minimal DurableObject base for unit tests. */
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

