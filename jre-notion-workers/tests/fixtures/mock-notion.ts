/**
 * Shared mock Notion client for unit and schema contract tests.
 * Integration tests use the real Client with TEST_NOTION_TOKEN.
 */
import { mock } from "bun:test";
import type { Client } from "@notionhq/client";

export const MOCK_PAGE_ID = "mock-page-id-abc123";
export const MOCK_PAGE_URL = "https://www.notion.so/mock-page-id-abc123";

export function createMockNotionClient(overrides?: Partial<{
  pagesCreate: (...args: unknown[]) => Promise<{ id: string; url: string }>;
  databasesQuery: (...args: unknown[]) => Promise<{ results: unknown[]; has_more: boolean }>;
  blocksChildrenList: (...args: unknown[]) => Promise<{ results: unknown[] }>;
  blocksChildrenAppend: (...args: unknown[]) => Promise<{ results: unknown[] }>;
}>): Client {
  const pagesCreate = overrides?.pagesCreate ?? mock(async () => ({ id: MOCK_PAGE_ID, url: MOCK_PAGE_URL }));
  const databasesQuery = overrides?.databasesQuery ?? mock(async () => ({ results: [], has_more: false }));
  const blocksChildrenList = overrides?.blocksChildrenList ?? mock(async () => ({ results: [] }));
  const blocksChildrenAppend = overrides?.blocksChildrenAppend ?? mock(async () => ({ results: [] }));

  return {
    pages: {
      create: pagesCreate as Client["pages"]["create"],
      retrieve: mock(async () => ({ id: MOCK_PAGE_ID, url: MOCK_PAGE_URL, properties: {} })),
      update: mock(async () => ({})),
    },
    databases: {
      query: databasesQuery as Client["databases"]["query"],
    },
    blocks: {
      children: {
        list: blocksChildrenList as Client["blocks"]["children"]["list"],
        append: blocksChildrenAppend as Client["blocks"]["children"]["append"],
      },
    },
  } as unknown as Client;
}
