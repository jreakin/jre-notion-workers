import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEBUG_CAPTURE_MIN_INTERVAL_MS,
  claimDebugCaptureSlot,
  resetDebugCaptureThrottleForTests,
} from "../src/debug-capture-throttle.js";

describe("debug capture throttle", () => {
  beforeEach(() => resetDebugCaptureThrottleForTests());

  test("first capture is allowed", () => {
    expect(claimDebugCaptureSlot(1_000)).toBe(true);
  });

  test("captures within the interval are suppressed", () => {
    expect(claimDebugCaptureSlot(1_000)).toBe(true);
    expect(claimDebugCaptureSlot(1_001)).toBe(false);
    expect(claimDebugCaptureSlot(1_000 + DEBUG_CAPTURE_MIN_INTERVAL_MS - 1)).toBe(false);
  });

  test("capture is allowed again once the interval elapses", () => {
    expect(claimDebugCaptureSlot(1_000)).toBe(true);
    expect(claimDebugCaptureSlot(1_000 + DEBUG_CAPTURE_MIN_INTERVAL_MS)).toBe(true);
  });

  test("a burst of 2,000 webhooks in one minute costs one write", () => {
    let writes = 0;
    for (let i = 0; i < 2_000; i++) if (claimDebugCaptureSlot(10_000 + i * 25)) writes++;
    expect(writes).toBe(1);
  });
});
