'use server';

import { generateServerClientUsingCookies } from '@aws-amplify/adapter-nextjs/data';
import { getCurrentUser } from 'aws-amplify/auth/server';
import { cookies } from 'next/headers';
import type { Schema } from '@/amplify/data/resource';
import outputs from '@/amplify_outputs.json';
import { runWithAmplifyServerContext } from '@/utils/amplifyServerUtils';

export interface DashboardStats {
  pendingReview: number;
  autoApproved: number;
  processedToday: number;
  gmailConnected: boolean;
  freeagentConnected: boolean;
  totalTransactions: number;
  totalBills: number;
}

export interface RecentActivity {
  id: string;
  type: 'invoice' | 'match' | 'approval';
  description: string;
  timestamp: string;
}

export interface DashboardData {
  stats: DashboardStats;
  recentActivity: RecentActivity[];
  userId: string | null;
}

export async function getCurrentUserId(): Promise<string | null> {
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async (contextSpec) => {
      try {
        const user = await getCurrentUser(contextSpec);
        return user.userId;
      } catch {
        return null;
      }
    },
  });
}

export async function fetchDashboardData(): Promise<DashboardData> {
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async (contextSpec) => {
      const client = generateServerClientUsingCookies<Schema>({
        config: outputs,
        cookies,
      });

      // Get current user
      let userId: string | null = null;
      try {
        const user = await getCurrentUser(contextSpec);
        userId = user.userId;
      } catch {
        return {
          stats: {
            pendingReview: 0,
            autoApproved: 0,
            processedToday: 0,
            gmailConnected: false,
            freeagentConnected: false,
            totalTransactions: 0,
            totalBills: 0,
          },
          recentActivity: [],
          userId: null,
        };
      }

      // Check OAuth connections
      const [gmailConnection, freeagentConnection] = await Promise.all([
        client.models.OAuthConnection.get({ id: `${userId}#GMAIL` }),
        client.models.OAuthConnection.get({ id: `${userId}#FREEAGENT` }),
      ]);

      // Get pending matches
      const pendingMatches = await client.models.Match.list({
        filter: {
          userId: { eq: userId },
          status: { eq: 'PENDING' },
        },
      });

      // Get auto-approved matches (last 7 days)
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const autoApprovedMatches = await client.models.Match.list({
        filter: {
          userId: { eq: userId },
          status: { eq: 'AUTO_APPROVED' },
          createdAt: { ge: weekAgo },
        },
      });

      // Get invoices processed today
      // Note: ownerDefinedIn('userId') auto-filters by authenticated user
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const processedToday = await client.models.Invoice.list({
        filter: {
          createdAt: { ge: todayStart.toISOString() },
        },
      });

      // Get total transaction counts - fetch all and count
      // Note: ownerDefinedIn('userId') auto-filters by authenticated user
      const allTransactions = await client.models.Transaction.list();

      const transactionData = allTransactions.data ?? [];
      const bankTransactionCount = transactionData.filter(
        (t) => t.type === 'BANK_TRANSACTION'
      ).length;
      const billCount = transactionData.filter((t) => t.type === 'BILL').length;

      // Build recent activity
      const activities: RecentActivity[] = [];

      // Add recent invoices
      // Note: ownerDefinedIn('userId') auto-filters by authenticated user
      const recentInvoices = await client.models.Invoice.list({
        limit: 5,
      });

      for (const invoice of recentInvoices.data ?? []) {
        activities.push({
          id: invoice.id,
          type: 'invoice',
          description: `Invoice from ${invoice.vendorName ?? 'Unknown'} - ${invoice.status}`,
          timestamp: invoice.createdAt ?? '',
        });
      }

      // Sort by timestamp and take top 5
      activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return {
        stats: {
          pendingReview: pendingMatches.data?.length ?? 0,
          autoApproved: autoApprovedMatches.data?.length ?? 0,
          processedToday: processedToday.data?.length ?? 0,
          gmailConnected: !!gmailConnection.data,
          freeagentConnected: !!freeagentConnection.data,
          totalTransactions: bankTransactionCount,
          totalBills: billCount,
        },
        recentActivity: activities.slice(0, 5),
        userId,
      };
    },
  });
}
