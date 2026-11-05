/**
 * Curation output-language policy (src/core/ai/curation-language.ts): curated text
 * (facts, atoms, concepts, takes, synthesis prose) keeps the source's language.
 *
 * Unit cases for the policy, then the wiring of the phases that can be driven without a
 * provider: extract_atoms (PGLite, stubbed chat), synthesize_concepts (stub engine, dry run)
 * and the synthesis prompt builder. No model is called anywhere.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  detectDominantLanguage,
  curationLanguageDirective,
  resolveCurationLanguagePolicy,
  curationLanguageDirectiveFor,
} from '../src/core/ai/curation-language.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { __testing as synthesizeTesting } from '../src/core/cycle/synthesize.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

const KO = '아크미 시리즈B 라운드에서 부분 엑싯을 목표로 한다. 홍길동 대표가 세후 30억을 언급했다.';
const EN = 'targeting a partial exit in the Series B round; the CEO mentioned thirty million after tax';

describe('detectDominantLanguage', () => {
  test('Hangul-dominant text → ko', () => {
    expect(detectDominantLanguage('아크미 시리즈B 라운드에서 부분 엑싯 목표')).toBe('ko');
  });
  test('Latin-dominant text → en', () => {
    expect(detectDominantLanguage(EN)).toBe('en');
  });
  test('mostly-Latin with a stray Hangul char → en (ratio guard)', () => {
    expect(detectDominantLanguage('mostly english text with one 디 char here and there')).toBe('en');
  });
  test('empty string → en', () => {
    expect(detectDominantLanguage('')).toBe('en');
  });
});

describe('curationLanguageDirective', () => {
  const cfg = (v: string | null) => ({ getConfig: async () => v });

  test('default "source" (unset config): a Korean input is told to stay Korean', async () => {
    const ko = await curationLanguageDirective(cfg(null), KO);
    expect(ko).toContain('in Korean');
    expect(ko).toContain('overrides any earlier instruction about language');
  });

  test('default "source" on an English input adds nothing (English prompts stay byte-identical)', async () => {
    expect(await curationLanguageDirective(cfg(null), EN)).toBe('');
  });

  test('null and undefined engines fall open to "source"', async () => {
    expect(await curationLanguageDirective(null, KO)).toContain('in Korean');
    expect(await curationLanguageDirective(undefined, KO)).toContain('in Korean');
  });

  test('"off" / "none" → empty', async () => {
    expect(await curationLanguageDirective(cfg('off'), KO)).toBe('');
    expect(await curationLanguageDirective(cfg('none'), KO)).toBe('');
  });

  test('an explicit language code forces that language regardless of input', async () => {
    expect(await curationLanguageDirective(cfg('ja'), 'anything at all')).toContain('in Japanese');
    expect(await curationLanguageDirective(cfg('ko'), EN)).toContain('in Korean');
    expect(await curationLanguageDirective(cfg('en'), KO)).toContain('in English');
  });

  test('a getConfig that throws falls open to "source" (never breaks a phase)', async () => {
    const throwing = { getConfig: async () => { throw new Error('db down'); } };
    expect(await curationLanguageDirective(throwing, KO)).toContain('in Korean');
  });

  test('the directive keeps identifiers and kebab-case labels as the prompt specifies', () => {
    const d = curationLanguageDirectiveFor('source', KO);
    expect(d).toContain('kebab-case labels');
    expect(d).toContain('JSON keys');
  });
});

describe('resolveCurationLanguagePolicy (read-once split)', () => {
  test('unset, null and undefined engines → "source"', async () => {
    expect(await resolveCurationLanguagePolicy({ getConfig: async () => null })).toBe('source');
    expect(await resolveCurationLanguagePolicy(null)).toBe('source');
    expect(await resolveCurationLanguagePolicy(undefined)).toBe('source');
  });
  test('normalizes case and whitespace', async () => {
    expect(await resolveCurationLanguagePolicy({ getConfig: async () => '  KO  ' })).toBe('ko');
  });
  test('a throwing getConfig falls open to "source"', async () => {
    const throwing = { getConfig: async () => { throw new Error('db down'); } };
    expect(await resolveCurationLanguagePolicy(throwing)).toBe('source');
  });
  test('reads config exactly once however many directives are built', async () => {
    let calls = 0;
    const engine = { getConfig: async () => { calls++; return 'ko'; } };
    const policy = await resolveCurationLanguagePolicy(engine);
    for (const chunk of ['a', 'b', 'c', 'd']) curationLanguageDirectiveFor(policy, chunk);
    expect(calls).toBe(1);
  });
});

describe('curationLanguageDirectiveFor (sync, for sync prompt builders)', () => {
  test('"source" detects per sample, so chunks differing in language differ', () => {
    expect(curationLanguageDirectiveFor('source', KO)).toContain('in Korean');
    expect(curationLanguageDirectiveFor('source', EN)).toBe('');
  });
  test('"off"/"none" → empty; a forced language ignores the sample; empty policy = "source"', () => {
    expect(curationLanguageDirectiveFor('off', KO)).toBe('');
    expect(curationLanguageDirectiveFor('none', KO)).toBe('');
    expect(curationLanguageDirectiveFor('ja', 'anything')).toContain('in Japanese');
    expect(curationLanguageDirectiveFor('', KO)).toContain('in Korean');
  });
  test('matches the async wrapper for the same policy', async () => {
    const viaAsync = await curationLanguageDirective({ getConfig: async () => null }, KO);
    expect(curationLanguageDirectiveFor('source', KO)).toBe(viaAsync);
  });
});

describe('config key', () => {
  test('dream.curation.output_language is a known config key', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('dream.curation.output_language');
  });
});

describe('synthesis prompt', () => {
  const transcript = { filePath: '/fake/t.txt', basename: 't', contentHash: 'abcdef123456', inferredDate: '2026-10-01' };
  const build = (chunk: string, policy?: string) =>
    synthesizeTesting.buildSynthesisPrompt(
      transcript as never, chunk, 0, 1, '', 'wiki', '', '', [], undefined, undefined, 'oneshot', '2026-10-01', false, false, policy);

  test('a Korean chunk carries the directive at the end; an English chunk is unchanged', () => {
    expect(build(KO).endsWith('Do NOT translate the source into another language.')).toBe(true);
    expect(build(EN)).toBe(build(EN, 'off'));
  });
  test('"off" removes it from a Korean chunk; a forced code adds it to an English one', () => {
    expect(build(KO, 'off')).not.toContain('OUTPUT LANGUAGE');
    expect(build(EN, 'ko')).toContain('in Korean');
  });
});

describe('synthesize_concepts system prompt', () => {
  const group = (body: string) => Array.from({ length: 10 }, (_, i) => ({
    slug: `atoms/2026-09-05/a${i}`, concept_refs: ['concept-0'], title: `atom ${i}`, body,
  }));
  async function systemFor(policy: string | null, body: string): Promise<string> {
    let system = '';
    const chat = (async (o: ChatOpts) => {
      system = String(o.system ?? '');
      return { model: 'test:model', text: 'a narrative.', usage: { input_tokens: 10, output_tokens: 10 } };
    }) as never;
    const engine = {
      getConfig: async (k: string) => (k === 'dream.curation.output_language' ? policy : null),
      readPageSnapshot: async () => null,
    } as never;
    await runPhaseSynthesizeConcepts(engine, { dryRun: true, _atoms: group(body), _chat: chat } as never);
    return system;
  }
  test('Korean atoms: the summary prompt tells the model to write Korean', async () => {
    expect(await systemFor(null, KO)).toContain('in Korean');
  });
  test('English atoms: the prompt is unchanged', async () => {
    expect(await systemFor(null, EN)).not.toContain('OUTPUT LANGUAGE');
  });
  test('"off": no directive on Korean atoms', async () => {
    expect(await systemFor('off', KO)).not.toContain('OUTPUT LANGUAGE');
  });
});

describe('extract_atoms system prompt (PGLite, stubbed chat)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
  });

  async function systemFor(content: string, policy: string | null): Promise<string> {
    if (policy) await engine.setConfig('dream.curation.output_language', policy);
    else await engine.setConfig('dream.curation.output_language', '');
    let system = '';
    const chat = async (o: ChatOpts): Promise<ChatResult> => {
      system = String(o.system ?? '');
      return {
        text: '{"atoms":[]}', blocks: [{ type: 'text', text: '' }], stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      };
    };
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: `/fake/${Math.random().toString(36).slice(2)}.txt`, content, contentHash: Math.random().toString(16).slice(2, 18).padEnd(16, '0') }],
      _pages: [],
      _chat: chat,
    });
    return system;
  }

  test('a Korean source keeps the extraction prompt and adds the Korean directive', async () => {
    const system = await systemFor(KO, null);
    expect(system).toContain('You extract atomic content nuggets');
    expect(system).toContain('in Korean');
  }, 60000);
  test('an English source leaves the prompt untouched', async () => {
    expect(await systemFor(EN, null)).not.toContain('OUTPUT LANGUAGE');
  }, 60000);
  test('"off" leaves a Korean source untouched', async () => {
    expect(await systemFor(KO, 'off')).not.toContain('OUTPUT LANGUAGE');
  }, 60000);
});
