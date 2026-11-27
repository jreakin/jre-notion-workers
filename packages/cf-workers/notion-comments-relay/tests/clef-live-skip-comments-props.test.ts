/** LOCK-69 live Clef skip for comment.* and page.properties_updated. Synthetic ids only. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Env } from "../src/env.js";
import { resetSoftDailyCountersForTests } from "../src/soft-daily-counter.js";
import { decideClefOutcome } from "../src/wake-gate/clef-decision-logic.js";
import {
  awaitClefVerdict,
  isLiveSkipVerdict,
  liveSkipLogReason,
} from "../src/wake-gate/clef-live-skip.js";
import {
  clefModePermitsEnvLiveSkip,
  clefSkipCommentsLive,
  clefSkipPropertiesUpdatedLive,
  kvExplicitlyBlocksClefLiveSkip,
  wantsClefLiveVerdictAwait,
} from "../src/wake-gate/clef-live-skip-policy.js";
import { resetClefConstantScoreForTests } from "../src/wake-gate/clef-constant-score.js";
import {
  resetClefPageEventCountsForTests,
  runClefShadowWakeGate,
  shouldRunClefFullSample,
} from "../src/wake-gate/clef-wake-gate.js";
import { resolveClefMode } from "../src/wake-gate/clef-mode.js";
import type { GateEventContext, WakeGateDecision } from "../src/wake-gate/gate-event-types.js";

const JOHN = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const PAGE = "fa4e0000-0000-4000-8000-000000000003";
const COMMENT = "cc0e0000-0000-4000-8000-000000000004";

function kvStore(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
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

const STD_SKIP: Answer = { p_action: 0.02, p_dup: 0.95, q_when: "now" };
const LOW_IGNORE: Answer = { p_action: 0.02, p_dup: 0.1, q_when: "ignore" };

function env(over: Partial<Env> = {}): Env {
  return {
    RELAY_KV: kvStore(),
    COS_WEBHOOK_URL: "u",
    COS_WEBHOOK_AUTHORIZATION: "a",
    SETUP_SECRET: "s",
    CLEF_DEFAULT_MODE: "shadow",
    AI_GATEWAY_ID: "fake-gateway",
    JOHN_NOTION_USER_IDS: JOHN,
    FLEET_COMMENTS_BOT_NOTION_USER_IDS: BOT,
    ...over,
  };
}

function commentCtx(over: Partial<GateEventContext> = {}): GateEventContext {
  return {
    notionType: "comment.created",
    rawBody: "{}",
    pageId: PAGE,
    commentId: COMMENT,
    authorId: OTHER,
    johnUserIds: new Set([JOHN]),
    fleetCommentsBotIds: new Set([BOT]),
    submittedPropertyIds: new Set(),
    nonSubmittedPropertyIds: new Set(),
    updatedPropertyIds: [],
    isCommentEvent: true,
    propertiesAvailable: true,
    properties: { needsJohn: false, sensitive: false },
    ...over,
  };
}

function propsCtx(over: Partial<GateEventContext> = {}): GateEventContext {
  return {
    notionType: "page.properties_updated",
    rawBody: "{}",
    pageId: PAGE,
    johnUserIds: new Set([JOHN]),
    fleetCommentsBotIds: new Set([BOT]),
    submittedPropertyIds: new Set(["fakeSubm"]),
    needsJohnPropertyIds: new Set(["fakeNJ"]),
    nonSubmittedPropertyIds: new Set(["fakeOther"]),
    updatedPropertyIds: ["fakeOther"],
    isCommentEvent: false,
    propertiesAvailable: true,
    properties: { needsJohn: false, sensitive: false },
    ...over,
  };
}

function pageIdForSample(want: boolean): string {
  for (let i = 1; i < 10_000; i++) {
    const id = `fa4e0000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    if (shouldRunClefFullSample(id) === want) return id;
  }
  throw new Error("no id");
}

describe("live skip env flags", () => {
  test("comments / properties flags require exactly 1", () => {
    expect(clefSkipCommentsLive({})).toBe(false);
    expect(clefSkipCommentsLive({ CLEF_SKIP_COMMENTS_LIVE: " 1 " })).toBe(true);
    expect(clefSkipPropertiesUpdatedLive({ CLEF_SKIP_PROPERTIES_UPDATED_LIVE: "0" })).toBe(false);
    expect(wantsClefLiveVerdictAwait(env({ CLEF_SKIP_COMMENTS_LIVE: "1" }), "comment.created")).toBe(true);
    expect(wantsClefLiveVerdictAwait(env({ CLEF_SKIP_PROPERTIES_UPDATED_LIVE: "1" }), "page.properties_updated")).toBe(
      true,
    );
    expect(wantsClefLiveVerdictAwait(env({ CLEF_SKIP_COMMENTS_LIVE: "1" }), "page.created")).toBe(false);
  });
});

describe("KV kill switch blocks env live skip", () => {
  test("global shadow / off and gate clef_wake shadow block", async () => {
    expect(await kvExplicitlyBlocksClefLiveSkip(env())).toBe(false);
    expect(await kvExplicitlyBlocksClefLiveSkip(env({ RELAY_KV: kvStore({ "clef:mode:global": "shadow" }) }))).toBe(
      true,
    );
    expect(await kvExplicitlyBlocksClefLiveSkip(env({ RELAY_KV: kvStore({ "clef:mode:clef_wake": "off" }) }))).toBe(
      true,
    );
  });
});

describe("standard Clef live skip (comments + properties_updated)", () => {
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
        /* noop */
      }
    }) as typeof console.log;
    resetClefPageEventCountsForTests();
    resetClefConstantScoreForTests();
    resetSoftDailyCountersForTests();
  });
  afterEach(() => {
    console.log = origLog;
  });

  test("comment.* standard would_skip ⇒ liveSkipKind comment and isLiveSkipVerdict", async () => {
    const parsed = { data: { text: "hello" }, authors: [{ id: OTHER }] };
    const r = await runClefShadowWakeGate(
      env({ AI: ai(STD_SKIP), CLEF_SKIP_COMMENTS_LIVE: "1" }),
      commentCtx(),
      "comment.created",
      parsed,
      true,
      RULES,
    );
    expect(r.liveSkipKind).toBe("comment");
    expect(r.pageCreatedSkip).toBe(false);
    expect(isLiveSkipVerdict(r)).toBe(true);
    expect(liveSkipLogReason(r)).toBe("clef_live_skip:comment");
    expect(logs.at(-1)?.clef_decision).toBe("would_skip");
    expect(decideClefOutcome(STD_SKIP.p_action, STD_SKIP.p_dup, STD_SKIP.q_when)).toBe("would_skip");
  });

  test("page.properties_updated standard would_skip ⇒ liveSkipKind properties_updated", async () => {
    const r = await runClefShadowWakeGate(
      env({ AI: ai(STD_SKIP), CLEF_SKIP_PROPERTIES_UPDATED_LIVE: "1" }),
      propsCtx(),
      "page.properties_updated",
      {},
      true,
      RULES,
    );
    expect(r.liveSkipKind).toBe("properties_updated");
    expect(isLiveSkipVerdict(r)).toBe(true);
    expect(liveSkipLogReason(r)).toBe("clef_live_skip:properties_updated");
  });

  test("KV shadow blocks liveSkipKind even when env flag is 1", async () => {
    const r = await runClefShadowWakeGate(
      env({ AI: ai(STD_SKIP), CLEF_SKIP_COMMENTS_LIVE: "1", RELAY_KV: kvStore({ "clef:mode:global": "shadow" }) }),
      commentCtx(),
      "comment.created",
      { data: { text: "x" } },
      true,
      RULES,
    );
    expect(r.liveSkipKind).toBeNull();
    expect(isLiveSkipVerdict(r)).toBe(false);
  });

  test("Needs John ⇒ no liveSkipKind", async () => {
    const r = await runClefShadowWakeGate(
      env({ AI: ai(STD_SKIP), CLEF_SKIP_PROPERTIES_UPDATED_LIVE: "1" }),
      propsCtx({ properties: { needsJohn: true, sensitive: false } }),
      "page.properties_updated",
      {},
      true,
      RULES,
    );
    expect(r.liveSkipKind).toBeNull();
    expect(r.pageCreatedSkip).toBe(false);
    expect(logs.at(-1)?.clef_decision).toBe("would_wake");
  });

  test("comment fetch fail ⇒ no liveSkipKind", async () => {
    const r = await runClefShadowWakeGate(
      env({ AI: ai(STD_SKIP), CLEF_SKIP_COMMENTS_LIVE: "1" }),
      commentCtx({ notionFetchFailReason: "notion_fetch_failed" }),
      "comment.created",
      { data: { text: "x" } },
      true,
      RULES,
    );
    expect(r.liveSkipKind).toBeNull();
  });

  test("full model disagreement ⇒ no liveSkipKind", async () => {
    const r = await runClefShadowWakeGate(
      env({
        AI: ai(STD_SKIP, { p_action: 0.9, p_dup: 0.1, q_when: "now" }),
        CLEF_SKIP_COMMENTS_LIVE: "1",
      }),
      commentCtx({ pageId: pageIdForSample(true) }),
      "comment.created",
      { data: { text: "hello" } },
      true,
      RULES,
    );
    expect(r.liveSkipKind).toBeNull();
  });

  test("page.created Option 1 scores without CLEF_SKIP_PAGE_CREATED_LIVE ⇒ pageCreatedSkip only", async () => {
    const pageCtx: GateEventContext = {
      notionType: "page.created",
      rawBody: "{}",
      pageId: pageIdForSample(false),
      johnUserIds: new Set([JOHN]),
      fleetCommentsBotIds: new Set([BOT]),
      submittedPropertyIds: new Set(),
      nonSubmittedPropertyIds: new Set(),
      updatedPropertyIds: [],
      isCommentEvent: false,
      propertiesAvailable: true,
      properties: { needsJohn: false, sensitive: false, title: "Synthetic", kind: "synthetic" },
      parentDbConfigName: "tracked",
    };
    const r = await runClefShadowWakeGate(env({ AI: ai(LOW_IGNORE) }), pageCtx, "page.created", {}, true, RULES);
    expect(r.pageCreatedSkip).toBe(true);
    expect(r.liveSkipKind).toBeNull();
    expect(isLiveSkipVerdict(r)).toBe(true);
  });

  test("clefModePermitsEnvLiveSkip rejects mode reasons", async () => {
    const mode = await resolveClefMode(env({ RELAY_KV: kvStore({ "clef:mode:global": "off" }) }));
    expect(clefModePermitsEnvLiveSkip(mode)).toBe(false);
  });
});

describe("awaitClefVerdict fail-open", () => {
  test("timeout ⇒ null verdict", async () => {
    const slow = new Promise<{ entry: null; pageCreatedSkip: false; liveSkipKind: null }>((r) =>
      setTimeout(() => r({ entry: null, pageCreatedSkip: false, liveSkipKind: null }), 200),
    );
    expect(await awaitClefVerdict(slow, 5)).toBeNull();
  });
});
