/** Case-insensitive whole-word test/template prefix with colon, space, or hyphen. */
const TEMPLATE_TITLE_PREFIX = /^\s*(template|test)\b[:\s-]/i;

export function isTemplateLikeTitle(title: string): boolean {
  return TEMPLATE_TITLE_PREFIX.test(title);
}
