/**
 * @file amplify/functions/freeagent-sync/handler.ts
 * @description Lambda handler for syncing FreeAgent transactions and bills
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
import {
  type FreeAgentBankTransaction,
  type FreeAgentBill,
  FreeAgentClient,
} from './freeagent-client';

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

interface UserSettings {
  userId: string;
  lastFreeAgentSyncAt?: string;
}

interface Transaction {
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
  lastSyncedAt: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
}

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const OAUTH_TABLE = process.env.OAUTH_TABLE ?? '';
const TRANSACTION_TABLE = process.env.TRANSACTION_TABLE ?? '';
const SETTINGS_TABLE = process.env.SETTINGS_TABLE ?? '';
const FREEAGENT_CLIENT_ID = process.env.FREEAGENT_CLIENT_ID ?? '';
const FREEAGENT_CLIENT_SECRET = process.env.FREEAGENT_CLIENT_SECRET ?? '';
const USE_SANDBOX = process.env.FREEAGENT_USE_SANDBOX === 'true';
const FAKE_AWS_AS_UNEXPLAINED = process.env.FAKE_AWS_AS_UNEXPLAINED === 'true';

/**
 * Find AWS transactions and fake them as unexplained for testing
 * This takes real explained transactions and marks them as unexplained
 */
function fakeAwsAsUnexplained(
  transactions: FreeAgentBankTransaction[]
): FreeAgentBankTransaction[] {
  const faked: FreeAgentBankTransaction[] = [];

  for (const tx of transactions) {
    // Check if this is an AWS transaction (already explained, so unexplained_amount would be 0)
    const desc = tx.description?.toUpperCase() ?? '';
    if (
      desc.includes('AMAZON WEB SERVICES') ||
      desc.includes('AWS') ||
      desc.includes('AMAZON WEB SER')
    ) {
      console.log(`Found AWS transaction: ${tx.description} - faking as unexplained`);
      // Clone the transaction but set unexplained_amount to the full amount
      faked.push({
        ...tx,
        unexplained_amount: tx.amount, // Fake it as fully unexplained
      });
    }
  }

  return faked;
}

export const handler: Handler<SyncEvent, SyncResult> = async (event) => {
  // Support both direct invocation and GraphQL mutation format
  const userId = event.arguments?.userId ?? event.userId;

  if (!userId) {
    return { success: false, error: 'userId is required' };
  }

  console.log(`Starting FreeAgent sync for user: ${userId}`);

  try {
    // Get OAuth connection for FreeAgent (id format: "{userId}#FREEAGENT")
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

    // Get user settings for sync date range
    const settingsResponse = await ddbClient.send(
      new GetCommand({
        TableName: SETTINGS_TABLE,
        Key: { userId },
      })
    );

    const settings = settingsResponse.Item as UserSettings | undefined;
    const lastSyncDate = settings?.lastFreeAgentSyncAt
      ? new Date(settings.lastFreeAgentSyncAt)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // Default to 90 days ago

    let syncedCount = 0;
    const now = new Date().toISOString();

    // Sync unexplained bank transactions
    console.log('Fetching bank transactions...');
    let bankTransactions = await freeagentClient.getUnexplainedBankTransactions(lastSyncDate);

    // For testing: find AWS transactions and fake them as unexplained
    if (FAKE_AWS_AS_UNEXPLAINED) {
      console.log('Looking for AWS transactions to fake as unexplained...');
      const allTransactions = await freeagentClient.getAllBankTransactions(lastSyncDate);
      const fakedAws = fakeAwsAsUnexplained(allTransactions);
      if (fakedAws.length > 0) {
        console.log(`Found ${fakedAws.length} AWS transactions to fake as unexplained`);
        bankTransactions = [...bankTransactions, ...fakedAws];
      }
    }

    console.log(`Found ${bankTransactions.length} unexplained transactions`);

    for (const tx of bankTransactions) {
      try {
        const transaction = await mapBankTransaction(tx, userId, now);

        // Check if transaction exists
        const existing = await ddbClient.send(
          new QueryCommand({
            TableName: TRANSACTION_TABLE,
            IndexName: 'byFreeagentUrl',
            KeyConditionExpression: 'freeagentUrl = :url',
            ExpressionAttributeValues: {
              ':url': tx.url,
            },
            Limit: 1,
          })
        );

        if (existing.Items && existing.Items.length > 0) {
          // Update existing transaction
          await ddbClient.send(
            new UpdateCommand({
              TableName: TRANSACTION_TABLE,
              Key: { id: existing.Items[0].id },
              UpdateExpression: `
                SET amount = :amount,
                    #date = :date,
                    description = :description,
                    unexplainedAmount = :unexplained,
                    lastSyncedAt = :syncedAt,
                    updatedAt = :updatedAt
              `,
              ExpressionAttributeNames: {
                '#date': 'date',
              },
              ExpressionAttributeValues: {
                ':amount': transaction.amount,
                ':date': transaction.date,
                ':description': transaction.description,
                ':unexplained': transaction.unexplainedAmount,
                ':syncedAt': now,
                ':updatedAt': now,
              },
            })
          );
        } else {
          // Insert new transaction
          await ddbClient.send(
            new PutCommand({
              TableName: TRANSACTION_TABLE,
              Item: transaction,
            })
          );
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

        const transaction = mapBill(bill, userId, contactName, now);

        // Check if bill exists
        const existing = await ddbClient.send(
          new QueryCommand({
            TableName: TRANSACTION_TABLE,
            IndexName: 'byFreeagentUrl',
            KeyConditionExpression: 'freeagentUrl = :url',
            ExpressionAttributeValues: {
              ':url': bill.url,
            },
            Limit: 1,
          })
        );

        if (existing.Items && existing.Items.length > 0) {
          // Update existing bill
          await ddbClient.send(
            new UpdateCommand({
              TableName: TRANSACTION_TABLE,
              Key: { id: existing.Items[0].id },
              UpdateExpression: `
                SET amount = :amount,
                    #date = :date,
                    description = :description,
                    contactName = :contactName,
                    #status = :status,
                    lastSyncedAt = :syncedAt,
                    updatedAt = :updatedAt
              `,
              ExpressionAttributeNames: {
                '#date': 'date',
                '#status': 'status',
              },
              ExpressionAttributeValues: {
                ':amount': transaction.amount,
                ':date': transaction.date,
                ':description': transaction.description,
                ':contactName': transaction.contactName,
                ':status': transaction.status,
                ':syncedAt': now,
                ':updatedAt': now,
              },
            })
          );
        } else {
          // Insert new bill
          await ddbClient.send(
            new PutCommand({
              TableName: TRANSACTION_TABLE,
              Item: transaction,
            })
          );
        }

        syncedCount++;
      } catch (error) {
        console.error(`Error syncing bill ${bill.url}:`, error);
      }
    }

    // Update last sync time
    await ddbClient.send(
      new UpdateCommand({
        TableName: SETTINGS_TABLE,
        Key: { userId },
        UpdateExpression: 'SET lastFreeAgentSyncAt = :now',
        ExpressionAttributeValues: {
          ':now': now,
        },
      })
    );

    console.log(`FreeAgent sync complete. Synced ${syncedCount} items.`);

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

/**
 * Map FreeAgent bank transaction to our Transaction model
 */
async function mapBankTransaction(
  tx: FreeAgentBankTransaction,
  userId: string,
  now: string
): Promise<Transaction> {
  const id = `${userId}-bank-${tx.url.split('/').pop()}`;

  return {
    id,
    userId,
    freeagentUrl: tx.url,
    type: 'BANK_TRANSACTION',
    amount: Math.abs(parseFloat(tx.amount)),
    date: tx.dated_on,
    description: tx.description,
    unexplainedAmount: Math.abs(parseFloat(tx.unexplained_amount)),
    lastSyncedAt: now,
    owner: userId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Map FreeAgent bill to our Transaction model
 */
function mapBill(
  bill: FreeAgentBill,
  userId: string,
  contactName: string,
  now: string
): Transaction {
  const id = `${userId}-bill-${bill.url.split('/').pop()}`;

  return {
    id,
    userId,
    freeagentUrl: bill.url,
    type: 'BILL',
    amount: Math.abs(parseFloat(bill.due_value || bill.total_value)),
    date: bill.dated_on,
    description: bill.reference,
    contactName,
    status: bill.status,
    lastSyncedAt: now,
    owner: userId,
    createdAt: now,
    updatedAt: now,
  };
}
