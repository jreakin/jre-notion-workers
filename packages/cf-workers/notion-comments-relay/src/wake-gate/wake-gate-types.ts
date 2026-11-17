export const AD_DOCS_DATA_SOURCE_ID = "2e97d7f5-6298-804c-b8a5-000b18b72684";
/** Default Tasks data source (non-secret; override with TASKS_DATA_SOURCE_ID). */
export const DEFAULT_TASKS_DATA_SOURCE_ID = "2e97d7f5-6298-80a5-acef-000bb9796a9d";

export type WakeDecision = "would_wake" | "would_skip" | "would_log_only";

export interface WakeRelevantSnapshot {
  needsJohn: boolean;
  sensitive: boolean;
  kind: string | null;
  titleMatchedTemplate: boolean;
  sourceRepo: string | null;
  documentType: string | null;
  inTrash: boolean;
}

export interface GatePageInputs {
  pageId: string;
  dataSourceId: string | null;
  title: string | null;
  inTrash: boolean;
  needsJohn: boolean | null;
  sensitive: boolean | null;
  kind: string | null;
  sourceRepo: string | null;
  documentType: string | null;
  hasClientsRelation: boolean | null;
  hasProjectRelation: boolean | null;
  updatedPropertyIds: string[];
  updatedPropertiesKnown?: boolean;
  notionEventType: string | null;
  authorUserIds: string[];
  schemaNeedsPropertyFetch?: boolean;
}

export interface ShadowGateResult {
  decision: WakeDecision;
  reason: string;
  inputs: Record<string, unknown>;
  pageId: string | null;
  dataSourceId: string | null;
  notionEventType: string | null;
}

export interface ParsedWakePayload {
  pageId: string | null;
  dataSourceId: string | null;
  inTrash: boolean | null;
  titleFromAutomation: string | null;
  updatedPropertyIds: string[];
  authorUserIds: string[];
  notionEventType: string | null;
  isAutomationPageObject: boolean;
  isCommentEvent: boolean;
  updatedPropertiesKnown: boolean;
}
