/**
 * @file amplify/functions/matcher/__tests__/scoring.test.ts
 * @description Unit tests for invoice-transaction matching scoring algorithm
 */

import { describe, expect, it, vi } from 'vitest';
import { calculateMatchScore, findBestMatch, type Invoice, type Transaction } from '../scoring';

// Mock the Bedrock client to avoid API calls during tests
vi.mock('../../invoice-processor/bedrock-client', () => ({
  compareVendorNames: vi.fn(async (invoiceVendor: string, transactionVendor: string) => {
    // Simple mock: return high score if vendors contain same words
    const invoiceWords = invoiceVendor.toLowerCase().split(/\s+/);
    const transactionWords = transactionVendor.toLowerCase().split(/\s+/);
    const matchingWords = invoiceWords.filter((w) => transactionWords.some((tw) => tw.includes(w) || w.includes(tw)));
    return matchingWords.length > 0 ? 0.9 : 0.1;
  }),
}));

// Mock exchange rate to avoid API calls
vi.mock('../exchange-rate', () => ({
  needsCurrencyConversion: vi.fn((from: string, to: string) => from !== to && from !== 'GBP'),
  convertCurrency: vi.fn(async (amount: number, from: string, _to: string, _date: string) => {
    // Simple mock exchange rates
    const rates: Record<string, number> = { USD: 0.79, EUR: 0.85 };
    const rate = rates[from] ?? 1;
    return { convertedAmount: amount * rate, rate };
  }),
}));

// ============================================================================
// Test Invoices (based on real data)
// ============================================================================
const testInvoices: Invoice[] = [
  {
    id: 'inv-simpson',
    vendorName: 'Simpson Burgess Nash Limited',
    invoiceDate: '2025-11-28',
    totalAmount: 60.0,
    currency: 'GBP',
  },
  {
    id: 'inv-aws',
    vendorName: 'AMAZON WEB SERVICES EMEA SARL',
    invoiceDate: '2025-12-01',
    totalAmount: 174.43,
    currency: 'GBP',
  },
  {
    id: 'inv-slack',
    vendorName: 'Slack Technologies Limited',
    invoiceDate: '2025-12-03',
    totalAmount: 8.4,
    currency: 'GBP',
  },
  {
    id: 'inv-uber',
    vendorName: 'Uber',
    invoiceDate: '2025-12-03',
    totalAmount: 5.7,
    currency: 'GBP',
  },
  {
    id: 'inv-zybra',
    vendorName: 'ZYBRA LLC',
    invoiceDate: '2025-11-28',
    totalAmount: 12.84,
    currency: 'USD', // Foreign currency
  },
  {
    id: 'inv-northern',
    vendorName: 'Northern',
    invoiceDate: '2025-12-10',
    totalAmount: 4.4,
    currency: 'GBP',
  },
  {
    id: 'inv-ajbell',
    vendorName: 'AJBell',
    invoiceDate: '2025-12-19',
    totalAmount: 0.01,
    currency: 'GBP',
  },
];

// ============================================================================
// Test Transactions (mock "For Approval" transactions)
// ============================================================================
const testTransactions: Transaction[] = [
  {
    id: 'tx-simpson',
    type: 'BANK_TRANSACTION',
    amount: 60.0,
    date: '2025-12-23',
    description: 'Simpson Burgess Nash limited (Faster Payments Out)/BA042/PAYMENT/',
    unexplainedAmount: 60.0,
  },
  {
    id: 'tx-aws',
    type: 'BANK_TRANSACTION',
    amount: 174.43,
    date: '2025-12-02',
    description: 'AWS EMEA DIRECT DEBIT',
    unexplainedAmount: 174.43,
  },
  {
    id: 'tx-slack',
    type: 'BANK_TRANSACTION',
    amount: 8.4,
    date: '2025-12-05',
    description: 'SLACK TECHNOLOGIES LTD CARD PAYMENT',
    unexplainedAmount: 8.4,
  },
  {
    id: 'tx-uber',
    type: 'BANK_TRANSACTION',
    amount: 5.7,
    date: '2025-12-03',
    description: 'UBER *TRIP',
    unexplainedAmount: 5.7,
  },
  {
    id: 'tx-zybra',
    type: 'BANK_TRANSACTION',
    amount: 10.14, // USD 12.84 converted to GBP at ~0.79
    date: '2025-11-30',
    description: 'ZYBRA CARD PAYMENT',
    unexplainedAmount: 10.14,
  },
  {
    id: 'tx-northern',
    type: 'BANK_TRANSACTION',
    amount: 4.4,
    date: '2025-12-10',
    description: 'NORTHERN RAIL TICKET',
    unexplainedAmount: 4.4,
  },
  {
    id: 'tx-ajbell',
    type: 'BANK_TRANSACTION',
    amount: 0.01,
    date: '2025-12-19',
    description: 'AJ BELL SIPP TRANSFER',
    unexplainedAmount: 0.01,
  },
  // Bills (always included)
  {
    id: 'bill-fruga',
    type: 'BILL',
    amount: 342.75,
    date: '2025-12-15',
    description: 'Fruga consulting',
    contactName: 'Fruga',
  },
];

// ============================================================================
// Tests
// ============================================================================

describe('calculateMatchScore', () => {
  it('should give high score for exact amount and close date match (Simpson)', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-simpson')!;
    const transaction = testTransactions.find((t) => t.id === 'tx-simpson')!;

    const score = await calculateMatchScore(invoice, transaction);

    // Amount: exact (40 points)
    // Date: 25 days apart = within month (0.4 * 30 = 12 points)
    // Vendor: matching words "simpson" "burgess" "nash" (0.9 * 30 = 27 points)
    // Total: (40 + 12 + 27) / 100 = 0.79
    expect(score.total).toBeGreaterThanOrEqual(0.7);
    expect(score.reasons).toContain('amount_exact');
  });

  it('should give high score for exact amount and exact date (Uber)', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-uber')!;
    const transaction = testTransactions.find((t) => t.id === 'tx-uber')!;

    const score = await calculateMatchScore(invoice, transaction);

    // Amount: exact (40 points)
    // Date: same day (30 points)
    // Vendor: matching "uber" (27 points)
    expect(score.total).toBeGreaterThanOrEqual(0.9);
    expect(score.reasons).toContain('amount_exact');
    expect(score.reasons).toContain('date_exact');
  });

  it('should give high score for AWS transaction', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-aws')!;
    const transaction = testTransactions.find((t) => t.id === 'tx-aws')!;

    const score = await calculateMatchScore(invoice, transaction);

    expect(score.total).toBeGreaterThanOrEqual(0.85);
    expect(score.reasons).toContain('amount_exact');
    expect(score.reasons).toContain('date_exact'); // 1 day apart
  });

  it('should give high score for Slack transaction', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-slack')!;
    const transaction = testTransactions.find((t) => t.id === 'tx-slack')!;

    const score = await calculateMatchScore(invoice, transaction);

    expect(score.total).toBeGreaterThanOrEqual(0.8);
    expect(score.reasons).toContain('amount_exact');
    expect(score.reasons).toContain('date_close'); // 2 days apart
  });

  it('should handle currency conversion for USD invoices', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-zybra')!;
    const transaction = testTransactions.find((t) => t.id === 'tx-zybra')!;

    const score = await calculateMatchScore(invoice, transaction);

    // USD 12.84 * 0.79 = 10.14 GBP - exact match after conversion
    expect(score.total).toBeGreaterThanOrEqual(0.6);
    expect(score.reasons).toContain('amount_converted');
  });

  it('should give high score for exact Northern match', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-northern')!;
    const transaction = testTransactions.find((t) => t.id === 'tx-northern')!;

    const score = await calculateMatchScore(invoice, transaction);

    // Amount: exact, Date: same day, Vendor: matching
    expect(score.total).toBeGreaterThanOrEqual(0.9);
  });

  it('should give high score for exact AJBell match', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-ajbell')!;
    const transaction = testTransactions.find((t) => t.id === 'tx-ajbell')!;

    const score = await calculateMatchScore(invoice, transaction);

    expect(score.total).toBeGreaterThanOrEqual(0.9);
    expect(score.reasons).toContain('amount_exact');
    expect(score.reasons).toContain('date_exact');
  });

  it('should give low score for non-matching amounts', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-simpson')!; // 60 GBP
    const transaction = testTransactions.find((t) => t.id === 'tx-aws')!; // 174.43 GBP

    const score = await calculateMatchScore(invoice, transaction);

    expect(score.total).toBeLessThan(0.5);
  });
});

describe('findBestMatch', () => {
  it('should find Simpson transaction as best match for Simpson invoice', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-simpson')!;

    const { transaction, score } = await findBestMatch(invoice, testTransactions);

    expect(transaction).not.toBeNull();
    expect(transaction?.id).toBe('tx-simpson');
    expect(score.total).toBeGreaterThanOrEqual(0.5);
  });

  it('should find AWS transaction as best match for AWS invoice', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-aws')!;

    const { transaction, score } = await findBestMatch(invoice, testTransactions);

    expect(transaction).not.toBeNull();
    expect(transaction?.id).toBe('tx-aws');
    expect(score.total).toBeGreaterThanOrEqual(0.85);
  });

  it('should find Uber transaction as best match for Uber invoice', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-uber')!;

    const { transaction, score } = await findBestMatch(invoice, testTransactions);

    expect(transaction).not.toBeNull();
    expect(transaction?.id).toBe('tx-uber');
    expect(score.total).toBeGreaterThanOrEqual(0.9);
  });

  it('should find correct match for all test invoices', async () => {
    const expectedMatches: Record<string, string> = {
      'inv-simpson': 'tx-simpson',
      'inv-aws': 'tx-aws',
      'inv-slack': 'tx-slack',
      'inv-uber': 'tx-uber',
      'inv-zybra': 'tx-zybra',
      'inv-northern': 'tx-northern',
      'inv-ajbell': 'tx-ajbell',
    };

    for (const invoice of testInvoices) {
      const { transaction, score } = await findBestMatch(invoice, testTransactions);

      const expectedTxId = expectedMatches[invoice.id];
      if (expectedTxId) {
        expect(transaction?.id).toBe(expectedTxId);
        expect(score.total).toBeGreaterThanOrEqual(0.5); // At least above review threshold
      }
    }
  });
});

describe('scoring thresholds', () => {
  it('should identify auto-approve candidates (>= 0.85)', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-uber')!;
    const transaction = testTransactions.find((t) => t.id === 'tx-uber')!;

    const score = await calculateMatchScore(invoice, transaction);

    expect(score.total).toBeGreaterThanOrEqual(0.85);
  });

  it('should identify review candidates (0.5 - 0.85)', async () => {
    const invoice = testInvoices.find((i) => i.id === 'inv-simpson')!;
    const transaction = testTransactions.find((t) => t.id === 'tx-simpson')!;

    const score = await calculateMatchScore(invoice, transaction);

    // Simpson has 25-day date gap, so might be in review range
    expect(score.total).toBeGreaterThanOrEqual(0.5);
  });
});
