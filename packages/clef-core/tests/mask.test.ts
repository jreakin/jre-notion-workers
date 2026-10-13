import { describe, expect, test } from "bun:test";
import { maskPii } from "../src/mask.js";

describe("maskPii follow-ups", () => {
  test("bare-domain URLs (no scheme) are masked", () => {
    for (const t of ["see evil.example/x?y=1", "docs at foo.bar.io", "go to example.com:8080/a/b"]) {
      const m = maskPii(t);
      expect(m).toContain("[url]");
      expect(m).not.toMatch(/example|bar\.io/);
    }
  });
  test("URL-encoded emails (user%40host) are masked", () => {
    const m = maskPii("from alice.smith%40corp.co today");
    expect(m).toBe("from [email] today");
  });
  test("secret-looking prefixes are masked", () => {
    const secrets = [
      "sk_live_51Habcdef1234567890",
      "pk_test_abcdefgh123",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "github_pat_11ABCDEFG0123456789_abc",
      "xoxb-1234567890-abcdefghij",
      "AKIAABCDEFGHIJKLMNOP",
      "AIzaSyA-abcdefghijklmnopqrstuv",
      "ntn_abcdefghijklmnop1234",
      "sk-proj-abcdefghijklmnop1234",
      "Bearer abcdefghijklmnopqrstuvwx",
    ];
    for (const s of secrets) {
      const m = maskPii(`key ${s} end`);
      expect(m).toContain("[secret]");
      expect(m).not.toContain(s.slice(-6));
    }
  });
  test("ordinary text is untouched", () => {
    const t = "Ship v1.2 e.g. tomorrow; ref 12345; task_done ok";
    expect(maskPii(t)).toBe(t);
  });
});
