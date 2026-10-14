export type WakeDecisionOutcome = "would_wake" | "would_skip" | "would_log_only";

export type ClefDecisionOutcome = "would_wake" | "would_skip" | "would_batch" | "would_log_only";

export type WakeGateDecision = {
  gate_name: string;
  decision: WakeDecisionOutcome;
  reason: string;
  inputs: Record<string, unknown>;
  ts: string;
  mode: "shadow";
};

export type NotionPageProperties = {
  title?: string;
  needsJohn?: boolean;
  sensitive?: boolean;
  kind?: string;
  sourceRepo?: string;
  documentType?: string;
  authorLane?: string;
  inTrash?: boolean;
  submittedChanged?: boolean;
  adDocsParseOk?: boolean;
};

export type ClefShadowLogEntry = {
  ts: string;
  gate: "clef_wake";
  item_id: string;
  source: string;
  event: string | null;
  rule_decision: WakeDecisionOutcome;
  clef_decision: ClefDecisionOutcome;
  p_action: number | null;
  p_dup: number | null;
  q_when: string | null;
  confidence: number | null;
  model: string | null;
  latency_ms: number | null;
  sampled_full: {
    decision: ClefDecisionOutcome;
    p_action: number;
    p_dup: number;
    q_when: string;
    model: string;
  } | null;
  mode: string;
  actually_ran: string;
  reason: string;
  /** Set only on rule-skip shadow rows (rule said skip; Clef scored it shadow-only). */
  decision?: "rule_skip";
  /** True when rules skipped but Clef said would_wake (false-skip candidate). */
  candidate_false_skip?: boolean;
  /** Pre-Clef same-item dedupe: this event repeated an item+event type already seen in the window. */
  dedupe_repeat?: boolean;
  /** 1-based count of this item+event type inside the dedupe window (set on repeats). */
  item_event_count?: number;
  /** Rule said wake, dedupe would drop it: one saved wake. Sum per unique item_id for grading. */
  saved_wake?: boolean;
};

export type FleetLocksFieldSnapshot = {
  statusName?: string;
  adoptedAt?: string;
  adoptedBySet: boolean;
  adoptedByPersonIds: string[];
  grandfathered: boolean;
  parseOk: boolean;
};

export type GateEventContext = {
  notionType: string | null;
  rawBody: string;
  pageId?: string;
  authorId?: string;
  webhookAuthorIds?: string[];
  authorName?: string;
  pageAuthorId?: string;
  pageCreatedById?: string;
  pageLastEditedById?: string;
  isCommentEvent: boolean;
  properties?: NotionPageProperties;
  propertiesAvailable: boolean;
  parentDatabaseTitle?: string;
  webhookParentDataSourceId?: string;
  webhookParentDatabaseId?: string;
  needsJohnNow?: boolean;
  duplicateWithin60s?: boolean;
  priorWakeHash?: string;
  johnUserIds: Set<string>;
  fleetCommentsBotIds: Set<string>;
  submittedPropertyIds: Set<string>;
  /** Optional (NEEDS_JOHN_PROPERTY_IDS). Empty ⇒ the properties_updated change rule is inert. */
  needsJohnPropertyIds?: Set<string>;
  nonSubmittedPropertyIds: Set<string>;
  updatedPropertyIds: string[];
  fleetLocksDataSourceId?: string;
  fleetLocksDatabaseId?: string;
  fleetLocksParentKnown?: boolean;
  webhookIndicatedFleetLocks?: boolean;
  fleetLocksFields?: FleetLocksFieldSnapshot;
  fleetLocksAdoptedAt?: string;
  notionFetchFailReason?: string;
  adoptedAtAlreadyWoken?: string;
};
