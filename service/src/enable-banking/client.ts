import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createEnableBankingJwt } from './jwt.js';

export type EnableBankingFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface Aspsp {
  name: string;
  country: string;
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
  accounts?: string[];
  aspsp?: Aspsp;
  [key: string]: unknown;
}

export interface SessionResponse {
  access?: { valid_until?: string };
  accounts?: string[];
  aspsp?: Aspsp;
  status?: string;
  [key: string]: unknown;
}

export interface AccountDetailsResponse {
  uid?: string;
  account_id?: string;
  iban?: string;
  name?: string;
  currency?: string;
  [key: string]: unknown;
}

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
  private readonly baseUrl: string;
  private readonly applicationId: string;
  private readonly privateKeyPath: string;
  private readonly fetcher: EnableBankingFetch;
  private readonly privateKey?: string | Buffer;

  constructor(options: {
    apiUrl?: string;
    applicationId?: string;
    privateKeyPath?: string;
    privateKey?: string | Buffer;
    fetcher?: EnableBankingFetch;
  } = {}) {
    const apiUrl = options.apiUrl ?? config.enableBanking.apiUrl;
    const parsedUrl = new URL(apiUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new Error('ENABLE_BANKING_API_URL must be an HTTP(S) URL without credentials.');
    }

    this.baseUrl = apiUrl.replace(/\/+$/, '');
    this.applicationId = options.applicationId ?? config.enableBanking.applicationId;
    this.privateKeyPath = path.resolve(
      options.privateKeyPath ?? config.enableBanking.privateKeyPath
    );
    this.privateKey = options.privateKey;
    this.fetcher = options.fetcher ?? fetch;
  }

  async getAspsps(filters: { country?: string; name?: string } = {}): Promise<{ aspsps: Aspsp[] }> {
    const query = new URLSearchParams();
    if (filters.country) query.set('country', filters.country);
    if (filters.name) query.set('name', filters.name);
    return this.request(`/aspsps${query.size ? `?${query}` : ''}`);
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

  private readPrivateKey(): string | Buffer {
    if (this.privateKey) return this.privateKey;
    try {
      return fs.readFileSync(this.privateKeyPath);
    } catch {
      throw new Error('Enable Banking private key could not be read.');
    }
  }

  private async request<T>(pathWithQuery: string, options: RequestInit = {}): Promise<T> {
    const token = createEnableBankingJwt({
      applicationId: this.applicationId,
      privateKey: this.readPrivateKey()
    });
    const url = new URL(pathWithQuery.replace(/^\//, ''), `${this.baseUrl}/`);
    const headers = new Headers(options.headers);
    headers.set('accept', 'application/json');
    headers.set('authorization', `Bearer ${token}`);
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
