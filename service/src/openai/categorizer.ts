import { config } from '../config.js';

export interface CategorizationCategory {
  id: number;
  name: string;
  type: 'expense' | 'income' | 'transfer';
}

export interface CategorizationTransaction {
  transaction_id: number;
  counterparty_id: string | null;
  counterparty_name: string | null;
  merchant_name: string | null;
  purpose: string | null;
  amount_cents: number;
  currency: string;
  direction: 'incoming' | 'outgoing';
  mcc: string | null;
}

export interface CategorizationResult {
  transaction_id: number;
  category_id: number | null;
  confidence: number;
  reason: string;
  suggested_category: {
    name: string;
    type: 'expense' | 'income' | 'transfer';
  } | null;
}

export interface CategorizationClient {
  categorize(input: {
    categories: CategorizationCategory[];
    transactions: CategorizationTransaction[];
  }): Promise<CategorizationResult[]>;
}

export class CategorizationUnavailableError extends Error {}

/**
 * The only OpenAI boundary. Its input is constructed from explicit, normalized
 * fields; it never receives an IBAN, an Enable Banking identifier, a raw bank
 * payload, credentials, or a browser session token.
 */
export class OpenAiCategorizer implements CategorizationClient {
  async categorize(input: {
    categories: CategorizationCategory[];
    transactions: CategorizationTransaction[];
  }): Promise<CategorizationResult[]> {
    const apiKey = config.secrets.openAiApiKey;
    const model = config.openAiModel;
    if (!apiKey || !model) {
      throw new CategorizationUnavailableError('OpenAI categorization is not configured.');
    }
    if (input.transactions.length === 0) return [];

    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          store: false,
          instructions: [
            'Classify each banking transaction using only the supplied category allowlist.',
            'Return one result for every supplied transaction_id.',
            'Use category_id only when it is in the allowlist; otherwise use null.',
            'Do not infer, request, or output banking identifiers, IBANs, account numbers, or personal data.',
            'Keep reason short and factual.'
          ].join(' '),
          input: JSON.stringify({
            categories: input.categories,
            transactions: input.transactions
          }),
          text: {
            format: {
              type: 'json_schema',
              name: 'banking_category_batch',
              strict: true,
              schema: responseSchema()
            }
          }
        })
      });
    } catch {
      throw new CategorizationUnavailableError('OpenAI categorization is unavailable.');
    }
    if (!response.ok) {
      throw new CategorizationUnavailableError('OpenAI categorization is unavailable.');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CategorizationUnavailableError('OpenAI categorization returned an invalid response.');
    }
    const text = responseText(payload);
    if (!text) {
      throw new CategorizationUnavailableError('OpenAI categorization returned no result.');
    }
    return parseCategorizationResults(text);
  }
}

/** Removes common personally identifying free-text patterns before the API call. */
export function redactCategorizationText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const redacted = value
    .normalize('NFKC')
    .replace(/[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]){11,30}/gi, '[iban]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+?\d[\d\s()./-]{6,}\d)/g, '[number]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted ? redacted.slice(0, 180) : null;
}

function responseSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'transaction_id',
            'category_id',
            'confidence',
            'reason',
            'suggested_category'
          ],
          properties: {
            transaction_id: { type: 'integer' },
            category_id: { type: ['integer', 'null'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string', maxLength: 280 },
            suggested_category: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'type'],
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 80 },
                    type: { enum: ['expense', 'income', 'transfer'] }
                  }
                }
              ]
            }
          }
        }
      }
    }
  };
}

function responseText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === 'string') return record.output_text;
  if (!Array.isArray(record.output)) return null;
  for (const item of record.output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      const text = (entry as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    }
  }
  return null;
}

function parseCategorizationResults(text: string): CategorizationResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CategorizationUnavailableError('OpenAI categorization returned invalid JSON.');
  }
  const results = parsed && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>).results
    : null;
  if (!Array.isArray(results)) {
    throw new CategorizationUnavailableError('OpenAI categorization returned an invalid schema.');
  }
  const normalized: CategorizationResult[] = [];
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const value = result as Record<string, unknown>;
    const transactionId = Number(value.transaction_id);
    const categoryId = value.category_id === null ? null : Number(value.category_id);
    const confidence = Number(value.confidence);
    const reason = typeof value.reason === 'string'
      ? value.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 280)
      : '';
    const suggestion = value.suggested_category;
    const suggestedCategory = suggestion && typeof suggestion === 'object'
      ? normalizeSuggestedCategory(suggestion as Record<string, unknown>)
      : null;
    if (
      !Number.isSafeInteger(transactionId) || transactionId < 1
      || (categoryId !== null && (!Number.isSafeInteger(categoryId) || categoryId < 1))
      || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
      || !reason
    ) continue;
    normalized.push({
      transaction_id: transactionId,
      category_id: categoryId,
      confidence,
      reason,
      suggested_category: suggestedCategory
    });
  }
  return normalized;
}

function normalizeSuggestedCategory(value: Record<string, unknown>): CategorizationResult['suggested_category'] {
  const name = typeof value.name === 'string'
    ? value.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80)
    : '';
  const type = value.type;
  return name && (type === 'expense' || type === 'income' || type === 'transfer')
    ? { name, type }
    : null;
}
