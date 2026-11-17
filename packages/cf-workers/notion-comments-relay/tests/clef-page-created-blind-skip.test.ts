/** Clef page_created blind-skip guards — synthetic ids and titles only. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Env } from "../src/env.js";
import { resetSoftDailyCountersForTests } from "../src/soft-daily-counter.js";
import {
  buildClefBaselineStateString,
  clefBlindInputMissingFields,
  pageCreatedLiveSkipGate,
} from "../src/wake-gate/clef-blind-input.js";
import { noteClefConstantScore, resetClefConstantScoreForTests } from "../src/wake-gate/clef-constant-score.js";
import { clefPageCreatedHonorJohnAuthored } from "../src/wake-gate/clef-page-created-env.js";
import { buildClefStateString } from "../src/wake-gate/clef-state.js";
import { findFirstTitleProperty, parseAdDocsPropertiesFromNotionPage } from "../src/wake-gate/fleet-locks-properties.js";
import {
  isLaunchScopeTaskPageCreated,
  pageCreatedNeedsTasksLaunchScopeFetch,
  tasksLaunchScopeLabelsPresent,
} from "../src/wake-gate/launch-scope-task.js";
import { isJohnForPageCreatedHonor } from "../src/wake-gate/gate-context-safety.js";
import { PARENT_NAME_TASKS } from "../src/wake-gate/tracked-parent-names.js";
import {
  clefSkipPageCreatedLive,
  resetClefPageEventCountsForTests,
  runClefShadowWakeGate,
} from "../src/wake-gate/clef-wake-gate.js";
import { isLiveSkipVerdict } from "../src/wake-gate/clef-live-skip.js";
import type { GateEventContext, WakeGateDecision } from "../src/wake-gate/gate-event-types.js";

const JOHN = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TASKS_DS = "ta510000-0000-4000-8000-000000000001";

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
    properties: { needsJohn: false, sensitive: false, title: "Synthetic title A" },
    parentDbConfigName: "AD Docs",
    authorId: OTHER,
    ...over,
  };
}

function johnEligiblePage(over: Partial<GateEventContext> = {}): GateEventContext {
  return ctx({
    authorId: JOHN,
    parentDbConfigName: "AD Docs",
    properties: {
      title: "Synthetic visible",
      kind: "synthetic",
      needsJohn: false,
      sensitive: false,
      clefMasked: { area: "synthetic" },
    },
    ...over,
  });
}

const RULES: WakeGateDecision[] = [
  { gate_name: "comments_echo", decision: "would_wake", reason: "default", inputs: {}, ts: "", mode: "shadow" },
];

type Answer = { p_action: number; p_dup: number; q_when: "now" | "batch" | "ignore" };

function ai(...answers: Answer[]) {
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
    TASKS_DATA_SOURCE_ID: TASKS_DS,
    ...over,
  };
}

const LOW_IGNORE: Answer = { p_action: 0.02, p_dup: 0.1, q_when: "ignore" };
const FIXED_SCORE = { p_action: 0.0463, confidence: 0.3911 } as const;

describe("john_authored vs Clef gate (one test per rule)", () => {
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

  test("switch unset: non-blind non-Launch John-authored page_created can live-skip when flag on and Clef scores skip", async () => {
    const c = johnEligiblePage();
    const e = env({ AI: ai(LOW_IGNORE), CLEF_SKIP_PAGE_CREATED_LIVE: "1" });
    expect(clefSkipPageCreatedLive(e)).toBe(true);
    const r = await runClefShadowWakeGate(e, c, "page.created", {}, true, RULES);
    expect(r.pageCreatedSkip).toBe(true);
    expect(isLiveSkipVerdict(r)).toBe(true);
    expect(String(logs.at(-1)?.reason)).not.toMatch(/john_authored/);
  });

  test("switch at 1: same John-authored page_created wakes (no live skip)", async () => {
    const c = johnEligiblePage();
    const e = env({ AI: ai(LOW_IGNORE), CLEF_PAGE_CREATED_HONOR_JOHN_AUTHORED: "1" });
    const r = await runClefShadowWakeGate(e, c, "page.created", {}, true, RULES);
    expect(r.pageCreatedSkip).toBe(false);
    expect(String(logs.at(-1)?.reason)).toMatch(/john_authored/);
  });

  test("switch at 1: authorless webhook with fetched pageCreatedById=John wakes on skip score", async () => {
    const c = johnEligiblePage({
      authorId: undefined,
      webhookAuthorIds: [],
      pageCreatedById: JOHN,
    });
    const e = env({ AI: ai(LOW_IGNORE), CLEF_PAGE_CREATED_HONOR_JOHN_AUTHORED: "1", CLEF_SKIP_PAGE_CREATED_LIVE: "1" });
    const r = await runClefShadowWakeGate(e, c, "page.created", {}, true, RULES);
    expect(r.pageCreatedSkip).toBe(false);
    expect(String(logs.at(-1)?.reason)).toMatch(/john_authored/);
  });

  test("Tasks Launch Scope=Launch wakes even with switch unset and Clef skip score", async () => {
    const c = johnEligiblePage({
      parentDbConfigName: PARENT_NAME_TASKS,
      webhookParentDataSourceId: TASKS_DS,
      authorId: OTHER,
      properties: {
        title: "Synthetic visible",
        launchScopeLabel: "Launch",
        needsJohn: false,
        sensitive: false,
        clefMasked: { area: "synthetic" },
      },
    });
    const r = await runClefShadowWakeGate(env({ AI: ai(LOW_IGNORE) }), c, "page.created", {}, true, RULES);
    expect(r.pageCreatedSkip).toBe(false);
    expect(String(logs.at(-1)?.reason)).toMatch(/launch_scope_task/);
  });
});

describe("supporting guards", () => {
  test("honor switch unset defaults to 0", () => {
    expect(clefPageCreatedHonorJohnAuthored({})).toBe(false);
  });

  test("Launch Scope exact Launch only", () => {
    const launch = ctx({
      parentDbConfigName: PARENT_NAME_TASKS,
      properties: { launchScopeLabel: "Launch", title: "x", needsJohn: false, sensitive: false },
    });
    expect(isLaunchScopeTaskPageCreated(launch, env())).toBe(true);
    const post = ctx({
      parentDbConfigName: PARENT_NAME_TASKS,
      properties: { launchScopeLabel: "Post-launch", title: "x", needsJohn: false, sensitive: false },
    });
    expect(isLaunchScopeTaskPageCreated(post, env())).toBe(false);
  });

  test("Tasks page.created without Launch Scope on webhook needs fetch and blocks live skip until scope known", () => {
    const partial = ctx({
      parentDbConfigName: PARENT_NAME_TASKS,
      webhookParentDataSourceId: TASKS_DS,
      propertiesAvailable: true,
      properties: { title: "Synthetic partial", needsJohn: false, sensitive: false, adDocsParseOk: true },
    });
    expect(tasksLaunchScopeLabelsPresent(partial)).toBe(false);
    expect(pageCreatedNeedsTasksLaunchScopeFetch(partial, env(), "page.created")).toBe(true);
    const base = buildClefBaselineStateString(partial, "page.created", {}, 0, false);
    const state = buildClefStateString(partial, "page.created", {}, 0, false);
    const gate = pageCreatedLiveSkipGate(
      partial,
      "page.created",
      {},
      null,
      state,
      base,
      env({ CLEF_SKIP_PAGE_CREATED_LIVE: "1" }),
      true,
    );
    expect(gate.allowed).toBe(false);
    expect(gate.forceReason).toBe("launch_scope_unverified");
  });

  test("honor switch at 1 treats fetched page creator as John when webhook authors empty", () => {
    const c = johnEligiblePage({
      authorId: undefined,
      webhookAuthorIds: [],
      pageCreatedById: JOHN,
    });
    expect(isJohnForPageCreatedHonor(c)).toBe(true);
  });

  test("title by type and blind input", () => {
    const taskProps = { "Task Name": { type: "title", title: [{ plain_text: "Synthetic task" }] } };
    const postProps = { "Post Title": { type: "title", title: [{ plain_text: "Synthetic post" }] } };
    expect(findFirstTitleProperty(taskProps)?.name).toBe("Task Name");
    const tp = parseAdDocsPropertiesFromNotionPage({ properties: taskProps });
    if (tp.ok) expect(tp.properties.title).toBe("Synthetic task");
    const pp = parseAdDocsPropertiesFromNotionPage({ properties: postProps });
    if (pp.ok) expect(pp.properties.title).toBe("Synthetic post");
    const blind = ctx({ properties: { needsJohn: false, sensitive: false } });
    const state = buildClefStateString(blind, "page.created", {}, 0, false);
    const base = buildClefBaselineStateString(blind, "page.created", {}, 0, false);
    expect(clefBlindInputMissingFields(blind, state, base)).toContain("title");
  });
});
