/**
 * Shared Notion SDK client.
 * Uses NTN_API_TOKEN env var (NOTION_TOKEN is a reserved prefix in the Workers SDK).
 */
import { Client } from "@notionhq/client";

let cachedClient: Client | null = null;

export function getNotionClient(): Client {
  const token = process.env.NTN_API_TOKEN;
  if (!token) {
    throw new Error("NTN_API_TOKEN is not set");
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

export function getGitHubItemsDatabaseId(): string {
  const id = process.env.GITHUB_ITEMS_DATABASE_ID;
  if (!id) throw new Error("GITHUB_ITEMS_DATABASE_ID is not set");
  return id;
}

export function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return token;
}

export function getFollowUpTrackerDatabaseId(): string {
  const id = process.env.FOLLOW_UP_TRACKER_DATABASE_ID;
  if (!id) throw new Error("FOLLOW_UP_TRACKER_DATABASE_ID is not set");
  return id;
}

export function getAiMeetingsDatabaseId(): string {
  const id = process.env.AI_MEETINGS_DATABASE_ID;
  if (!id) throw new Error("AI_MEETINGS_DATABASE_ID is not set");
  return id;
}

export function getClientsDatabaseId(): string {
  const id = process.env.CLIENTS_DATABASE_ID;
  if (!id) throw new Error("CLIENTS_DATABASE_ID is not set");
  return id;
}

export function getContactsDatabaseId(): string | null {
  return process.env.CONTACTS_DATABASE_ID || null;
}

export function getProjectsDatabaseId(): string {
  const id = process.env.PROJECTS_DATABASE_ID;
  if (!id) throw new Error("PROJECTS_DATABASE_ID is not set");
  return id;
}

export function getDecisionLogDatabaseId(): string {
  const id = process.env.DECISION_LOG_DATABASE_ID;
  if (!id) throw new Error("DECISION_LOG_DATABASE_ID is not set");
  return id;
}

export function getLabelRegistryDatabaseId(): string {
  const id = process.env.LABEL_REGISTRY_DATABASE_ID;
  if (!id) throw new Error("LABEL_REGISTRY_DATABASE_ID is not set");
  return id;
}

export function getTimeLogDatabaseId(): string {
  const id = process.env.TIME_LOG_DATABASE_ID;
  if (!id) throw new Error("TIME_LOG_DATABASE_ID is not set");
  return id;
}
