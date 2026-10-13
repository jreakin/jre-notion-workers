import { describe, expect, test } from "bun:test";
import { buildEmailState, deriveShadowLabel, EMAIL_QUESTIONS, isFlashSample, parseEmailClefResponse } from "../src/clef-email.js";
import { parseEmailShadowBody } from "../src/payload.js";
import { answers, HASH_FLASH, HASH_NOFLASH, payload } from "./helpers.js";

describe("parse", () => {
  test("valid response, wrapped in result", () => {
    const p = parseEmailClefResponse({ result: answers({ person: 0.7 }) });
    expect(p?.p_person).toBe(0.7);
    expect(p?.urgency).toBe(0.4);
  });
  test("bad lane / out-of-range / missing → null → escalate", () => {
    expect(parseEmailClefResponse(answers({ lane: "marketing" }))).toBeNull();
    expect(parseEmailClefResponse(answers({ bulk: 1.5 }))).toBeNull();
    expect(parseEmailClefResponse({})).toBeNull();
    expect(deriveShadowLabel(null)).toBe("escalate");
  });
  test("bad urgency is log-only", () => {
    const a = answers();
    (a.answers as Record<string, unknown>).q_urgency = { type: "score", score: 9 };
    expect(parseEmailClefResponse(a)?.urgency).toBeNull();
  });
  test("thresholds", () => {
    const base = parseEmailClefResponse(answers())!;
    expect(deriveShadowLabel(base)).toBe("would_skip");
    expect(deriveShadowLabel({ ...base, p_person: 0.5 })).toBe("escalate");
    expect(deriveShadowLabel({ ...base, p_money_sec: 0.3 })).toBe("escalate");
    expect(deriveShadowLabel({ ...base, p_calendar: 0.5 })).toBe("escalate");
    expect(deriveShadowLabel({ ...base, lane: "cos" })).toBe("escalate");
    expect(deriveShadowLabel({ ...base, p_bulk: 0.89 })).toBe("fyi");
    expect(deriveShadowLabel({ ...base, p_person: 0.06 })).toBe("fyi");
  });
  test("six questions; flash sample is deterministic 10%", () => {
    expect(Object.keys(EMAIL_QUESTIONS).sort()).toEqual(["q_bulk", "q_calendar", "q_lane", "q_money_sec", "q_person", "q_urgency"]);
    expect(isFlashSample(HASH_FLASH)).toBe(true);
    expect(isFlashSample(HASH_NOFLASH)).toBe(false);
  });
  test("payload validation", () => {
    expect(parseEmailShadowBody("nope")).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseEmailShadowBody(JSON.stringify(payload({ msg_id_hash: "XYZ" })))).toMatchObject({ ok: false, reason: "invalid_msg_id_hash" });
    expect(parseEmailShadowBody(JSON.stringify(payload({ triage: { disposition: "maybe" } })))).toMatchObject({ ok: false, reason: "invalid_triage" });
    expect(parseEmailShadowBody(JSON.stringify(payload({ override: "boss" })))).toMatchObject({ ok: false, reason: "invalid_override" });
  });
  test("state stays under 1500 chars", () => {
    const r = parseEmailShadowBody(JSON.stringify(payload({ snippet: "q".repeat(400) })));
    if (!r.ok) throw new Error(r.reason);
    expect(buildEmailState(r.item).length).toBeLessThanOrEqual(1500);
  });
});
