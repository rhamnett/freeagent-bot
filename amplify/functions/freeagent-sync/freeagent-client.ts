/**
 * @file amplify/functions/freeagent-sync/freeagent-client.ts
 * @description FreeAgent API client for fetching transactions and bills
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
  UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';

interface FreeAgentTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

interface FreeAgentBankTransaction {
  url: string;
  bank_account: string;
  dated_on: string;
  description: string;
  amount: string;
  unexplained_amount: string;
  created_at: string;
  updated_at: string;
}

interface FreeAgentBill {
  url: string;
  contact: string;
  reference: string;
  dated_on: string;
  due_on: string;
  total_value: string;
  paid_value: string;
  due_value: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface FreeAgentContact {
  url: string;
  organisation_name?: string;
  first_name?: string;
  last_name?: string;
}

interface BankTransactionsResponse {
  bank_transactions: FreeAgentBankTransaction[];
}

interface BillsResponse {
  bills: FreeAgentBill[];
}

interface ContactResponse {
  contact: FreeAgentContact;
}

const FREEAGENT_API_BASE = 'https://api.freeagent.com/v2';
const FREEAGENT_SANDBOX_API_BASE = 'https://api.sandbox.freeagent.com/v2';
const FREEAGENT_TOKEN_URL = 'https://api.freeagent.com/v2/token_endpoint';

export class FreeAgentClient {
  private secretsClient: SecretsManagerClient;
  private secretArn: string;
  private tokens: FreeAgentTokens | null = null;
  private clientId: string;
  private clientSecret: string;
  private useSandbox: boolean;
  private contactCache: Map<string, string> = new Map();

  constructor(secretArn: string, clientId: string, clientSecret: string, useSandbox = false) {
    this.secretsClient = new SecretsManagerClient({});
    this.secretArn = secretArn;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.useSandbox = useSandbox;
  }

  private get apiBase(): string {
    return this.useSandbox ? FREEAGENT_SANDBOX_API_BASE : FREEAGENT_API_BASE;
  }

  /**
   * Load tokens from Secrets Manager
   */
  private async loadTokens(): Promise<FreeAgentTokens> {
    if (this.tokens) {
      return this.tokens;
    }

    const command = new GetSecretValueCommand({
      SecretId: this.secretArn,
    });

    const response = await this.secretsClient.send(command);
    if (!response.SecretString) {
      throw new Error('No secret string found');
    }

    this.tokens = JSON.parse(response.SecretString) as FreeAgentTokens;
    return this.tokens;
  }

  /**
   * Refresh access token if expired
   */
  private async refreshTokenIfNeeded(): Promise<string> {
    let tokens = await this.loadTokens();
    const expiresAt = new Date(tokens.expiresAt);
    const now = new Date();

    console.log(
      `Token check: expires=${tokens.expiresAt}, now=${now.toISOString()}, useSandbox=${this.useSandbox}`
    );

    // Refresh if token expires in less than 5 minutes
    if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
      console.log('Token expired or expiring soon, refreshing...');
      // FreeAgent uses HTTP Basic Auth for token refresh
      const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      const response = await fetch(FREEAGENT_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          refresh_token: tokens.refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`Token refresh failed: ${response.status} - ${error}`);
        throw new Error(`FreeAgent token refresh failed: ${error}`);
      }
      console.log('Token refresh successful');

      const data = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      // Update tokens
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      tokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? tokens.refreshToken,
        expiresAt: newExpiresAt,
      };
      this.tokens = tokens;

      // Save updated tokens to Secrets Manager
      await this.secretsClient.send(
        new UpdateSecretCommand({
          SecretId: this.secretArn,
          SecretString: JSON.stringify(tokens),
        })
      );
    }

    return tokens.accessToken;
  }

  /**
   * Make authenticated request to FreeAgent API
   */
  private async freeagentRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const accessToken = await this.refreshTokenIfNeeded();
    const url = `${this.apiBase}${endpoint}`;

    console.log(`FreeAgent API request: ${url}`);

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`FreeAgent API error: ${response.status} - ${error}`);
      throw new Error(`FreeAgent API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get contact name from contact URL
   */
  async getContactName(contactUrl: string): Promise<string> {
    // Check cache first
    const cached = this.contactCache.get(contactUrl);
    if (cached !== undefined) {
      return cached;
    }

    try {
      // Extract contact ID from URL
      const contactId = contactUrl.split('/').pop();
      const response = await this.freeagentRequest<ContactResponse>(`/contacts/${contactId}`);

      const contact = response.contact;
      const name =
        contact.organisation_name ??
        `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim() ??
        'Unknown';

      this.contactCache.set(contactUrl, name);
      return name;
    } catch (error) {
      console.error(`Failed to fetch contact ${contactUrl}:`, error);
      return 'Unknown';
    }
  }

  /**
   * Get all bank accounts
   */
  async getBankAccounts(): Promise<{ url: string; name: string }[]> {
    interface BankAccountsResponse {
      bank_accounts: Array<{
        url: string;
        name: string;
        type: string;
        currency: string;
      }>;
    }

    const response = await this.freeagentRequest<BankAccountsResponse>('/bank_accounts');
    console.log(`Found ${response.bank_accounts.length} bank accounts`);
    return response.bank_accounts.map((acc) => ({ url: acc.url, name: acc.name }));
  }

  /**
   * Get bank transactions with optional view filter
   * @param view - 'all' | 'unexplained' | 'explained' | 'marked_for_review' | 'manual' | 'imported'
   */
  async getBankTransactions(
    fromDate?: Date,
    view: 'all' | 'unexplained' | 'explained' | 'marked_for_review' | 'manual' | 'imported' = 'all'
  ): Promise<FreeAgentBankTransaction[]> {
    // First get all bank accounts
    const bankAccounts = await this.getBankAccounts();

    if (bankAccounts.length === 0) {
      console.log('No bank accounts found in FreeAgent');
      return [];
    }

    const allTransactions: FreeAgentBankTransaction[] = [];

    // Fetch transactions for each bank account
    for (const account of bankAccounts) {
      const params = new URLSearchParams();
      params.set('bank_account', account.url);
      params.set('view', view);

      if (fromDate) {
        params.set('from_date', fromDate.toISOString().split('T')[0]);
      }

      console.log(`Fetching ${view} transactions for bank account: ${account.name}`);

      try {
        const response = await this.freeagentRequest<BankTransactionsResponse>(
          `/bank_transactions?${params.toString()}`
        );

        console.log(
          `Found ${response.bank_transactions.length} ${view} transactions in ${account.name}`
        );
        allTransactions.push(...response.bank_transactions);
      } catch (error) {
        console.error(`Error fetching transactions for ${account.name}:`, error);
      }
    }

    return allTransactions;
  }

  /**
   * Get all bank transactions (including explained ones)
   */
  async getAllBankTransactions(fromDate?: Date): Promise<FreeAgentBankTransaction[]> {
    return this.getBankTransactions(fromDate, 'all');
  }

  /**
   * Get transactions marked for review (For Approval in FreeAgent UI)
   */
  async getForApprovalTransactions(fromDate?: Date): Promise<FreeAgentBankTransaction[]> {
    return this.getBankTransactions(fromDate, 'marked_for_review');
  }

  /**
   * Get unexplained bank transactions
   */
  async getUnexplainedBankTransactions(fromDate?: Date): Promise<FreeAgentBankTransaction[]> {
    const allTransactions = await this.getAllBankTransactions(fromDate);

    // Filter for transactions with unexplained amounts
    return allTransactions.filter((tx) => {
      const unexplainedAmount = Number.parseFloat(tx.unexplained_amount);
      return Math.abs(unexplainedAmount) > 0.01; // Use small threshold to avoid floating point issues
    });
  }

  /**
   * Get open/unpaid bills
   */
  async getOpenBills(): Promise<FreeAgentBill[]> {
    const response = await this.freeagentRequest<BillsResponse>('/bills?view=open');
    return response.bills;
  }

  /**
   * Get overdue bills
   */
  async getOverdueBills(): Promise<FreeAgentBill[]> {
    const response = await this.freeagentRequest<BillsResponse>('/bills?view=overdue');
    return response.bills;
  }

  /**
   * Create a bank transaction explanation (for auto-approval)
   */
  async createBankTransactionExplanation(
    bankTransactionUrl: string,
    category: string,
    description?: string
  ): Promise<void> {
    await this.freeagentRequest('/bank_transaction_explanations', {
      method: 'POST',
      body: JSON.stringify({
        bank_transaction_explanation: {
          bank_transaction: bankTransactionUrl,
          category,
          description,
        },
      }),
    });
  }

  /**
   * Mark a bill as paid via bank transaction
   */
  async payBill(billUrl: string, bankTransactionUrl: string): Promise<void> {
    await this.freeagentRequest('/bank_transaction_explanations', {
      method: 'POST',
      body: JSON.stringify({
        bank_transaction_explanation: {
          bank_transaction: bankTransactionUrl,
          paid_bill: billUrl,
        },
      }),
    });
  }
}

export type { FreeAgentBankTransaction, FreeAgentBill };
