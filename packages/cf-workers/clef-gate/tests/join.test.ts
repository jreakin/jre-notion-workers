import { describe, expect, test } from "bun:test";
import { computeJoinFlags } from "../src/join.js";

describe("join flags", () => {
  test("false skip: would_skip but triage escalated / handed off / rescued", () => {
    expect(computeJoinFlags("would_skip", { disposition: "escalate_john", escalated: true }).false_skip).toBe(true);
    expect(computeJoinFlags("would_skip", { disposition: "handoff_lane", escalated: false }).false_skip).toBe(true);
    expect(computeJoinFlags("would_skip", { disposition: "spam", escalated: false, rescued: true })).toEqual({ agree: false, false_skip: true, false_wake: false });
  });
  test("false wake: escalate but triage spam/archive", () => {
    expect(computeJoinFlags("escalate", { disposition: "spam", escalated: false })).toEqual({ agree: false, false_skip: false, false_wake: true });
    expect(computeJoinFlags("escalate", { disposition: "archive_fyi", escalated: false }).false_wake).toBe(true);
  });
  test("agreement", () => {
    expect(computeJoinFlags("would_skip", { disposition: "spam", escalated: false }).agree).toBe(true);
    expect(computeJoinFlags("escalate", { disposition: "handoff_lane", escalated: false }).agree).toBe(true);
    expect(computeJoinFlags("fyi", { disposition: "leave", escalated: false }).agree).toBe(true);
    expect(computeJoinFlags("fyi", { disposition: "escalate_john", escalated: true }).agree).toBe(false);
  });
});
