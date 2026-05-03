/**
 * redact-client-document: Pure-text redaction tool. Strips internal Notion
 * URLs and mentions from a body of text. Synchronous logic; exposed as a
 * worker for tooling parity.
 */
import { redactClientText } from "../shared/client-publish.js";
import type { RedactClientDocumentInput, RedactClientDocumentOutput } from "../shared/types.js";

export function executeRedactClientDocument(
  input: RedactClientDocumentInput
): RedactClientDocumentOutput {
  const placeholder = input.internal_mention_placeholder ?? "[redacted]";
  const result = redactClientText(input.text ?? "", placeholder);
  return result;
}
