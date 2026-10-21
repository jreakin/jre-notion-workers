import { describe, expect, it } from "bun:test";
import {
  DOC_TRIAGE_STATUS,
  isAssessmentDocType,
  isAssessmentTitle,
  readTimeLogGithubItemIds,
  TIME_LOG_PROPS,
} from "../../src/shared/notion-schema.js";

describe("notion-schema", () => {
  it("uses GitHub Item Sync for Time Log writes and reads legacy fallback", () => {
    expect(TIME_LOG_PROPS.githubItem).toBe("GitHub Item Sync");
    expect(TIME_LOG_PROPS.legacyGithubItem).toBe("GitHub Item");

    const syncOnly = {
      [TIME_LOG_PROPS.githubItem]: { relation: [{ id: "gh-sync-1" }] },
    };
    expect(readTimeLogGithubItemIds(syncOnly)).toEqual(["gh-sync-1"]);

    const legacyOnly = {
      [TIME_LOG_PROPS.legacyGithubItem]: { relation: [{ id: "gh-legacy-1" }] },
    };
    expect(readTimeLogGithubItemIds(legacyOnly)).toEqual(["gh-legacy-1"]);

    const both = {
      [TIME_LOG_PROPS.githubItem]: { relation: [{ id: "gh-sync-2" }] },
      [TIME_LOG_PROPS.legacyGithubItem]: { relation: [{ id: "gh-legacy-2" }] },
    };
    expect(readTimeLogGithubItemIds(both)).toEqual(["gh-sync-2"]);
  });

  it("identifies assessment doc types and titles", () => {
    expect(isAssessmentDocType("AI Codebase Assessment")).toBe(true);
    expect(isAssessmentTitle("QR — AI Codebase Assessment")).toBe(true);
    expect(isAssessmentTitle("Quarterly Report")).toBe(false);
    expect(DOC_TRIAGE_STATUS).toBe("Needs Triage");
  });
});
