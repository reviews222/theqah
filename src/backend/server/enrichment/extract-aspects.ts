// src/backend/server/enrichment/extract-aspects.ts
import { z } from 'zod';
import OpenAI from 'openai';

export const ASPECT_SENTIMENT = ['positive', 'neutral', 'negative'] as const;

const ExtractionSchema = z.object({
  aspects: z.array(z.object({
    name: z.string().min(1).max(60),
    sentiment: z.enum(ASPECT_SENTIMENT),
    quote: z.string().max(280).optional(),
  })).max(8),
  topics: z.array(z.string().min(1).max(40)).max(8),
  sentiment: z.enum(ASPECT_SENTIMENT),
});

export type ReviewEnrichment = z.infer<typeof ExtractionSchema>;

/** Pure: builds the Arabic extraction prompt. No network. */
export function buildExtractionPrompt(text: string, stars: number): string {
  return [
    'استخرج من نص التقييم التالي البيانات المنظمة بصيغة JSON فقط.',
    'المطلوب:',
    '- aspects: مصفوفة كائنات {name: الجانب/المشكلة, sentiment: positive|neutral|negative, quote: اقتباس قصير اختياري من النص}.',
    '- topics: كلمات مفتاحية قصيرة (٢-٨).',
    '- sentiment: المشاعر العامة positive|neutral|negative.',
    'لا تخترع معلومات غير موجودة في النص. أعد JSON صالحًا فقط دون أي شرح.',
    `التقييم بالنجوم: ${stars}`,
    `النص: ${text}`,
  ].join('\n');
}

/** Pure: validates+normalizes raw model output. Returns null on any problem. */
export function parseExtractionResponse(raw: string): ReviewEnrichment | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ExtractionSchema.safeParse(json);
  return result.success ? result.data : null;
}

export interface ExtractionInput {
  text: string;
  stars: number;
}

/**
 * Calls OpenAI in JSON mode and returns validated enrichment, or null on
 * empty input / network failure / invalid output. Never throws — callers
 * run inside fire-and-forget jobs that must not crash on enrichment failure.
 */
export async function extractAspects(input: ExtractionInput): Promise<ReviewEnrichment | null> {
  const text = (input.text || '').trim();
  if (!text || !process.env.OPENAI_API_KEY) return null;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 12000);

    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'أنت محلل يستخرج بيانات منظمة من تقييمات العملاء ويعيد JSON فقط.' },
        { role: 'user', content: buildExtractionPrompt(text, input.stars) },
      ],
    }, { signal: controller.signal });

    const content = completion.choices[0]?.message?.content || '';
    return parseExtractionResponse(content);
  } catch (e) {
    console.error('[extractAspects] failed:', e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
