const EM_DASH_TEMPLATE_SUFFIX = "\u2014 Template";

export function titleEndsWithEmDashTemplate(title: string): boolean {
  return title.endsWith(EM_DASH_TEMPLATE_SUFFIX);
}

/** Whole-word Test/Template prefix followed by ":" only (not substring matches). */
export function isTestOrTemplateTitlePrefix(title: string): boolean {
  return /^(Test|Template)\b:/.test(title);
}

export function isTemplateLikeTitle(title: string): boolean {
  return titleEndsWithEmDashTemplate(title) || isTestOrTemplateTitlePrefix(title);
}
