/**
 * @file amplify/functions/matcher/handler.ts
 * @description Lambda handler for matching invoices to FreeAgent transactions
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Handler } from 'aws-lambda';
import { findBestMatch, type Invoice, type MatchingConfig, type Transaction } from './scoring';

interface MatchEvent {
  invoiceId: string;
  userId: string;
}

interface InvoiceRecord {
  id: string;
  userId: string;
  vendorName?: string;
  invoiceDate?: string;
  totalAmount?: number;
  currency?: string;
  status: string;
}

interface TransactionRecord {
  id: string;
  userId: string;
  freeagentUrl: string;
  type: 'BANK_TRANSACTION' | 'BILL';
  amount: number;
  date: string;
  description?: string;
  unexplainedAmount?: number;
  contactName?: string;
  status?: string;
}

interface MatchRecord {
  id: string;
  userId: string;
  invoiceId: string;
  transactionId: string;
  confidenceScore: number;
  matchReasons: string[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'AUTO_APPROVED';
  createdAt: string;
  updatedAt: string;
  owner: string;
}

interface UserSettings {
  userId: string;
  autoApproveThreshold?: number;
  reviewThreshold?: number;
}

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INVOICE_TABLE = process.env.INVOICE_TABLE ?? '';
const TRANSACTION_TABLE = process.env.TRANSACTION_TABLE ?? '';
const MATCH_TABLE = process.env.MATCH_TABLE ?? '';
const SETTINGS_TABLE = process.env.SETTINGS_TABLE ?? '';

const AUTO_APPROVE_THRESHOLD = parseFloat(process.env.AUTO_APPROVE_THRESHOLD ?? '0.85');
const REVIEW_THRESHOLD = parseFloat(process.env.REVIEW_THRESHOLD ?? '0.50');

export const handler: Handler<MatchEvent> = async (event) => {
  const { invoiceId, userId } = event;

  console.log(`Starting matching for invoice: ${invoiceId}`);

  try {
    // Get invoice record
    const invoiceResponse = await ddbClient.send(
      new GetCommand({
        TableName: INVOICE_TABLE,
        Key: { id: invoiceId },
      })
    );

    const invoice = invoiceResponse.Item as InvoiceRecord | undefined;
    if (!invoice) {
      throw new Error(`Invoice not found: ${invoiceId}`);
    }

    if (invoice.status !== 'EXTRACTED') {
      console.log(`Invoice ${invoiceId} not ready for matching, status: ${invoice.status}`);
      return { skipped: true, status: invoice.status };
    }

    // Get user settings for thresholds
    const settingsResponse = await ddbClient.send(
      new GetCommand({
        TableName: SETTINGS_TABLE,
        Key: { userId },
      })
    );

    const settings = settingsResponse.Item as UserSettings | undefined;
    const config: MatchingConfig = {
      autoApproveThreshold: settings?.autoApproveThreshold ?? AUTO_APPROVE_THRESHOLD,
      reviewThreshold: settings?.reviewThreshold ?? REVIEW_THRESHOLD,
      amountWeight: 40,
      dateWeight: 30,
      vendorWeight: 30,
    };

    // Get all transactions for this user
    const transactionsResponse = await ddbClient.send(
      new QueryCommand({
        TableName: TRANSACTION_TABLE,
        IndexName: 'byUserIdAndType',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId,
        },
      })
    );

    const transactions = (transactionsResponse.Items ?? []) as TransactionRecord[];

    if (transactions.length === 0) {
      console.log('No transactions available for matching');
      return { matched: false, reason: 'No transactions available' };
    }

    console.log(`Comparing against ${transactions.length} transactions`);

    // Convert to scoring format
    const invoiceForScoring: Invoice = {
      id: invoice.id,
      vendorName: invoice.vendorName,
      invoiceDate: invoice.invoiceDate,
      totalAmount: invoice.totalAmount,
      currency: invoice.currency,
    };

    const transactionsForScoring: Transaction[] = transactions.map((tx) => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      date: tx.date,
      description: tx.description,
      unexplainedAmount: tx.unexplainedAmount,
      contactName: tx.contactName,
    }));

    // Find best match
    const { transaction: bestMatch, score } = await findBestMatch(
      invoiceForScoring,
      transactionsForScoring,
      config
    );

    console.log(`Best match score: ${score.total}, reasons: ${score.reasons.join(', ')}`);

    const now = new Date().toISOString();

    // Determine action based on score
    if (!bestMatch || score.total < config.reviewThreshold) {
      // No match found
      console.log('No suitable match found');

      await ddbClient.send(
        new UpdateCommand({
          TableName: INVOICE_TABLE,
          Key: { id: invoiceId },
          UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':status': 'PENDING', // Keep as pending for manual review
            ':updatedAt': now,
          },
        })
      );

      return {
        matched: false,
        reason: 'No match above threshold',
        bestScore: score.total,
      };
    }

    // Determine match status
    let matchStatus: 'PENDING' | 'AUTO_APPROVED';
    let invoiceStatus: string;

    if (score.total >= config.autoApproveThreshold) {
      matchStatus = 'AUTO_APPROVED';
      invoiceStatus = 'APPROVED';
      console.log(`Auto-approving match with score ${score.total}`);
    } else {
      matchStatus = 'PENDING';
      invoiceStatus = 'MATCHED';
      console.log(`Queuing match for review with score ${score.total}`);
    }

    // Create match record
    const matchId = `${invoiceId}-${bestMatch.id}`;
    const matchRecord: MatchRecord = {
      id: matchId,
      userId,
      invoiceId,
      transactionId: bestMatch.id,
      confidenceScore: score.total,
      matchReasons: score.reasons,
      status: matchStatus,
      createdAt: now,
      updatedAt: now,
      owner: userId,
    };

    await ddbClient.send(
      new PutCommand({
        TableName: MATCH_TABLE,
        Item: matchRecord,
      })
    );

    // Update invoice status
    await ddbClient.send(
      new UpdateCommand({
        TableName: INVOICE_TABLE,
        Key: { id: invoiceId },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': invoiceStatus,
          ':updatedAt': now,
        },
      })
    );

    console.log(
      `Match created: ${matchId}, status: ${matchStatus}, invoice status: ${invoiceStatus}`
    );

    return {
      matched: true,
      matchId,
      transactionId: bestMatch.id,
      score: score.total,
      reasons: score.reasons,
      status: matchStatus,
    };
  } catch (error) {
    console.error(`Matching failed for invoice ${invoiceId}:`, error);
    throw error;
  }
};
