import { describe, test, expect } from "bun:test";
import {
  parseGitAttributes,
  pathMatchesLinguistPattern,
  expandLinguistGeneratedForFiles,
} from "../../src/shared/pr-estimate-gitattributes.js";

describe("pr-estimate-gitattributes", () => {
  test("parses linguist-generated lines", () => {
    const content = `dist/* linguist-generated
*.min.js linguist-generated=true
README.md linguist-generated=false`;
    const parsed = parseGitAttributes(content);
    expect(parsed.patterns).toContain("dist/*");
    expect(parsed.patterns).toContain("*.min.js");
    expect(parsed.patterns).not.toContain("README.md");
  });

  test("matches glob patterns on files", () => {
    const parsed = parseGitAttributes("vendor/* linguist-generated");
    expect(pathMatchesLinguistPattern("vendor/foo/bar.js", parsed.patterns)).toBe(true);
    const expanded = expandLinguistGeneratedForFiles(["vendor/foo/bar.js"], parsed);
    expect(expanded.has("vendor/foo/bar.js")).toBe(true);
  });
});
