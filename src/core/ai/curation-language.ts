/**
 * Output-language policy for curated text (facts, atoms, concepts, takes, synthesis prose).
 *
 * The curation prompts carry no output-language rule beyond "capture verbatim where possible",
 * so on non-English sources the model tends to write English claims, losing the source-language
 * framing of a bilingual brain.
 *
 * This appends a short directive to the phase prompt, driven by the
 * `dream.curation.output_language` config (DB plane, like `models.tier.*`):
 *   - unset / "source" (default): match the detected dominant language of the input; an English
 *     input adds nothing, so English prompts stay byte-identical.
 *   - "off" / "none":             no directive.
 *   - a language code ("ko","en","ja","zh",…): force that language.
 *
 * Prompts stay hardcoded; only the policy is config-driven.
 */

const LANG_NAMES: Record<string, string> = {
  ko: 'Korean',
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese',
};

/**
 * Cheap, dependency-free dominant-language detection by script. Hangul-heavy
 * text → 'ko', otherwise 'en'. Intentionally conservative (a small amount of
 * Korean in mostly-Latin text still reads as 'ko', matching how a bilingual
 * user writes: Korean prose with Latin brand/entity names).
 */
export function detectDominantLanguage(text: string): string {
  let hangul = 0;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f)) hangul++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  // Ratio-based so it works for short and long inputs alike (a small absolute
  // floor avoids classifying mostly-Latin text with a stray Hangul char as ko).
  return hangul >= 2 && hangul >= 0.15 * (hangul + latin) ? 'ko' : 'en';
}

type ConfigReader = { getConfig(key: string): Promise<string | null> } | null | undefined;

/** The default policy when the config key is unset or unreadable. */
export const DEFAULT_CURATION_LANGUAGE_POLICY = 'source';

/**
 * Read `dream.curation.output_language` once. Split out from the directive builder so a
 * phase that fans out over many items (synthesize's per-chunk subagents) reads config once
 * per cycle instead of once per item. Fail-open to the default — never throws.
 */
export async function resolveCurationLanguagePolicy(engine: ConfigReader): Promise<string> {
  try {
    const v = engine ? await engine.getConfig('dream.curation.output_language') : null;
    if (v && v.trim()) return v.trim().toLowerCase();
  } catch {
    /* config unavailable → default */
  }
  return DEFAULT_CURATION_LANGUAGE_POLICY;
}

/**
 * Build the directive from an already-resolved policy. Synchronous, so it can be called
 * from sync prompt builders. Returns '' when the policy disables the directive.
 */
export function curationLanguageDirectiveFor(policy: string, sampleText: string): string {
  const p = (policy || DEFAULT_CURATION_LANGUAGE_POLICY).trim().toLowerCase();
  if (p === 'off' || p === 'none') return '';
  const lang = p === 'source' ? detectDominantLanguage(sampleText) : p;
  // "source" on an English input is the prompts' own behavior: add nothing.
  if (p === 'source' && lang === 'en') return '';
  const name = LANG_NAMES[lang] ?? lang;
  return (
    `\n\nOUTPUT LANGUAGE (overrides any earlier instruction about language): write every free-text ` +
    `value you generate (claims, titles, bodies, lessons, summaries, page prose) in ${name}, matching ` +
    `the source. Keep proper nouns, brand names, numbers and quoted spans exactly as written. Keep ` +
    `identifiers, slugs, JSON keys, enum values and kebab-case labels as the instructions above ` +
    `specify. Do NOT translate the source into another language.`
  );
}

/**
 * Build the output-language directive to append to a curation phase's system
 * prompt. Returns '' when the policy is disabled or the engine is unavailable
 * (fail-open: never breaks a phase). `sampleText` is the phase input used for
 * "source" detection (e.g. the turn/page content).
 */
export async function curationLanguageDirective(
  engine: ConfigReader,
  sampleText: string,
): Promise<string> {
  return curationLanguageDirectiveFor(await resolveCurationLanguagePolicy(engine), sampleText);
}
