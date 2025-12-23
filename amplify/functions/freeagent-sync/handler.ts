/**
 * @file amplify/functions/freeagent-sync/handler.ts
 * @description Lambda handler for syncing FreeAgent transactions and bills
 * Uses Amplify Data client to trigger real-time subscriptions
 */

import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import type { Handler } from 'aws-lambda';
import { env } from '$amplify/env/freeagent-sync';
import type { Schema } from '../../data/resource';
import { FreeAgentClient } from './freeagent-client';

// Configure Amplify for Lambda environment - MUST configure before generating client
const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
console.log('Amplify configured');

export const dataClient = generateClient<Schema>();
console.log('Generated Amplify Data client');

interface SyncEvent {
  userId?: string;
  arguments?: {
    userId: string;
  };
}

interface SyncResult {
  success: boolean;
  processed?: number;
  bankTransactions?: number;
  bills?: number;
  error?: string;
}

interface OAuthConnection {
  userId: string;
  provider: string;
  secretArn: string;
  expiresAt: string;
  email?: string;
}

// DynamoDB client for OAuth reads only (doesn't need subscriptions)
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

const OAUTH_TABLE = process.env.OAUTH_TABLE ?? '';
const FREEAGENT_CLIENT_ID = process.env.FREEAGENT_CLIENT_ID ?? '';
const FREEAGENT_CLIENT_SECRET = process.env.FREEAGENT_CLIENT_SECRET ?? '';
const USE_SANDBOX = process.env.FREEAGENT_USE_SANDBOX === 'true';
const MATCHER_FUNCTION_NAME = process.env.MATCHER_FUNCTION_NAME ?? '';

export const handler: Handler<SyncEvent, SyncResult> = async (event) => {
  // Support both direct invocation and GraphQL mutation format
  const userId = event.arguments?.userId ?? event.userId;

  if (!userId) {
    return { success: false, error: 'userId is required' };
  }

  console.log(`Starting FreeAgent sync for user: ${userId}`);

  try {
    // Get OAuth connection for FreeAgent (id format: "{userId}#FREEAGENT")
    // Using DynamoDB directly for OAuth - doesn't need subscriptions
    const oauthResponse = await ddbClient.send(
      new GetCommand({
        TableName: OAUTH_TABLE,
        Key: { id: `${userId}#FREEAGENT` },
      })
    );

    const oauth = oauthResponse.Item as OAuthConnection | undefined;
    if (!oauth) {
      console.log('No FreeAgent OAuth connection found for user');
      return { success: false, processed: 0, error: 'No FreeAgent connection' };
    }

    // Initialize FreeAgent client
    const freeagentClient = new FreeAgentClient(
      oauth.secretArn,
      FREEAGENT_CLIENT_ID,
      FREEAGENT_CLIENT_SECRET,
      USE_SANDBOX
    );

    // Always sync last 30 days
    const lastSyncDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    let syncedCount = 0;
    const now = new Date().toISOString();

    // Only fetch transactions that need attention:
    // 1. "For Approval" (marked_for_review) - FreeAgent guessed but needs user approval
    // 2. Unexplained - no explanation yet
    console.log('Fetching "For Approval" transactions...');
    const forApprovalTransactions = await freeagentClient.getForApprovalTransactions(lastSyncDate);
    console.log(`Found ${forApprovalTransactions.length} "For Approval" transactions`);

    console.log('Fetching unexplained transactions...');
    const unexplainedTransactions =
      await freeagentClient.getUnexplainedBankTransactions(lastSyncDate);
    console.log(`Found ${unexplainedTransactions.length} unexplained transactions`);

    // Combine and dedupe by URL
    const allTransactionsMap = new Map<string, (typeof forApprovalTransactions)[0]>();

    for (const tx of forApprovalTransactions) {
      allTransactionsMap.set(tx.url, tx);
    }
    for (const tx of unexplainedTransactions) {
      if (!allTransactionsMap.has(tx.url)) {
        allTransactionsMap.set(tx.url, tx);
      }
    }

    const bankTransactions = Array.from(allTransactionsMap.values());
    console.log(`Total unique transactions to sync: ${bankTransactions.length}`);

    for (const tx of bankTransactions) {
      try {
        // Check if transaction exists
        // Note: Don't use limit with filter - DynamoDB applies limit BEFORE filter on scans
        const { data: existingList } = await dataClient.models.Transaction.list({
          filter: {
            freeagentUrl: { eq: tx.url },
          },
        });

        // All these transactions need matching (either For Approval or unexplained)
        const needsMatching = true;

        const transactionData = {
          userId,
          freeagentUrl: tx.url,
          type: 'BANK_TRANSACTION' as const,
          amount: Math.abs(Number.parseFloat(tx.amount)),
          date: tx.dated_on,
          description: tx.description,
          unexplainedAmount: Math.abs(Number.parseFloat(tx.unexplained_amount)),
          needsMatching,
          lastSyncedAt: now,
        };

        if (existingList && existingList.length > 0) {
          // Update existing transaction via Amplify (triggers subscriptions)
          const existing = existingList[0];
          const { data: updated, errors: updateErrors } =
            await dataClient.models.Transaction.update({
              id: existing.id,
              ...transactionData,
            });
          if (updateErrors) {
            console.error('Update errors:', JSON.stringify(updateErrors, null, 2));
          }
          console.log(`Updated transaction: ${updated?.id}`);
        } else {
          // Create new transaction via Amplify (triggers subscriptions)
          const { data: created, errors: createErrors } =
            await dataClient.models.Transaction.create(transactionData);
          if (createErrors) {
            console.error('Create errors:', JSON.stringify(createErrors, null, 2));
          }
          console.log(`Created transaction: ${created?.id}`);
        }

        syncedCount++;
      } catch (error) {
        console.error(`Error syncing transaction ${tx.url}:`, error);
      }
    }

    // Sync open bills
    console.log('Fetching open bills...');
    const openBills = await freeagentClient.getOpenBills();

    console.log(`Found ${openBills.length} open bills`);

    for (const bill of openBills) {
      try {
        // Get contact name for the bill
        const contactName = await freeagentClient.getContactName(bill.contact);

        // Check if bill exists
        // Note: Don't use limit with filter - DynamoDB applies limit BEFORE filter on scans
        const { data: existingList } = await dataClient.models.Transaction.list({
          filter: {
            freeagentUrl: { eq: bill.url },
          },
        });

        const transactionData = {
          userId,
          freeagentUrl: bill.url,
          type: 'BILL' as const,
          amount: Math.abs(Number.parseFloat(bill.due_value || bill.total_value)),
          date: bill.dated_on,
          description: bill.reference,
          contactName,
          status: bill.status,
          lastSyncedAt: now,
        };

        if (existingList && existingList.length > 0) {
          // Update existing bill via Amplify (triggers subscriptions)
          const existing = existingList[0];
          const { data: updated, errors: updateErrors } =
            await dataClient.models.Transaction.update({
              id: existing.id,
              ...transactionData,
            });
          if (updateErrors) {
            console.error('Bill update errors:', JSON.stringify(updateErrors, null, 2));
          }
          console.log(`Updated bill: ${updated?.id}`);
        } else {
          // Create new bill via Amplify (triggers subscriptions)
          const { data: created, errors: createErrors } =
            await dataClient.models.Transaction.create(transactionData);
          if (createErrors) {
            console.error('Bill create errors:', JSON.stringify(createErrors, null, 2));
          }
          console.log(`Created bill: ${created?.id}`);
        }

        syncedCount++;
      } catch (error) {
        console.error(`Error syncing bill ${bill.url}:`, error);
      }
    }

    // Update last sync time via Amplify Data client
    try {
      // Try to get existing settings
      const { data: existingSettings } = await dataClient.models.UserSettings.get({ userId });

      if (existingSettings) {
        await dataClient.models.UserSettings.update({
          userId,
          lastFreeAgentSyncAt: now,
        });
      } else {
        await dataClient.models.UserSettings.create({
          userId,
          lastFreeAgentSyncAt: now,
        });
      }
    } catch (error) {
      console.error('Error updating user settings:', error);
    }

    // Re-match unmatched invoices from last 7 days against newly synced transactions
    // This handles the case where invoice email arrived before the bank transaction
    // Include both:
    // - EXTRACTED: OCR complete but matcher never ran or no transactions existed
    // - PENDING: Matcher ran but found no match
    let rematchedCount = 0;
    if (MATCHER_FUNCTION_NAME) {
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // Query unmatched invoices from last 7 days (EXTRACTED or PENDING)
        const { data: unmatchedInvoices } = await dataClient.models.Invoice.list({
          filter: {
            and: [
              { or: [{ status: { eq: 'PENDING' } }, { status: { eq: 'EXTRACTED' } }] },
              { createdAt: { ge: sevenDaysAgo } },
            ],
          },
        });

        console.log(
          `Found ${unmatchedInvoices?.length ?? 0} unmatched invoices from last 7 days to re-match`
        );

        for (const invoice of unmatchedInvoices ?? []) {
          try {
            // Invoke matcher Lambda asynchronously (don't wait for result)
            await lambdaClient.send(
              new InvokeCommand({
                FunctionName: MATCHER_FUNCTION_NAME,
                InvocationType: 'Event', // Async invocation
                Payload: JSON.stringify({
                  invoiceId: invoice.id,
                  userId,
                }),
              })
            );
            rematchedCount++;
            console.log(`Triggered re-match for invoice: ${invoice.id}`);
          } catch (matchError) {
            console.error(`Failed to trigger re-match for invoice ${invoice.id}:`, matchError);
          }
        }
      } catch (error) {
        console.error('Error re-matching pending invoices:', error);
      }
    }

    console.log(
      `FreeAgent sync complete. Synced ${syncedCount} items, triggered ${rematchedCount} re-matches.`
    );

    return {
      success: true,
      processed: syncedCount,
      bankTransactions: bankTransactions.length,
      bills: openBills.length,
    };
  } catch (error) {
    console.error('FreeAgent sync failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};
