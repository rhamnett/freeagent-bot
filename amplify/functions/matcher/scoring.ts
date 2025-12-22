/**
 * @file amplify/functions/matcher/scoring.ts
 * @description Confidence scoring algorithm for invoice-transaction matching
 */

import { compareVendorNames } from '../invoice-processor/bedrock-client';

interface Invoice {
  id: string;
  vendorName?: string;
  invoiceDate?: string;
  totalAmount?: number;
  currency?: string;
}

interface Transaction {
  id: string;
  type: 'BANK_TRANSACTION' | 'BILL';
  amount: number;
  date: string;
  description?: string;
  unexplainedAmount?: number;
  contactName?: string;
}

type MatchReason =
  | 'amount_exact'
  | 'amount_close'
  | 'date_exact'
  | 'date_close'
  | 'date_within_month'
  | 'vendor_match'
  | 'vendor_partial';

interface MatchScore {
  total: number; // 0-1
  reasons: MatchReason[];
}

interface MatchingConfig {
  autoApproveThreshold: number;
  reviewThreshold: number;
  amountWeight: number;
  dateWeight: number;
  vendorWeight: number;
}

const DEFAULT_CONFIG: MatchingConfig = {
  autoApproveThreshold: 0.85,
  reviewThreshold: 0.5,
  amountWeight: 40,
  dateWeight: 30,
  vendorWeight: 30,
};

/**
 * Calculate the number of days between two dates
 */
function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Calculate amount match score (0-1)
 */
function calculateAmountScore(
  invoiceAmount: number | undefined,
  transactionAmount: number
): { score: number; reason?: MatchReason } {
  if (invoiceAmount === undefined) {
    return { score: 0 };
  }

  const diff = Math.abs(invoiceAmount - transactionAmount);

  // Exact match (within 0.01)
  if (diff < 0.01) {
    return { score: 1, reason: 'amount_exact' };
  }

  // Very close (within 1% of transaction amount)
  const percentDiff = diff / transactionAmount;
  if (percentDiff < 0.01) {
    return { score: 0.85, reason: 'amount_close' };
  }

  // Close (within 5%)
  if (percentDiff < 0.05) {
    return { score: 0.5, reason: 'amount_close' };
  }

  // No match
  return { score: 0 };
}

/**
 * Calculate date proximity score (0-1)
 */
function calculateDateScore(
  invoiceDate: string | undefined,
  transactionDate: string
): { score: number; reason?: MatchReason } {
  if (!invoiceDate) {
    return { score: 0.3 }; // Slight penalty for missing date
  }

  const days = daysBetween(invoiceDate, transactionDate);

  // Same day or next day
  if (days <= 1) {
    return { score: 1, reason: 'date_exact' };
  }

  // Within a week
  if (days <= 7) {
    return { score: 0.8, reason: 'date_close' };
  }

  // Within two weeks
  if (days <= 14) {
    return { score: 0.6, reason: 'date_close' };
  }

  // Within a month
  if (days <= 30) {
    return { score: 0.4, reason: 'date_within_month' };
  }

  // Within 3 months (FreeAgent's search range)
  if (days <= 90) {
    return { score: 0.2, reason: 'date_within_month' };
  }

  // Too far apart
  return { score: 0 };
}

/**
 * Calculate vendor name similarity score (0-1)
 */
async function calculateVendorScore(
  invoiceVendor: string | undefined,
  transactionVendor: string | undefined
): Promise<{ score: number; reason?: MatchReason }> {
  // If either vendor is missing, return neutral score
  if (!invoiceVendor || !transactionVendor) {
    return { score: 0.3 };
  }

  // Quick exact match check (case-insensitive)
  const normalizedInvoice = invoiceVendor.toLowerCase().trim();
  const normalizedTransaction = transactionVendor.toLowerCase().trim();

  if (normalizedInvoice === normalizedTransaction) {
    return { score: 1, reason: 'vendor_match' };
  }

  // Check if one contains the other
  if (
    normalizedInvoice.includes(normalizedTransaction) ||
    normalizedTransaction.includes(normalizedInvoice)
  ) {
    return { score: 0.8, reason: 'vendor_partial' };
  }

  // Use Bedrock for fuzzy matching
  try {
    const similarity = await compareVendorNames(invoiceVendor, transactionVendor);

    if (similarity >= 0.8) {
      return { score: similarity, reason: 'vendor_match' };
    }
    if (similarity >= 0.5) {
      return { score: similarity, reason: 'vendor_partial' };
    }
    return { score: similarity };
  } catch (error) {
    console.error('Error comparing vendor names:', error);
    // Fall back to basic string comparison
    return { score: 0.3 };
  }
}

/**
 * Calculate overall match score for an invoice-transaction pair
 */
export async function calculateMatchScore(
  invoice: Invoice,
  transaction: Transaction,
  config: MatchingConfig = DEFAULT_CONFIG
): Promise<MatchScore> {
  const reasons: MatchReason[] = [];
  let totalScore = 0;

  // Amount score
  const amountScore = calculateAmountScore(
    invoice.totalAmount,
    transaction.type === 'BANK_TRANSACTION'
      ? (transaction.unexplainedAmount ?? transaction.amount)
      : transaction.amount
  );
  totalScore += amountScore.score * config.amountWeight;
  if (amountScore.reason) {
    reasons.push(amountScore.reason);
  }

  // Date score
  const dateScore = calculateDateScore(invoice.invoiceDate, transaction.date);
  totalScore += dateScore.score * config.dateWeight;
  if (dateScore.reason) {
    reasons.push(dateScore.reason);
  }

  // Vendor score
  const vendorScore = await calculateVendorScore(
    invoice.vendorName,
    transaction.contactName ?? transaction.description
  );
  totalScore += vendorScore.score * config.vendorWeight;
  if (vendorScore.reason) {
    reasons.push(vendorScore.reason);
  }

  // Normalize to 0-1
  const maxScore = config.amountWeight + config.dateWeight + config.vendorWeight;
  const normalizedScore = totalScore / maxScore;

  return {
    total: Math.round(normalizedScore * 100) / 100,
    reasons,
  };
}

/**
 * Find the best matching transaction for an invoice
 */
export async function findBestMatch(
  invoice: Invoice,
  transactions: Transaction[],
  config: MatchingConfig = DEFAULT_CONFIG
): Promise<{
  transaction: Transaction | null;
  score: MatchScore;
}> {
  let bestMatch: Transaction | null = null;
  let bestScore: MatchScore = { total: 0, reasons: [] };

  for (const transaction of transactions) {
    const score = await calculateMatchScore(invoice, transaction, config);

    if (score.total > bestScore.total) {
      bestScore = score;
      bestMatch = transaction;
    }
  }

  return {
    transaction: bestMatch,
    score: bestScore,
  };
}

export { DEFAULT_CONFIG };
export type { Invoice, Transaction, MatchScore, MatchReason, MatchingConfig };
