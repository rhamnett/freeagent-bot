'use server';

import { generateServerClientUsingCookies } from '@aws-amplify/adapter-nextjs/data';
import { cookies } from 'next/headers';
import type { Schema } from '@/amplify/data/resource';
import outputs from '@/amplify_outputs.json';
import { runWithAmplifyServerContext } from '@/utils/amplifyServerUtils';

interface SyncResult {
  success: boolean;
  processed?: number;
  invoiceIds?: string[];
  bankTransactions?: number;
  bills?: number;
  error?: string;
}

export async function triggerGmailSync(userId: string, forceFullScan = true): Promise<SyncResult> {
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async () => {
      const client = generateServerClientUsingCookies<Schema>({
        config: outputs,
        cookies,
      });

      const result = await client.mutations.triggerGmailSync({
        userId,
        forceFullScan,
      });

      if (result.errors) {
        console.error('triggerGmailSync errors:', result.errors);
        return {
          success: false,
          error: result.errors[0]?.message ?? 'Unknown error',
        };
      }

      return {
        success: result.data?.success ?? false,
        processed: result.data?.processed ?? undefined,
        invoiceIds: result.data?.invoiceIds ?? undefined,
        error: result.data?.error ?? undefined,
      };
    },
  });
}

export async function triggerFreeAgentSync(userId: string): Promise<SyncResult> {
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async () => {
      const client = generateServerClientUsingCookies<Schema>({
        config: outputs,
        cookies,
      });

      const result = await client.mutations.triggerFreeAgentSync({
        userId,
      });

      if (result.errors) {
        console.error('triggerFreeAgentSync errors:', result.errors);
        return {
          success: false,
          error: result.errors[0]?.message ?? 'Unknown error',
        };
      }

      return {
        success: result.data?.success ?? false,
        processed: result.data?.processed ?? undefined,
        bankTransactions: result.data?.bankTransactions ?? undefined,
        bills: result.data?.bills ?? undefined,
        error: result.data?.error ?? undefined,
      };
    },
  });
}

export async function triggerFullSync(userId: string): Promise<{
  gmail: SyncResult;
  freeagent: SyncResult;
}> {
  const [gmail, freeagent] = await Promise.all([
    triggerGmailSync(userId),
    triggerFreeAgentSync(userId),
  ]);

  return { gmail, freeagent };
}

interface ClearDataResult {
  success: boolean;
  deleted: {
    invoices: number;
    transactions: number;
    matches: number;
  };
  error?: string;
}

export async function clearAllData(userId: string): Promise<ClearDataResult> {
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async () => {
      const client = generateServerClientUsingCookies<Schema>({
        config: outputs,
        cookies,
      });

      let invoicesDeleted = 0;
      let transactionsDeleted = 0;
      let matchesDeleted = 0;

      try {
        // Delete all invoices for user (ownerDefinedIn auto-filters by userId)
        const invoices = await client.models.Invoice.list();
        for (const invoice of invoices.data ?? []) {
          await client.models.Invoice.delete({ id: invoice.id });
          invoicesDeleted++;
        }

        // Delete all transactions for user (ownerDefinedIn auto-filters by userId)
        const transactions = await client.models.Transaction.list();
        for (const transaction of transactions.data ?? []) {
          await client.models.Transaction.delete({ id: transaction.id });
          transactionsDeleted++;
        }

        // Delete all matches for user
        const matches = await client.models.Match.list({
          filter: { userId: { eq: userId } },
        });
        for (const match of matches.data ?? []) {
          await client.models.Match.delete({ id: match.id });
          matchesDeleted++;
        }

        // Reset poll timestamps by setting to a very old date
        try {
          const oldDate = '2000-01-01T00:00:00.000Z';

          // First try to get existing settings
          const existingSettings = await client.models.UserSettings.get({ userId });

          if (existingSettings.data) {
            // Update existing record
            await client.models.UserSettings.update({
              userId,
              lastGmailPollAt: oldDate,
              lastFreeAgentSyncAt: oldDate,
            });
            console.log('Updated existing settings - reset poll timestamps to:', oldDate);
          } else {
            // Create new record with reset timestamps
            await client.models.UserSettings.create({
              userId,
              lastGmailPollAt: oldDate,
              lastFreeAgentSyncAt: oldDate,
            });
            console.log('Created new settings with poll timestamps:', oldDate);
          }
        } catch (settingsError) {
          console.error('Settings reset error:', settingsError);
          // Try direct create as fallback
          try {
            const oldDate = '2000-01-01T00:00:00.000Z';
            await client.models.UserSettings.create({
              userId,
              lastGmailPollAt: oldDate,
              lastFreeAgentSyncAt: oldDate,
            });
            console.log('Fallback: Created settings with reset timestamps');
          } catch (createError) {
            console.error('Settings create fallback also failed:', createError);
          }
        }

        return {
          success: true,
          deleted: {
            invoices: invoicesDeleted,
            transactions: transactionsDeleted,
            matches: matchesDeleted,
          },
        };
      } catch (error) {
        console.error('clearAllData error:', error);
        return {
          success: false,
          deleted: {
            invoices: invoicesDeleted,
            transactions: transactionsDeleted,
            matches: matchesDeleted,
          },
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  });
}
