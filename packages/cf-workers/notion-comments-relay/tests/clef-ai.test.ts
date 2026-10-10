import { describe, expect, test } from "bun:test";
import { buildClefAiRunArguments, clefInputKeys, invokeClefFlash } from "../src/wake-gate/clef-ai.js";
import type { Env } from "../src/env.js";

describe("clef-ai", () => {
  test("clef AI.run input is only model state questions; gateway on arg 3", async () => {
    const calls: unknown[][] = [];
    const e: Env = {
      RELAY_KV: {} as KVNamespace,
      COS_WEBHOOK_URL: "https://example.com",
      COS_WEBHOOK_AUTHORIZATION: "Bearer x",
      SETUP_SECRET: "secret",
      AI_GATEWAY_ID: "gw-test",
      AI: {
        run: (async (...args: unknown[]) => {
          calls.push(args);
          return {
            answers: {
              q_action: { type: "noul", noul: 0.5 },
              q_dup: { type: "noul", noul: 0.1 },
              q_when: { type: "choice", choice: "now" },
            },
          };
        }) as Ai["run"],
      } as Ai,
    };
    const { input, runOptions } = buildClefAiRunArguments(e, "clef-flash", "state");
    expect(clefInputKeys(input)).toEqual(["model", "questions", "state"]);
    expect((runOptions.gateway as { id: string }).id).toBe("gw-test");

    await invokeClefFlash(e, "hello");
    expect(calls.length).toBe(1);
    const inputArg = calls[0][1] as Record<string, unknown>;
    const optionsArg = calls[0][2] as Record<string, unknown>;
    expect(clefInputKeys(inputArg)).toEqual(["model", "questions", "state"]);
    expect((optionsArg.gateway as { id: string }).id).toBe("gw-test");
    expect(optionsArg.signal).toBeTruthy();
  });
});
