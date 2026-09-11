import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import {
  readEnableBankingRuntimeSettings,
  validateApiUrl
} from '../services/enable-banking-settings.js';
import { createEnableBankingJwt } from './jwt.js';

export type EnableBankingFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface Aspsp {
  name: string;
  country: string;
  maximum_consent_validity?: unknown;
  [key: string]: unknown;
}

export interface GenericIdentification {
  identification?: string;
  scheme_name?: string;
  [key: string]: unknown;
}

export interface AccountIdentification {
  iban?: string;
  other?: GenericIdentification;
  [key: string]: unknown;
}

/**
 * AccountResource returned by POST /sessions and GET /accounts/{uid}/details.
 *
 * This is intentionally different from SessionAccount, which is returned by
 * GET /sessions/{session_id} in accounts_data.
 */
export interface AccountResource {
  account_id?: AccountIdentification;
  all_account_ids?: GenericIdentification[];
  account_servicer?: Record<string, unknown>;
  name?: string;
  details?: string;
  usage?: string;
  cash_account_type: string;
  product?: string;
  currency: string;
  psu_status?: string;
  credit_limit?: { currency?: string; amount?: string };
  legal_age?: boolean | null;
  postal_address?: Record<string, unknown>;
  uid?: string;
  identification_hash: string;
  identification_hashes: string[];
  [key: string]: unknown;
}

export interface SessionAccount {
  uid: string;
  identification_hash: string;
  identification_hashes: string[];
  [key: string]: unknown;
}

export interface StartAuthorizationRequest {
  access: {
    valid_until: string;
    balances?: boolean;
    transactions?: boolean;
  };
  aspsp: { name: string; country: string };
  state: string;
  redirect_url: string;
  psu_type?: 'personal' | 'business';
  language?: string;
  auth_method?: string;
  credentials?: Record<string, string>;
  credentials_autosubmit?: boolean;
  psu_id?: string;
}

export interface StartAuthorizationResponse {
  url: string;
  authorization_id: string;
  psu_id_hash?: string;
}

export interface AuthorizeSessionResponse {
  session_id: string;
  access?: { valid_until?: string };
  accounts: AccountResource[];
  aspsp?: Aspsp;
  psu_type?: 'personal' | 'business';
  [key: string]: unknown;
}

export interface GetSessionResponse {
  access?: { valid_until?: string };
  accounts: string[];
  accounts_data: SessionAccount[];
  aspsp?: Aspsp;
  status?: string;
  authorized?: string;
  created?: string;
  psu_type?: 'personal' | 'business';
  [key: string]: unknown;
}

export type SessionResponse = GetSessionResponse;
export type AccountDetailsResponse = AccountResource;

export interface BalancesResponse {
  balances: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface TransactionsResponse {
  transactions: Array<Record<string, unknown>>;
  continuation_key?: string | null;
  [key: string]: unknown;
}

export interface TransactionQuery {
  dateFrom?: string;
  dateTo?: string;
  continuationKey?: string;
  transactionStatus?: string;
  strategy?: string;
}

export class EnableBankingApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Enable Banking request failed with HTTP ${status}.`);
    this.name = 'EnableBankingApiError';
    this.status = status;
  }
}

export class EnableBankingClient {
  private readonly database?: DatabaseSync;
  private readonly apiUrlOverride?: string;
  private readonly applicationIdOverride?: string;
  private readonly apiKeyOverride?: string;
  private readonly privateKeyPathOverride?: string;
  private readonly privateKeyOverride?: string | Buffer;
  private readonly fetcher: EnableBankingFetch;

  constructor(options: {
    database?: DatabaseSync;
    apiUrl?: string;
    applicationId?: string;
    apiKey?: string;
    privateKeyPath?: string;
    privateKey?: string | Buffer;
    fetcher?: EnableBankingFetch;
  } = {}) {
    this.database = options.database;
    this.apiUrlOverride = options.apiUrl;
    this.applicationIdOverride = options.applicationId;
    this.apiKeyOverride = options.apiKey;
    this.privateKeyPathOverride = options.privateKeyPath
      ? path.resolve(options.privateKeyPath)
      : undefined;
    this.privateKeyOverride = options.privateKey;
    validateApiUrl(options.apiUrl ?? config.enableBanking.apiUrl);
    this.fetcher = options.fetcher ?? fetch;
  }

  async getAspsps(filters: {
    country?: string;
    psuType?: 'personal' | 'business';
    service?: 'AIS' | 'PIS';
    paymentType?: string;
    name?: string;
  } = {}): Promise<{ aspsps: Aspsp[] }> {
    const query = new URLSearchParams();
    if (filters.country) query.set('country', filters.country);
    if (filters.psuType) query.set('psu_type', filters.psuType);
    if (filters.service) query.set('service', filters.service);
    if (filters.paymentType) query.set('payment_type', filters.paymentType);
    const result = await this.request<{ aspsps: Aspsp[] }>(
      `/aspsps${query.size ? `?${query}` : ''}`
    );
    if (!filters.name?.trim()) return result;

    const name = normalizeLookupValue(filters.name);
    return {
      aspsps: result.aspsps.filter((aspsp) =>
        normalizeLookupValue(aspsp.name).includes(name)
      )
    };
  }

  startAuthorization(body: StartAuthorizationRequest): Promise<StartAuthorizationResponse> {
    return this.request('/auth', { method: 'POST', body: JSON.stringify(body) });
  }

  authorizeSession(code: string): Promise<AuthorizeSessionResponse> {
    if (!code.trim()) throw new Error('Enable Banking authorization code is required.');
    return this.request('/sessions', { method: 'POST', body: JSON.stringify({ code }) });
  }

  getSession(sessionId: string): Promise<SessionResponse> {
    return this.request(`/sessions/${encodePathId(sessionId)}`);
  }

  deleteSession(sessionId: string): Promise<{ message?: string }> {
    return this.request(`/sessions/${encodePathId(sessionId)}`, { method: 'DELETE' });
  }

  getAccountDetails(accountId: string): Promise<AccountDetailsResponse> {
    return this.request(`/accounts/${encodePathId(accountId)}/details`);
  }

  getAccountBalances(accountId: string): Promise<BalancesResponse> {
    return this.request(`/accounts/${encodePathId(accountId)}/balances`);
  }

  getAccountTransactions(
    accountId: string,
    query: TransactionQuery = {}
  ): Promise<TransactionsResponse> {
    const params = new URLSearchParams();
    if (query.dateFrom) params.set('date_from', query.dateFrom);
    if (query.dateTo) params.set('date_to', query.dateTo);
    if (query.continuationKey) params.set('continuation_key', query.continuationKey);
    if (query.transactionStatus) params.set('transaction_status', query.transactionStatus);
    if (query.strategy) params.set('strategy', query.strategy);
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request(`/accounts/${encodePathId(accountId)}/transactions${suffix}`);
  }

  getTransactionDetails(accountId: string, transactionId: string): Promise<Record<string, unknown>> {
    return this.request(
      `/accounts/${encodePathId(accountId)}/transactions/${encodePathId(transactionId)}`
    );
  }

  async getAllAccountTransactions(
    accountId: string,
    query: Omit<TransactionQuery, 'continuationKey'> = {}
  ): Promise<{ transactions: Array<Record<string, unknown>>; pages: number }> {
    const transactions: Array<Record<string, unknown>> = [];
    let continuationKey: string | undefined;
    let pages = 0;
    const seenContinuationKeys = new Set<string>();

    do {
      if (pages >= 1_000) {
        throw new Error('Enable Banking transaction pagination exceeded the safety limit.');
      }

      const page = await this.getAccountTransactions(accountId, {
        ...query,
        continuationKey
      });
      transactions.push(...page.transactions);
      pages += 1;
      continuationKey = page.continuation_key ?? undefined;

      if (continuationKey) {
        if (seenContinuationKeys.has(continuationKey)) {
          throw new Error('Enable Banking returned a repeated continuation key.');
        }
        seenContinuationKeys.add(continuationKey);
      }
    } while (continuationKey);

    return { transactions, pages };
  }

  private readPrivateKey(settings: ReturnType<typeof readEnableBankingRuntimeSettings>): string | Buffer {
    if (this.privateKeyOverride) return this.privateKeyOverride;
    if (settings.privateKey) return settings.privateKey;
    try {
      return fs.readFileSync(this.privateKeyPathOverride ?? settings.privateKeyPath);
    } catch {
      throw new Error('Enable Banking private key could not be read.');
    }
  }

  private async request<T>(pathWithQuery: string, options: RequestInit = {}): Promise<T> {
    const settings = readEnableBankingRuntimeSettings(this.database);
    const apiUrl = this.apiUrlOverride ?? settings.apiUrl;
    validateApiUrl(apiUrl);
    const token = createEnableBankingJwt({
      applicationId: this.applicationIdOverride ?? settings.applicationId,
      privateKey: this.readPrivateKey(settings)
    });
    const url = new URL(pathWithQuery.replace(/^\//, ''), `${apiUrl.replace(/\/+$/, '')}/`);
    const headers = new Headers(options.headers);
    headers.set('accept', 'application/json');
    headers.set('authorization', `Bearer ${token}`);
    const apiKey = this.apiKeyOverride ?? settings.apiKey;
    if (apiKey) headers.set('x-api-key', apiKey);
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    const response = await this.fetcher(url, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(15_000)
    });
    const responseText = await response.text();
    let body: unknown = {};
    if (responseText) {
      try {
        body = JSON.parse(responseText);
      } catch {
        throw new Error('Enable Banking returned invalid JSON.');
      }
    }

    if (!response.ok) throw new EnableBankingApiError(response.status);
    return body as T;
  }
}

function encodePathId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error('Enable Banking resource ID is invalid.');
  }
  return encodeURIComponent(value);
}

function normalizeLookupValue(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
