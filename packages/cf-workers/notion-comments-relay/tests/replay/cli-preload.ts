/** Preload for the replay CLI (outside `bun test`): stub `cloudflare:workers` like tests/setup-cloudflare-workers.ts. */
import { plugin } from "bun";

plugin({
  name: "cloudflare-workers-stub",
  setup(build) {
    build.module("cloudflare:workers", () => ({
      exports: {
        DurableObject: class {
          protected ctx: unknown;
          protected env: unknown;
          constructor(ctx: unknown, env: unknown) {
            this.ctx = ctx;
            this.env = env;
          }
        },
      },
      loader: "object",
    }));
  },
});
