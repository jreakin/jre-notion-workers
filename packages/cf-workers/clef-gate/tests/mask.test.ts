import { describe, expect, test } from "bun:test";
import { cleanMaskClip, maskPii } from "../src/mask.js";
import { parseEmailShadowBody } from "../src/payload.js";
import { payload } from "./helpers.js";

describe("masking", () => {
  test("emails, phones, urls, digit runs >= 6", () => {
    const m = maskPii("mail a.b+c@x.co.uk or (512) 555-0199, +1 512 555 0199, acct 1234567, ref 12345, https://a.b/c?x=1");
    expect(m).not.toContain("@");
    expect(m).not.toContain("555");
    expect(m).not.toContain("1234567");
    expect(m).not.toContain("https://");
    expect(m).toContain("12345"); // 5-digit run is kept
    expect(m).toContain("[email]");
  });
  test("spaced/dashed long digit runs are masked", () => {
    expect(maskPii("card 4111 1111 1111 1111")).not.toMatch(/\d{4}/);
    expect(maskPii("ssn 123-45-6789")).not.toContain("6789");
  });
  test("clip after masking and strip control chars", () => {
    expect(cleanMaskClip("a\u0000b\n" + "x".repeat(500), 140).length).toBe(140);
  });
  test("payload subject/snippet re-masked and clipped", () => {
    const r = parseEmailShadowBody(JSON.stringify(payload({ subject: "s".repeat(300) + " 99999999", snippet: "z@z.io " + "y".repeat(600) })));
    if (!r.ok) throw new Error(r.reason);
    expect(r.item.subject.length).toBe(140);
    expect(r.item.snippet.length).toBe(400);
    expect(r.item.snippet).not.toContain("@");
  });
  test("size limits: oversize body dropped", () => {
    const r = parseEmailShadowBody(JSON.stringify(payload({ snippet: "x".repeat(9000) })));
    expect(r).toEqual({ ok: false, reason: "payload_too_large" });
  });
});
