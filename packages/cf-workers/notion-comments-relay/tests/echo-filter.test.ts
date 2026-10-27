import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { Env } from "../src/env.js";
import {
  decideEchoFilter,
  echoFilterLogRow,
  LEGACY_ECHO_GATE,
  LEGACY_ECHO_REASON,
} from "../src/wake-gate/echo-filter.js";
import {
  AGENT_LANE_PREFIX_NAMES,
  echoFilterConfigFromEnv,
  GROKBOT_FLEET_COMMENTS_BOT_ID,
} from "../src/wake-gate/echo-filter-config.js";
import { buildGateContext } from "../src/wake-gate/gate-orchestration.js";
import { isHighSignal } from "../src/gate-log-ring.js";
import { AD_DOCS_DATA_SOURCE_ID } from "../src/wake-gate/wake-gate-types.js";

const JOHN = "2e7d872b-594c-8161-92a2-00024b29e816";
const OTHER_BOT = "99999999-8888-7777-6666-555555555555";
const HUMAN = "12121212-3434-5656-7878-909090909090";
const TRACKED_DB = "aaaaaaaa-1111-2222-3333-444444444444";
const UNTRACKED_DB = "bbbbbbbb-1111-2222-3333-444444444444";
const FLEET_LOCKS_DS = "6e0a45b3-eb3f-448f-b215-49e002bfeff3";
const TEXT_SENTINEL = "SENTINEL_COMMENT_TEXT_DO_NOT_LOG";

const baseEnv = {
  JOHN_NOTION_USER_IDS: JOHN,
  FLEET_COMMENTS_BOT_NOTION_USER_IDS: GROKBOT_FLEET_COMMENTS_BOT_ID,
  FLEET_LOCKS_DATA_SOURCE_ID: FLEET_LOCKS_DS,
  SUBMITTED_PROPERTY_IDS: ";Xo<",
} as Partial<Env>;

function comment(
  authors: Array<{ id: string; type?: string }>,
  text: string,
  extraRich: unknown[] = [],
  type = "comment.created",
): Record<string, unknown> {
  return {
    id: `evt-${Math.random()}`,
    type,
    authors,
    entity: { id: "comment-1", type: "comment" },
    data: {
      page_id: "page-1",
      parent: { id: "page-1", type: "page" },
      rich_text: [...extraRich, { type: "text", plain_text: text, text: { content: text } }],
    },
  };
}

function propsUpdated(parent: Record<string, unknown> | null, updated: string[] = ["abc"]): Record<string, unknown> {
  return {
    id: `evt-${Math.random()}`,
    type: "page.properties_updated",
    authors: [{ id: HUMAN, type: "person" }],
    entity: { id: "page-2", type: "page" },
    data: { ...(parent ? { parent } : {}), updated_properties: updated },
  };
}

function decide(parsed: Record<string, unknown>, env: Partial<Env> = baseEnv) {
  const type = parsed.type as string;
  const ctx = buildGateContext(parsed, type, JSON.stringify(parsed), env as Env);
  return decideEchoFilter(parsed, ctx, echoFilterConfigFromEnv(env));
}

describe("echo filter rule 1: own_echo", () => {
  test("GrokBot Fleet Comments bot comment → own_echo", () => {
    expect(decide(comment([{ id: GROKBOT_FLEET_COMMENTS_BOT_ID, type: "bot" }], "Logged the update."))).toEqual({
      decision: "drop",
      reason: "own_echo",
    });
  });

  test("Fleet Comments bot is own-fleet even when the var is unset and author type is missing", () => {
    expect(
      decide(comment([{ id: GROKBOT_FLEET_COMMENTS_BOT_ID }], "x"), { JOHN_NOTION_USER_IDS: JOHN }),
    ).toEqual({ decision: "drop", reason: "own_echo" });
  });

  test("any bot / integration author (incl. the relay's own integration) → own_echo", () => {
    expect(decide(comment([{ id: OTHER_BOT, type: "bot" }], "Synced 3 rows"))).toEqual({
      decision: "drop",
      reason: "own_echo",
    });
  });

  test("dashed vs undashed configured bot id still matches", () => {
    const undashed = OTHER_BOT.replace(/-/g, "");
    const env = { ...baseEnv, FLEET_COMMENTS_BOT_NOTION_USER_IDS: undashed };
    expect(decide(comment([{ id: OTHER_BOT, type: "person" }], "hi"), env)).toEqual({
      decision: "drop",
      reason: "own_echo",
    });
  });

  test("mixed bot + human authors pass", () => {
    expect(
      decide(comment([{ id: OTHER_BOT, type: "bot" }, { id: HUMAN, type: "person" }], "please review")),
    ).toEqual({ decision: "pass", reason: "comment_passed" });
  });

  test("comment.updated by a bot also drops", () => {
    expect(decide(comment([{ id: OTHER_BOT, type: "bot" }], "edit", [], "comment.updated")).decision).toBe("drop");
  });

  test("no authors → pass (author_unknown)", () => {
    expect(decide(comment([], "CoS: x"))).toEqual({ decision: "pass", reason: "author_unknown" });
  });

  test("own_echo log row keeps the legacy shadow reason for continuity", () => {
    const parsed = comment([{ id: GROKBOT_FLEET_COMMENTS_BOT_ID, type: "bot" }], TEXT_SENTINEL);
    const ctx = buildGateContext(parsed, "comment.created", JSON.stringify(parsed), baseEnv as Env);
    const cfg = echoFilterConfigFromEnv(baseEnv);
    const row = echoFilterLogRow(ctx, decideEchoFilter(parsed, ctx, cfg), cfg);
    expect(row).toMatchObject({
      stream: "echo_filter",
      decision: "drop",
      reason: "own_echo",
      legacy_gate: LEGACY_ECHO_GATE,
      legacy_reason: LEGACY_ECHO_REASON,
      mode: "live",
    });
    expect(isHighSignal(row)).toBe(true);
  });
});

describe("echo filter rule 1: agent_prefix", () => {
  test.each([
    "CoS: triaged, moving on",
    "BCH: PR opened",
    "AS: reviewed",
    "[Steward] gate log flushed",
    "EC → handed to CoS",
    "EC -> handed to CoS",
    "**Chief of Staff:** noted",
    "  [BCH] done",
    "Abstract Secretary — review posted",
  ])("human-account comment starting with %p → agent_prefix", (text) => {
    expect(decide(comment([{ id: HUMAN, type: "person" }], text))).toEqual({ decision: "drop", reason: "agent_prefix" });
  });

  test.each(["Can CoS look at this?", "cost: $40", "ASAP please", "Echo the result", "as: lowercase is not a lane"])(
    "non-prefix text %p passes",
    (text) => {
      expect(decide(comment([{ id: HUMAN, type: "person" }], text))).toEqual({
        decision: "pass",
        reason: "comment_passed",
      });
    },
  );

  test("John @mentioning an agent passes", () => {
    const mention = {
      type: "mention",
      plain_text: "@Chief of Staff",
      mention: { type: "user", user: { id: OTHER_BOT, type: "bot" } },
    };
    expect(decide(comment([{ id: JOHN, type: "person" }], " please pick this up", [mention]))).toEqual({
      decision: "pass",
      reason: "john_authored",
    });
  });

  test("John writing a lane prefix himself still passes", () => {
    expect(decide(comment([{ id: JOHN, type: "person" }], "CoS: can you take this?"))).toEqual({
      decision: "pass",
      reason: "john_authored",
    });
  });

  test("JOHN_NOTION_USER_IDS unset → prefix rule fails open", () => {
    const env = { ...baseEnv, JOHN_NOTION_USER_IDS: undefined };
    expect(decide(comment([{ id: HUMAN, type: "person" }], "CoS: x"), env)).toEqual({
      decision: "pass",
      reason: "john_ids_unset",
    });
  });

  test("ECHO_FILTER_LANE_PREFIXES extends the list", () => {
    const env = { ...baseEnv, ECHO_FILTER_LANE_PREFIXES: "Ops Bot" };
    expect(decide(comment([{ id: HUMAN, type: "person" }], "Ops Bot: synced"), env).reason).toBe("agent_prefix");
  });

  test("prefix list lives in config and includes the fleet lanes", () => {
    for (const n of ["CoS", "BCH", "AS", "Steward", "EC"]) expect(AGENT_LANE_PREFIX_NAMES).toContain(n as never);
  });
});

describe("echo filter rule 2: untracked_property_edit", () => {
  const tracked = { ...baseEnv, TRACKED_PARENT_IDS: TRACKED_DB };

  test("allowlist unset → fail open (pass everything)", () => {
    expect(decide(propsUpdated({ type: "database_id", database_id: UNTRACKED_DB }))).toEqual({
      decision: "pass",
      reason: "allowlist_unset",
    });
  });

  test("allowlist empty / whitespace → fail open", () => {
    const env = { ...baseEnv, TRACKED_PARENT_IDS: " , " };
    expect(decide(propsUpdated({ type: "database_id", database_id: UNTRACKED_DB }), env).reason).toBe(
      "allowlist_unset",
    );
  });

  test("untracked parent database → untracked_property_edit (parent id logged, page id not)", () => {
    const parsed = propsUpdated({ type: "database_id", database_id: UNTRACKED_DB });
    const v = decide(parsed, tracked);
    expect(v).toEqual({ decision: "drop", reason: "untracked_property_edit", parentId: UNTRACKED_DB });
    const ctx = buildGateContext(parsed, "page.properties_updated", JSON.stringify(parsed), tracked as Env);
    const row = echoFilterLogRow(ctx, v, { enabled: true });
    expect(row.parent_id).toBe(UNTRACKED_DB);
    expect(JSON.stringify(row)).not.toContain("page-2");
  });

  test("tracked parent (undashed id, data_source parent) passes", () => {
    const parsed = propsUpdated({ type: "data_source_id", data_source_id: TRACKED_DB.replace(/-/g, "") });
    expect(decide(parsed, tracked)).toEqual({ decision: "pass", reason: "tracked_parent" });
  });

  test("2025-09 shape {type: data_source, id} is read", () => {
    expect(decide(propsUpdated({ type: "data_source", id: TRACKED_DB }), tracked).reason).toBe("tracked_parent");
    expect(decide(propsUpdated({ type: "data_source", id: UNTRACKED_DB }), tracked).reason).toBe(
      "untracked_property_edit",
    );
  });

  test("Fleet Locks and AD Docs are always tracked once the allowlist is on", () => {
    expect(decide(propsUpdated({ type: "data_source_id", data_source_id: FLEET_LOCKS_DS }), tracked).reason).toBe(
      "tracked_parent",
    );
    expect(
      decide(propsUpdated({ type: "data_source_id", data_source_id: AD_DOCS_DATA_SOURCE_ID }), tracked).reason,
    ).toBe("tracked_parent");
  });

  test("Submitted property change on an untracked parent still passes", () => {
    const parsed = propsUpdated({ type: "database_id", database_id: UNTRACKED_DB }, [";Xo<"]);
    expect(decide(parsed, tracked)).toEqual({ decision: "pass", reason: "must_wake_property" });
  });

  test("URL-encoded Submitted / configured Needs John ids also pass", () => {
    const enc = propsUpdated({ type: "database_id", database_id: UNTRACKED_DB }, ["%3BXo%3C"]);
    expect(decide(enc, tracked).reason).toBe("must_wake_property");
    const nj = propsUpdated({ type: "database_id", database_id: UNTRACKED_DB }, ["NJ1"]);
    expect(decide(nj, { ...tracked, NEEDS_JOHN_PROPERTY_IDS: "NJ1" }).reason).toBe("must_wake_property");
  });

  test("unknown parent → pass", () => {
    expect(decide(propsUpdated(null), tracked)).toEqual({ decision: "pass", reason: "parent_unknown" });
  });

  test("page.created on an untracked parent passes", () => {
    const parsed = { ...propsUpdated({ type: "database_id", database_id: UNTRACKED_DB }), type: "page.created" };
    expect(decide(parsed, tracked)).toEqual({ decision: "pass", reason: "not_filtered_type" });
  });

  test("human comment on a page under an untracked parent passes", () => {
    expect(decide(comment([{ id: HUMAN, type: "person" }], "looks good to merge?"), tracked).reason).toBe(
      "comment_passed",
    );
  });
});

describe("echo filter kill switch", () => {
  test("ECHO_FILTER=off passes everything", () => {
    const env = { ...baseEnv, ECHO_FILTER: "off" };
    expect(decide(comment([{ id: OTHER_BOT, type: "bot" }], "CoS: x"), env)).toEqual({
      decision: "pass",
      reason: "filter_disabled",
    });
  });
});

// ---- worker integration: drop before coalesce/forward, 200, logged without text ----

const TOKEN_KEY = "notion_verification_token";
const COALESCE_BUF_KEY = "coalesce_buffer";

function makeEnv(store: Map<string, string>, extra: Partial<Env> = {}): Env {
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
  return {
    RELAY_KV: kv,
    COS_WEBHOOK_URL: "https://cos.example/webhook",
    COS_WEBHOOK_AUTHORIZATION: "Bearer cos",
    SETUP_SECRET: "setup",
    NOTION_VERIFICATION_TOKEN: "secret_test_token",
    ...baseEnv,
    ...extra,
  } as Env;
}

async function post(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", "secret_test_token").update(body).digest("hex")}`;
  const { default: worker } = await import("../src/index.js");
  return worker.fetch(
    new Request("https://relay/", {
      method: "POST",
      headers: { "X-Notion-Signature": sig, "content-type": "application/json", "user-agent": "notion" },
      body,
    }),
    env,
    { waitUntil() {} } as unknown as ExecutionContext,
  );
}

describe("echo filter in the worker forward path", () => {
  const origLog = console.log;
  let logs: string[] = [];
  afterEach(() => {
    console.log = origLog;
    mock.restore();
  });
  function capture() {
    logs = [];
    console.log = ((l: unknown) => logs.push(String(l))) as typeof console.log;
  }
  function echoRows() {
    return logs.filter((l) => l.includes('"stream":"echo_filter"')).map((l) => JSON.parse(l));
  }

  test("own echo: 200, not coalesced, logged own_echo without text", async () => {
    capture();
    const store = new Map([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(store);
    const res = await post(env, comment([{ id: GROKBOT_FLEET_COMMENTS_BOT_ID, type: "bot" }], TEXT_SENTINEL));
    expect(res.status).toBe(200);
    expect(store.get(COALESCE_BUF_KEY)).toBeUndefined();
    expect(echoRows()).toHaveLength(1);
    expect(echoRows()[0]).toMatchObject({ decision: "drop", reason: "own_echo" });
    for (const l of logs) expect(l).not.toContain(TEXT_SENTINEL);
  });

  test("agent prefix: 200, not coalesced", async () => {
    capture();
    const store = new Map([[TOKEN_KEY, "secret_test_token"]]);
    const res = await post(makeEnv(store), comment([{ id: HUMAN, type: "person" }], `BCH: ${TEXT_SENTINEL}`));
    expect(res.status).toBe(200);
    expect(store.get(COALESCE_BUF_KEY)).toBeUndefined();
    expect(echoRows()[0]).toMatchObject({ decision: "drop", reason: "agent_prefix" });
    for (const l of logs) expect(l).not.toContain(TEXT_SENTINEL);
  });

  test("untracked property edit: 200, not coalesced", async () => {
    capture();
    const store = new Map([[TOKEN_KEY, "secret_test_token"]]);
    const env = makeEnv(store, { TRACKED_PARENT_IDS: TRACKED_DB });
    const res = await post(env, propsUpdated({ type: "database_id", database_id: UNTRACKED_DB }));
    expect(res.status).toBe(200);
    expect(store.get(COALESCE_BUF_KEY)).toBeUndefined();
    expect(echoRows()[0]).toMatchObject({ decision: "drop", reason: "untracked_property_edit" });
  });

  test("John @mentioning an agent is coalesced for forwarding and logged as a pass", async () => {
    capture();
    const store = new Map([[TOKEN_KEY, "secret_test_token"]]);
    const mention = {
      type: "mention",
      plain_text: "@BCH",
      mention: { type: "user", user: { id: OTHER_BOT, type: "bot" } },
    };
    const res = await post(makeEnv(store), comment([{ id: JOHN, type: "person" }], " please fix CI", [mention]));
    expect(res.status).toBe(200);
    const buf = JSON.parse(store.get(COALESCE_BUF_KEY) ?? "[]") as unknown[];
    expect(buf).toHaveLength(1);
    expect(echoRows()[0]).toMatchObject({ decision: "pass", reason: "john_authored" });
  });

  test("allowlist unset: untracked property edit still coalesced (fail open)", async () => {
    capture();
    const store = new Map([[TOKEN_KEY, "secret_test_token"]]);
    const res = await post(makeEnv(store), propsUpdated({ type: "database_id", database_id: UNTRACKED_DB }));
    expect(res.status).toBe(200);
    expect(JSON.parse(store.get(COALESCE_BUF_KEY) ?? "[]")).toHaveLength(1);
    expect(echoRows()[0]).toMatchObject({ decision: "pass", reason: "allowlist_unset" });
  });
});
