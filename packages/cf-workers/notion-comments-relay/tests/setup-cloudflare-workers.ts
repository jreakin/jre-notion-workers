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

// The per-event page-fetch memo is module-level; tests reuse event payloads, so clear it per test.
import { beforeEach } from "bun:test";
import { resetPageFetchMemo } from "../src/wake-gate/notion-page-fetch.js";
beforeEach(() => resetPageFetchMemo());
