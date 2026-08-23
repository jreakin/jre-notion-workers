import { describe, expect, it } from "bun:test";
import {
  buildGitHubItemProjectRelation,
  DOC_TRIAGE_STATUS,
  isAssessmentDocType,
  isAssessmentTitle,
  isDeadGitHubItemsDatabaseId,
  isLiveGitHubItemsDatabaseId,
  readGitHubItemClientIds,
  readGitHubItemProjectIds,
  readTimeLogGithubItemIds,
  TIME_LOG_PROPS,
} from "../../src/shared/notion-schema.js";

describe("notion-schema", () => {
  it("detects dead vs live GitHub Items database IDs", () => {
    expect(isDeadGitHubItemsDatabaseId("8c8a07b9-8ac9-45fb-8572-9bfc2cf3a18e")).toBe(true);
    expect(isLiveGitHubItemsDatabaseId("3e789948-1fee-4af2-ac07-7e462e5c1e3e")).toBe(true);
    expect(isDeadGitHubItemsDatabaseId("3e789948-1fee-4af2-ac07-7e462e5c1e3e")).toBe(false);
  });

  it("reads GitHub Item relations with Sync names and legacy fallback", () => {
    const props = {
      Clients: { relation: [{ id: "client-1" }] },
      "📊 Projects": { relation: [{ id: "proj-1" }] },
    };
    expect(readGitHubItemClientIds(props)).toEqual(["client-1"]);
    expect(readGitHubItemProjectIds(props)).toEqual(["proj-1"]);

    const legacy = {
      Client: { relation: [{ id: "client-legacy" }] },
      Project: { relation: [{ id: "proj-legacy" }] },
    };
    expect(readGitHubItemClientIds(legacy)).toEqual(["client-legacy"]);
    expect(readGitHubItemProjectIds(legacy)).toEqual(["proj-legacy"]);
  });

  it("builds project-only GitHub Item relation writes", () => {
    expect(buildGitHubItemProjectRelation([])).toBeNull();
    expect(buildGitHubItemProjectRelation(["proj-1"])).toEqual({
      "📊 Projects": { relation: [{ id: "proj-1" }] },
    });
  });

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
