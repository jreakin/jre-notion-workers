/**
 * Shared Notion SDK client — always from process.env.NOTION_TOKEN.
 */
import { Client } from "@notionhq/client";

let cachedClient: Client | null = null;

export function getNotionClient(): Client {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error("NOTION_TOKEN is not set");
  }
  if (!cachedClient) {
    cachedClient = new Client({ auth: token });
  }
  return cachedClient;
}

export function getDocsDatabaseId(): string {
  const id = process.env.DOCS_DATABASE_ID;
  if (!id) throw new Error("DOCS_DATABASE_ID is not set");
  return id;
}

export function getHomeDocsDatabaseId(): string {
  const id = process.env.HOME_DOCS_DATABASE_ID;
  if (!id) throw new Error("HOME_DOCS_DATABASE_ID is not set");
  return id;
}

export function getTasksDatabaseId(): string {
  const id = process.env.TASKS_DATABASE_ID;
  if (!id) throw new Error("TASKS_DATABASE_ID is not set");
  return id;
}

export function getSystemControlPlanePageId(): string {
  const id = process.env.SYSTEM_CONTROL_PLANE_PAGE_ID;
  if (!id) throw new Error("SYSTEM_CONTROL_PLANE_PAGE_ID is not set");
  return id;
}

export function getDeadLettersDatabaseId(): string {
  const id = process.env.DEAD_LETTERS_DATABASE_ID;
  if (!id) throw new Error("DEAD_LETTERS_DATABASE_ID is not set");
  return id;
}
