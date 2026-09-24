/**
 * Time Log row ownership guard for PR Estimate Writer.
 * HARD-CODED — no config override.
 */

export const PR_ESTIMATE_SOURCE = "PR estimate" as const;
export const TIME_LOG_SOURCE_MANUAL = "Manual" as const;
export const TIME_LOG_SOURCE_AUDITOR_SUPERSEDED = "Auditor EST (superseded)" as const;
export const BILLING_STATUS_UNBILLED = "Unbilled" as const;
export const BILLING_STATUS_INVOICED = "Invoiced" as const;
export const BILLING_STATUS_PAID = "Paid" as const;

export interface TimeLogRowOwnershipFields {
  source: string | null | undefined;
  billingStatus: string | null | undefined;
}

export type OwnershipGuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

const IMMUTABLE_BILLING = new Set<string>([BILLING_STATUS_INVOICED, BILLING_STATUS_PAID]);

export function assertWriterMayMutateTimeLogRow(
  row: TimeLogRowOwnershipFields
): OwnershipGuardResult {
  const source = (row.source ?? "").trim();
  const billing = (row.billingStatus ?? "").trim();

  if (IMMUTABLE_BILLING.has(billing)) {
    return {
      allowed: false,
      reason: `Billing Status is ${billing}; Invoiced/Paid rows are never modified`,
    };
  }

  if (source !== PR_ESTIMATE_SOURCE) {
    if (source === "") {
      return {
        allowed: false,
        reason: "Source is empty (unknown ownership); writer never touches this row",
      };
    }
    if (source === TIME_LOG_SOURCE_MANUAL) {
      return { allowed: false, reason: "Source is Manual; writer never touches manual rows" };
    }
    if (source === TIME_LOG_SOURCE_AUDITOR_SUPERSEDED) {
      return {
        allowed: false,
        reason: "Source is Auditor EST (superseded); writer never touches auditor stubs",
      };
    }
    return {
      allowed: false,
      reason: `Source is "${source}"; only PR estimate rows are writable`,
    };
  }

  return { allowed: true };
}

export function mayCreatePrEstimateRow(): OwnershipGuardResult {
  return { allowed: true };
}

export function assertWriterMayUpdatePrEstimateRow(
  row: TimeLogRowOwnershipFields
): OwnershipGuardResult {
  const base = assertWriterMayMutateTimeLogRow(row);
  if (!base.allowed) return base;

  const billing = (row.billingStatus ?? "").trim();
  if (billing === "") {
    return {
      allowed: false,
      reason: "Billing Status is empty (unknown); writer does not update unknown rows",
    };
  }
  if (billing !== BILLING_STATUS_UNBILLED) {
    return {
      allowed: false,
      reason: `Billing Status is ${billing}; writer only updates Unbilled PR estimate rows`,
    };
  }

  return { allowed: true };
}

export function isBillingStatusUnknown(billingStatus: string | null | undefined): boolean {
  return (billingStatus ?? "").trim() === "";
}
