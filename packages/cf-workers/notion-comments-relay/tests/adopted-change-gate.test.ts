import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideAdoptedChangeGate } from "../src/wake-gate/adopted-change-gate.js";
import { isFleetLocksParent, readPageParentIds } from "../src/wake-gate/notion-ids.js";
import {
  FLEET_LOCKS_NON_SUBMITTED_PROPERTY_ID_VALUES,
  parseFleetLocksFieldsFromNotionPage,
} from "../src/wake-gate/fleet-locks-properties.js";
import type { GateEventContext } from "../src/wake-gate/gate-event-types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FLEET_DS = "6e0a45b3-eb3f-448f-b215-49e002bfeff3";
const FLEET_DB = "f25ca47e-bfc4-4c75-9113-e3bece7d0830";
const JOHN = "user-john-001";

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(here, "../fixtures/fleet", name), "utf8"),
  ) as Record<string, unknown>;
}

function fleetCtx(overrides: Partial<GateEventContext> = {}): GateEventContext {
  const page = loadFixture("fleet-locks.adopted-full.json");
  const fields = parseFleetLocksFieldsFromNotionPage(page);
  return {
    notionType: "page.properties_updated",
    rawBody: "{}",
    pageId: "page-lock-1",
    authorId: JOHN,
    webhookAuthorIds: [JOHN],
    pageAuthorId: JOHN,
    pageLastEditedById: JOHN,
    isCommentEvent: false,
    propertiesAvailable: false,
    properties: {},
    johnUserIds: new Set([JOHN]),
    fleetCommentsBotIds: new Set(),
    submittedPropertyIds: new Set(),
    nonSubmittedPropertyIds: new Set(FLEET_LOCKS_NON_SUBMITTED_PROPERTY_ID_VALUES),
    updatedPropertyIds: ["yDiF"],
    fleetLocksDataSourceId: FLEET_DS,
    fleetLocksDatabaseId: FLEET_DB,
    fleetLocksParentKnown: true,
    fleetLocksFields: fields,
    fleetLocksAdoptedAt: fields.adoptedAt,
    ...overrides,
  };
}

describe("adopted-change-gate", () => {
  test("adopted change full wake when John and adoption fields set", () => {
    const d = decideAdoptedChangeGate(fleetCtx());
    expect(d.decision).toBe("would_wake");
    expect(d.reason).toBe("adopted_change");
  });

  test("adopted change skips when author is not John", () => {
    const page = loadFixture("fleet-locks.adopted-full.json");
    const props = page.properties as Record<string, unknown>;
    const by = props["Adopted By"] as Record<string, unknown>;
    by.people = [{ object: "user", id: "user-bot-1" }];
    const fields = parseFleetLocksFieldsFromNotionPage(page);
    const d = decideAdoptedChangeGate(
      fleetCtx({
        pageAuthorId: "user-bot-1",
        authorId: "user-bot-1",
        webhookAuthorIds: ["user-bot-1"],
        pageLastEditedById: "user-bot-1",
        fleetLocksFields: fields,
      }),
    );
    expect(d.decision).toBe("would_skip");
    expect(d.reason).toBe("lock_author_not_john");
  });

  test("legacy database parent id matches fleet database env", () => {
    const page = loadFixture("fleet-locks.parent-database-id-legacy.json");
    expect(isFleetLocksParent(readPageParentIds(page), FLEET_DS, FLEET_DB)).toBe(true);
  });

  test("adopted change dedupes same adopted at", () => {
    const d = decideAdoptedChangeGate(
      fleetCtx({ adoptedAtAlreadyWoken: "2026-10-01T12:00:00.000Z" }),
    );
    expect(d.decision).toBe("would_skip");
    expect(d.reason).toBe("adopted_already_woken");
  });

  test("parent mismatch after webhook fleet hint is unreadable not lock_not_adopted", () => {
    const d = decideAdoptedChangeGate(
      fleetCtx({
        webhookIndicatedFleetLocks: true,
        fleetLocksParentKnown: false,
        notionFetchFailReason: "notion_page_unreadable",
        fleetLocksFields: undefined,
      }),
    );
    expect(d.decision).toBe("would_wake");
    expect(d.reason).toBe("notion_page_unreadable");
  });
});
