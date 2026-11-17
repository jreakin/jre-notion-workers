/** Clef page.created skip rule (Option 1) + live flag. Fake ids only; no real page, title or content. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Env } from "../src/env.js";
import { resetSoftDailyCountersForTests } from "../src/soft-daily-counter.js";
import { decideClefOutcome, decideClefOutcomeForEvent } from "../src/wake-gate/clef-decision-logic.js";
import {
  CLEF_LIVE_DECISION_TIMEOUT_MS_DEFAULT,
  awaitClefVerdict,
  isLiveSkipVerdict,
  readClefLiveDecisionTimeoutMs,
} from "../src/wake-gate/clef-live-skip.js";
import { resetClefConstantScoreForTests } from "../src/wake-gate/clef-constant-score.js";
import {
  clefSkipPageCreatedLive,
  pageCreatedRuleEligible,
  resetClefPageEventCountsForTests,
  runClefShadowWakeGate,
  shouldRunClefFullSample,
} from "../src/wake-gate/clef-wake-gate.js";
import type { GateEventContext, WakeGateDecision } from "../src/wake-gate/gate-event-types.js";

const JOHN = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";

function ctx(over: Partial<GateEventContext> = {}): GateEventContext {
  return {
    notionType: "page.created",
    rawBody: "{}",
    pageId: "fa4e0000-0000-4000-8000-000000000001",
    johnUserIds: new Set([JOHN]),
    fleetCommentsBotIds: new Set([BOT]),
    submittedPropertyIds: new Set(),
    nonSubmittedPropertyIds: new Set(),
    updatedPropertyIds: [],
    isCommentEvent: false,
    propertiesAvailable: true,
    properties: { needsJohn: false, sensitive: false, title: "Synthetic eligible", kind: "synthetic" },
    parentDbConfigName: "tracked",
    ...over,
  };
}

const RULES: WakeGateDecision[] = [
  { gate_name: "comments_echo", decision: "would_wake", reason: "default", inputs: {}, ts: "", mode: "shadow" },
];

type Answer = { p_action: number; p_dup: number; q_when: "now" | "batch" | "ignore" };

function ai(...answers: Answer[]): Ai {
  let n = 0;
  return {
    run: async () => {
      const a = answers[Math.min(n, answers.length - 1)] as Answer;
      n += 1;
      return {
        answers: {
          q_action: { type: "noul", noul: a.p_action },
          q_dup: { type: "noul", noul: a.p_dup },
          q_when: { type: "choice", choice: a.q_when },
        },
      };
    },
  } as unknown as Ai;
}

function env(over: Partial<Env> = {}): Env {
  return {
    RELAY_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace,
    COS_WEBHOOK_URL: "u",
    COS_WEBHOOK_AUTHORIZATION: "a",
    SETUP_SECRET: "s",
    CLEF_DEFAULT_MODE: "shadow",
    AI_GATEWAY_ID: "fake-gateway",
    ...over,
  };
}

const LOW_IGNORE: Answer = { p_action: 0.02, p_dup: 0.1, q_when: "ignore" };

/** A fake page id that is (or is not) in the 10% full-model sample. */
function pageId(sampled: boolean): string {
  for (let i = 1; i < 10_000; i++) {
    const id = `fa4e0000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    if (shouldRunClefFullSample(id) === sampled) return id;
  }
  throw new Error("no id");
}

describe("decideClefOutcomeForEvent (Option 1)", () => {
  test("page.created: p_action <= 0.05 and q_when ignore ⇒ skip; boundaries hold", () => {
    expect(decideClefOutcomeForEvent(0.02, 0.1, "ignore", "page.created")).toBe("would_skip");
    expect(decideClefOutcomeForEvent(0.05, 0, "ignore", "page.created")).toBe("would_skip");
    expect(decideClefOutcomeForEvent(0.051, 0, "ignore", "page.created")).toBe("would_batch");
    expect(decideClefOutcomeForEvent(0.02, 0.1, "batch", "page.created")).toBe("would_batch");
    expect(decideClefOutcomeForEvent(0.02, 0.1, "now", "page.created")).toBe("would_wake");
  });

  test("every other event type is decided exactly as decideClefOutcome", () => {
    const cases: [number, number, "now" | "batch" | "ignore"][] = [
      [0.02, 0.1, "ignore"],
      [0.02, 0.9, "now"],
      [0.2, 0.1, "batch"],
      [0.9, 0.1, "now"],
    ];
    for (const ev of ["page.properties_updated", "comment.created", "page.added", "page_created", null]) {
      for (const [a, d, w] of cases) expect(decideClefOutcomeForEvent(a, d, w, ev)).toBe(decideClefOutcome(a, d, w));
    }
  });
});

describe("pageCreatedRuleEligible", () => {
  test("eligible only for a real score on page.created", () => {
    expect(pageCreatedRuleEligible(ctx(), "page.created", {}, null)).toBe(true);
    expect(pageCreatedRuleEligible(ctx(), "page.properties_updated", {}, null)).toBe(false);
    expect(pageCreatedRuleEligible(ctx(), "page.created", {}, "clef_mode_invalid")).toBe(false);
    expect(pageCreatedRuleEligible(ctx({ propertiesAvailable: false }), "page.created", {}, null)).toBe(false);
    expect(pageCreatedRuleEligible(ctx({ notionFetchFailReason: "notion_fetch_timeout" }), "page.created", {}, null)).toBe(false);
  });

  test("Needs John / Sensitive never eligible", () => {
    expect(pageCreatedRuleEligible(ctx({ properties: { needsJohn: true } }), "page.created", {}, null)).toBe(false);
    expect(pageCreatedRuleEligible(ctx({ properties: { sensitive: true } }), "page.created", {}, null)).toBe(false);
    expect(pageCreatedRuleEligible(ctx({ needsJohnNow: true }), "page.created", {}, null)).toBe(false);
  });
});

describe("runClefShadowWakeGate with Option 1", () => {
  let logs: Record<string, unknown>[] = [];
  let origLog: typeof console.log;
  beforeEach(() => {
    logs = [];
    origLog = console.log;
    console.log = ((line: unknown) => {
      try {
        const o = JSON.parse(String(line)) as Record<string, unknown>;
        if (o.stream === "clef_wake_shadow") logs.push(o);
      } catch {
        // not a row
      }
    }) as typeof console.log;
    resetClefPageEventCountsForTests();
    resetClefConstantScoreForTests();
    resetSoftDailyCountersForTests();
  });
  afterEach(() => {
    console.log = origLog;
  });

  test("eligible low-action ignore page.created ⇒ would_skip row and pageCreatedSkip", async () => {
    const r = await runClefShadowWakeGate(env({ AI: ai(LOW_IGNORE) }), ctx({ pageId: pageId(false) }), "page.created", {}, true, RULES);
    expect(r.pageCreatedSkip).toBe(true);
    expect(isLiveSkipVerdict(r)).toBe(true);
    expect(logs.at(-1)?.clef_decision).toBe("would_skip");
    expect(logs.at(-1)?.reason).toBe("clef_ok;page_created_ignore");
    expect(logs.at(-1)?.page_created_rule).toBe("would_skip");
    expect(String(logs.at(-1)?.item_id)).toMatch(/^opaque:/);
  });

  test("sampled full model disagrees ⇒ no skip (wake path keeps flash verdict, full row shows wake)", async () => {
    const r = await runClefShadowWakeGate(
      env({ AI: ai(LOW_IGNORE, { p_action: 0.9, p_dup: 0.1, q_when: "now" }) }),
      ctx({ pageId: pageId(true) }),
      "page.created",
      {},
      true,
      RULES,
    );
    expect(r.pageCreatedSkip).toBe(false);
    const row = logs.at(-1) as { sampled_full?: { decision?: string }; reason?: string };
    expect(row.sampled_full?.decision).toBe("would_wake");
    expect(row.reason).toBe("clef_ok");
  });

  test("sampled full model agrees ⇒ skip", async () => {
    const r = await runClefShadowWakeGate(env({ AI: ai(LOW_IGNORE) }), ctx({ pageId: pageId(true) }), "page.created", {}, true, RULES);
    expect(r.pageCreatedSkip).toBe(true);
  });

  test("high p_dup with q_when now / batch never makes a page.created skip live (Option 1 predicate only)", async () => {
    for (const q_when of ["now", "batch"] as const) {
      const r = await runClefShadowWakeGate(
        env({ AI: ai({ p_action: 0.01, p_dup: 0.95, q_when }) }),
        ctx({ pageId: pageId(false) }),
        "page.created",
        {},
        true,
        RULES,
      );
      expect(r.pageCreatedSkip).toBe(false);
      expect(logs.at(-1)?.page_created_rule).toBeUndefined();
    }
  });

  test("sampled full model returns a p_dup skip with q_when now ⇒ not Option 1 agreement ⇒ no skip", async () => {
    const r = await runClefShadowWakeGate(
      env({ AI: ai(LOW_IGNORE, { p_action: 0.01, p_dup: 0.95, q_when: "now" }) }),
      ctx({ pageId: pageId(true) }),
      "page.created",
      {},
      true,
      RULES,
    );
    expect(r.pageCreatedSkip).toBe(false);
  });

  test("sampled page whose full-model call fails or hits the cap ⇒ no skip", async () => {
    let n = 0;
    const failSecond = {
      run: async () => {
        n += 1;
        if (n > 1) throw new Error("fake full-model failure");
        return (await ai(LOW_IGNORE).run("x" as never, {} as never)) as unknown;
      },
    } as unknown as Ai;
    const failed = await runClefShadowWakeGate(env({ AI: failSecond }), ctx({ pageId: pageId(true) }), "page.created", {}, true, RULES);
    expect(failed.pageCreatedSkip).toBe(false);
    expect(logs.at(-1)?.sampled_full).toBeNull();
    expect(logs.at(-1)?.reason).toBe("clef_ok");

    resetSoftDailyCountersForTests();
    const capped = await runClefShadowWakeGate(
      env({ AI: ai(LOW_IGNORE), CLEF_DAILY_CALL_CAP: "1" }),
      ctx({ pageId: pageId(true) }),
      "page.created",
      {},
      true,
      RULES,
    );
    expect(capped.pageCreatedSkip).toBe(false);
    expect(logs.at(-1)?.sampled_full).toBeNull();
    expect(logs.at(-1)?.reason).toBe("clef_ok");
    expect(logs.at(-1)?.clef_decision).toBe("would_skip");
  });

  test("Needs John / Sensitive / fetch failure ⇒ hard override, no Clef call, no skip", async () => {
    for (const c of [
      ctx({ properties: { needsJohn: true } }),
      ctx({ properties: { sensitive: true } }),
      ctx({ notionFetchFailReason: "notion_fetch_failed" }),
      ctx({ notionFetchFailReason: "notion_fetch_timeout" }),
      ctx({ propertiesAvailable: false, properties: {} }),
    ]) {
      const r = await runClefShadowWakeGate(env({ AI: ai(LOW_IGNORE) }), c, "page.created", {}, true, RULES);
      expect(r.pageCreatedSkip).toBe(false);
      expect(logs.at(-1)?.clef_decision).toBe("would_wake");
      expect(logs.at(-1)?.model).toBeNull();
    }
  });

  test("Clef failure (bad output) ⇒ no skip", async () => {
    const bad = { run: async () => ({ answers: {} }) } as unknown as Ai;
    const r = await runClefShadowWakeGate(env({ AI: bad }), ctx(), "page.created", {}, true, RULES);
    expect(r.pageCreatedSkip).toBe(false);
    expect(logs.at(-1)?.reason).toBe("clef_bad_output");
  });

  test("properties_updated with the same scores keeps the old rule (batch, no skip)", async () => {
    const r = await runClefShadowWakeGate(
      env({ AI: ai(LOW_IGNORE) }),
      ctx({ notionType: "page.properties_updated", nonSubmittedPropertyIds: new Set(["fakeOther"]), updatedPropertyIds: ["fakeOther"] }),
      "page.properties_updated",
      {},
      true,
      RULES,
    );
    expect(r.pageCreatedSkip).toBe(false);
    expect(logs.at(-1)?.clef_decision).toBe("would_batch");
    expect(logs.at(-1)?.reason).toBe("clef_ok");
  });
});

describe("live flag + verdict wait", () => {
  test("flag is OFF unless exactly 1", () => {
    expect(clefSkipPageCreatedLive({})).toBe(false);
    expect(clefSkipPageCreatedLive({ CLEF_SKIP_PAGE_CREATED_LIVE: "0" })).toBe(false);
    expect(clefSkipPageCreatedLive({ CLEF_SKIP_PAGE_CREATED_LIVE: "true" })).toBe(false);
    expect(clefSkipPageCreatedLive({ CLEF_SKIP_PAGE_CREATED_LIVE: " 1 " })).toBe(true);
  });

  test("timeout default and parse", () => {
    expect(readClefLiveDecisionTimeoutMs({})).toBe(CLEF_LIVE_DECISION_TIMEOUT_MS_DEFAULT);
    expect(readClefLiveDecisionTimeoutMs({ CLEF_LIVE_DECISION_TIMEOUT_MS: "250" })).toBe(250);
    expect(readClefLiveDecisionTimeoutMs({ CLEF_LIVE_DECISION_TIMEOUT_MS: "-1" })).toBe(CLEF_LIVE_DECISION_TIMEOUT_MS_DEFAULT);
  });

  test("slow or failing verdict ⇒ null (forward)", async () => {
    const slow = new Promise<null>((r) => setTimeout(() => r(null), 200));
    expect(await awaitClefVerdict(slow, 5)).toBeNull();
    expect(await awaitClefVerdict(Promise.reject(new Error("x")), 50)).toBeNull();
    expect(isLiveSkipVerdict(null)).toBe(false);
    expect(isLiveSkipVerdict({ entry: null, pageCreatedSkip: true })).toBe(false);
  });
});
