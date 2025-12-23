'use client';

import type { Schema } from '@/amplify/data/resource';
import { fetchAuthSession } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';
import { useCallback, useEffect, useRef, useState } from 'react';

const client = generateClient<Schema>();

type Invoice = Schema['Invoice']['type'];
type Match = Schema['Match']['type'];
type Transaction = Schema['Transaction']['type'];

interface RealtimeDataState {
  invoices: Invoice[];
  matches: Match[];
  transactions: Transaction[];
  pendingMatches: Match[];
  loading: boolean;
  error: Error | null;
}

interface UseRealtimeDataOptions {
  enableInvoices?: boolean;
  enableMatches?: boolean;
  enableTransactions?: boolean;
  onInvoiceChange?: (invoice: Invoice, type: 'create' | 'update' | 'delete') => void;
  onMatchChange?: (match: Match, type: 'create' | 'update' | 'delete') => void;
  onTransactionChange?: (
    transaction: Transaction,
    type: 'create' | 'update' | 'delete'
  ) => void;
}

export function useRealtimeData(options: UseRealtimeDataOptions = {}) {
  const {
    enableInvoices = true,
    enableMatches = true,
    enableTransactions = true,
    onInvoiceChange,
    onMatchChange,
    onTransactionChange,
  } = options;

  const [state, setState] = useState<RealtimeDataState>({
    invoices: [],
    matches: [],
    transactions: [],
    pendingMatches: [],
    loading: true,
    error: null,
  });

  const [userId, setUserId] = useState<string | null>(null);
  const subscriptionsRef = useRef<Array<{ unsubscribe: () => void }>>([]);

  // Get user ID on mount
  useEffect(() => {
    async function getUserId() {
      try {
        const session = await fetchAuthSession();
        const id = session.tokens?.idToken?.payload.sub as string;
        setUserId(id);
      } catch (error) {
        console.error('Failed to get user ID:', error);
        setState((prev) => ({
          ...prev,
          error: error instanceof Error ? error : new Error('Failed to authenticate'),
          loading: false,
        }));
      }
    }
    getUserId();
  }, []);

  // Setup subscriptions when userId is available
  useEffect(() => {
    if (!userId) return;

    const subs: Array<{ unsubscribe: () => void }> = [];

    // Subscribe to Invoices
    // Note: No userId filter needed - ownerDefinedIn('userId') auto-filters by authenticated user
    if (enableInvoices) {
      const invoiceSub = client.models.Invoice.observeQuery().subscribe({
        next: ({ items, isSynced }) => {
          console.log('[Realtime] Invoices updated:', items.length, 'synced:', isSynced);
          setState((prev) => ({ ...prev, invoices: [...items] as Invoice[] }));
        },
        error: (error) => {
          console.error('[Realtime] Invoice subscription error:', error);
        },
      });
      subs.push(invoiceSub);

      // Individual mutation subscriptions for callbacks
      if (onInvoiceChange) {
        const createSub = client.models.Invoice.onCreate().subscribe({
          next: (invoice) => {
            console.log('[Realtime] Invoice created:', invoice.id);
            onInvoiceChange(invoice as Invoice, 'create');
          },
          error: (error) => console.error('[Realtime] Invoice onCreate error:', error),
        });
        subs.push(createSub);

        const updateSub = client.models.Invoice.onUpdate().subscribe({
          next: (invoice) => {
            console.log('[Realtime] Invoice updated:', invoice.id);
            onInvoiceChange(invoice as Invoice, 'update');
          },
          error: (error) => console.error('[Realtime] Invoice onUpdate error:', error),
        });
        subs.push(updateSub);

        const deleteSub = client.models.Invoice.onDelete().subscribe({
          next: (invoice) => {
            console.log('[Realtime] Invoice deleted:', invoice.id);
            onInvoiceChange(invoice as Invoice, 'delete');
          },
          error: (error) => console.error('[Realtime] Invoice onDelete error:', error),
        });
        subs.push(deleteSub);
      }
    }

    // Subscribe to Matches
    if (enableMatches) {
      const matchSub = client.models.Match.observeQuery({
        filter: { userId: { eq: userId } },
      }).subscribe({
        next: ({ items, isSynced }) => {
          console.log('[Realtime] Matches updated:', items.length, 'synced:', isSynced);
          const allMatches = [...items] as Match[];
          const pending = allMatches.filter((m) => m.status === 'PENDING');
          setState((prev) => ({
            ...prev,
            matches: allMatches,
            pendingMatches: pending,
          }));
        },
        error: (error) => {
          console.error('[Realtime] Match subscription error:', error);
        },
      });
      subs.push(matchSub);

      // Individual mutation subscriptions for callbacks
      if (onMatchChange) {
        const createSub = client.models.Match.onCreate({
          filter: { userId: { eq: userId } },
        }).subscribe({
          next: (match) => {
            console.log('[Realtime] Match created:', match.id);
            onMatchChange(match as Match, 'create');
          },
          error: (error) => console.error('[Realtime] Match onCreate error:', error),
        });
        subs.push(createSub);

        const updateSub = client.models.Match.onUpdate({
          filter: { userId: { eq: userId } },
        }).subscribe({
          next: (match) => {
            console.log('[Realtime] Match updated:', match.id);
            onMatchChange(match as Match, 'update');
          },
          error: (error) => console.error('[Realtime] Match onUpdate error:', error),
        });
        subs.push(updateSub);

        const deleteSub = client.models.Match.onDelete({
          filter: { userId: { eq: userId } },
        }).subscribe({
          next: (match) => {
            console.log('[Realtime] Match deleted:', match.id);
            onMatchChange(match as Match, 'delete');
          },
          error: (error) => console.error('[Realtime] Match onDelete error:', error),
        });
        subs.push(deleteSub);
      }
    }

    // Subscribe to Transactions
    // Note: No userId filter needed - ownerDefinedIn('userId') auto-filters by authenticated user
    if (enableTransactions) {
      const transactionSub = client.models.Transaction.observeQuery().subscribe({
        next: ({ items, isSynced }) => {
          console.log('[Realtime] Transactions updated:', items.length, 'synced:', isSynced);
          // Spread to create new array reference for React state comparison
          setState((prev) => ({ ...prev, transactions: [...items] as Transaction[] }));
        },
        error: (error) => {
          console.error('[Realtime] Transaction subscription error:', error);
        },
      });
      subs.push(transactionSub);

      // Individual mutation subscriptions for callbacks
      if (onTransactionChange) {
        const createSub = client.models.Transaction.onCreate().subscribe({
          next: (transaction) => {
            console.log('[Realtime] Transaction created:', transaction.id);
            onTransactionChange(transaction as Transaction, 'create');
          },
          error: (error) => console.error('[Realtime] Transaction onCreate error:', error),
        });
        subs.push(createSub);

        const updateSub = client.models.Transaction.onUpdate().subscribe({
          next: (transaction) => {
            console.log('[Realtime] Transaction updated:', transaction.id);
            onTransactionChange(transaction as Transaction, 'update');
          },
          error: (error) => console.error('[Realtime] Transaction onUpdate error:', error),
        });
        subs.push(updateSub);

        const deleteSub = client.models.Transaction.onDelete().subscribe({
          next: (transaction) => {
            console.log('[Realtime] Transaction deleted:', transaction.id);
            onTransactionChange(transaction as Transaction, 'delete');
          },
          error: (error) => console.error('[Realtime] Transaction onDelete error:', error),
        });
        subs.push(deleteSub);
      }
    }

    subscriptionsRef.current = subs;
    setState((prev) => ({ ...prev, loading: false }));

    // Cleanup subscriptions on unmount
    return () => {
      console.log('[Realtime] Cleaning up subscriptions');
      for (const sub of subs) {
        sub.unsubscribe();
      }
    };
  }, [
    userId,
    enableInvoices,
    enableMatches,
    enableTransactions,
    onInvoiceChange,
    onMatchChange,
    onTransactionChange,
  ]);

  // Manual refresh function
  const refresh = useCallback(async () => {
    if (!userId) return;

    setState((prev) => ({ ...prev, loading: true }));

    try {
      const [invoicesRes, matchesRes, transactionsRes] = await Promise.all([
        enableInvoices
          ? client.models.Invoice.list() // ownerDefinedIn('userId') auto-filters
          : Promise.resolve({ data: [] }),
        enableMatches
          ? client.models.Match.list({ filter: { userId: { eq: userId } } })
          : Promise.resolve({ data: [] }),
        enableTransactions
          ? client.models.Transaction.list() // ownerDefinedIn('userId') auto-filters
          : Promise.resolve({ data: [] }),
      ]);

      const allMatches = (matchesRes.data ?? []) as Match[];
      const pending = allMatches.filter((m) => m.status === 'PENDING');

      setState((prev) => ({
        ...prev,
        invoices: (invoicesRes.data ?? []) as Invoice[],
        matches: allMatches,
        pendingMatches: pending,
        transactions: (transactionsRes.data ?? []) as Transaction[],
        loading: false,
      }));
    } catch (error) {
      console.error('Error refreshing data:', error);
      setState((prev) => ({
        ...prev,
        error: error instanceof Error ? error : new Error('Failed to refresh'),
        loading: false,
      }));
    }
  }, [userId, enableInvoices, enableMatches, enableTransactions]);

  return {
    ...state,
    userId,
    refresh,
  };
}

/**
 * Hook specifically for pending matches with real-time updates
 */
export function useRealtimePendingMatches() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    async function getUserId() {
      try {
        const session = await fetchAuthSession();
        setUserId(session.tokens?.idToken?.payload.sub as string);
      } catch (error) {
        console.error('Failed to get user ID:', error);
        setLoading(false);
      }
    }
    getUserId();
  }, []);

  useEffect(() => {
    if (!userId) return;

    const sub = client.models.Match.observeQuery({
      filter: {
        userId: { eq: userId },
        status: { eq: 'PENDING' },
      },
    }).subscribe({
      next: ({ items, isSynced }) => {
        console.log('[Realtime] Pending matches updated:', items.length, 'synced:', isSynced);
        setMatches(items as Match[]);
        setLoading(false);
      },
      error: (error) => {
        console.error('[Realtime] Pending matches subscription error:', error);
        setLoading(false);
      },
    });

    return () => sub.unsubscribe();
  }, [userId]);

  return { matches, loading, userId };
}
