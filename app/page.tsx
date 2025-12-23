'use client';

import { generateClient } from 'aws-amplify/data';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  ExternalLink,
  FileText,
  Link2,
  RefreshCw,
  Trash2,
  TrendingUp,
  Wifi,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { Schema } from '@/amplify/data/resource';
import { AmplifyAuthenticator } from '@/components/auth/amplify-authenticator';
import { Navbar } from '@/components/layout/navbar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { useRealtimeData } from '@/hooks/use-realtime-data';
import { clearAllData, triggerFreeAgentSync, triggerFullSync } from './actions/sync-actions';

type Invoice = Schema['Invoice']['type'];

const client = generateClient<Schema>();

interface DashboardStats {
  pendingReview: number;
  autoApproved: number;
  processedToday: number;
  gmailConnected: boolean;
  freeagentConnected: boolean;
  totalTransactions: number;
  totalBills: number;
}

interface RecentActivity {
  id: string;
  type: 'invoice' | 'match' | 'approval';
  description: string;
  timestamp: string;
}

function Dashboard({ signOut }: { signOut: () => void }) {
  const [gmailConnected, setGmailConnected] = useState(false);
  const [freeagentConnected, setFreeagentConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingFreeAgent, setSyncingFreeAgent] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  // Real-time data subscriptions
  const {
    invoices,
    matches,
    pendingMatches,
    transactions,
    loading: realtimeLoading,
    userId,
  } = useRealtimeData({
    enableInvoices: true,
    enableMatches: true,
    enableTransactions: true,
    onInvoiceChange: useCallback((invoice, type) => {
      if (type === 'create') {
        toast.success('New invoice received', {
          description: `From ${invoice.vendorName ?? 'Unknown vendor'}`,
        });
      } else if (type === 'update' && invoice.status === 'EXTRACTED') {
        toast.info('Invoice processed', {
          description: `${invoice.vendorName ?? 'Invoice'} - ${invoice.totalAmount ? `£${invoice.totalAmount.toFixed(2)}` : 'Amount pending'}`,
        });
      }
    }, []),
    onMatchChange: useCallback((match, type) => {
      if (type === 'create') {
        const confidence = Math.round((match.confidenceScore ?? 0) * 100);
        if (match.status === 'AUTO_APPROVED') {
          toast.success('Match auto-approved', {
            description: `Confidence: ${confidence}%`,
          });
        } else if (match.status === 'PENDING') {
          toast.info('New match for review', {
            description: `Confidence: ${confidence}%`,
          });
        }
      }
    }, []),
    onTransactionChange: useCallback((transaction, type) => {
      if (type === 'create') {
        toast.info('New transaction synced', {
          description: `${transaction.type === 'BILL' ? 'Bill' : 'Transaction'}: £${transaction.amount.toFixed(2)}`,
        });
      }
    }, []),
  });

  // Calculate stats from real-time data
  const stats = useMemo<DashboardStats>(() => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const autoApproved = matches.filter(
      (m) => m.status === 'AUTO_APPROVED' && new Date(m.createdAt ?? 0) >= weekAgo
    ).length;

    const processedToday = invoices.filter(
      (inv) => new Date(inv.createdAt ?? 0) >= todayStart
    ).length;

    const bankTransactionCount = transactions.filter((t) => t.type === 'BANK_TRANSACTION').length;
    const billCount = transactions.filter((t) => t.type === 'BILL').length;

    return {
      pendingReview: pendingMatches.length,
      autoApproved,
      processedToday,
      gmailConnected,
      freeagentConnected,
      totalTransactions: bankTransactionCount,
      totalBills: billCount,
    };
  }, [invoices, matches, pendingMatches, transactions, gmailConnected, freeagentConnected]);

  // Build recent activity from real-time invoices
  const recentActivity = useMemo<RecentActivity[]>(() => {
    return invoices
      .map((invoice) => ({
        id: invoice.id,
        type: 'invoice' as const,
        description: `Invoice from ${invoice.vendorName ?? 'Unknown'} - ${invoice.status}`,
        timestamp: invoice.createdAt ?? '',
      }))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 5);
  }, [invoices]);

  // Load OAuth connections (not real-time, just on mount)
  useEffect(() => {
    async function loadConnections() {
      if (!userId) return;
      try {
        const [gmailConnection, freeagentConnection] = await Promise.all([
          client.models.OAuthConnection.get({ id: `${userId}#GMAIL` }),
          client.models.OAuthConnection.get({ id: `${userId}#FREEAGENT` }),
        ]);
        setGmailConnected(!!gmailConnection.data);
        setFreeagentConnected(!!freeagentConnection.data);
      } catch (error) {
        console.error('Error loading connections:', error);
      } finally {
        setConnectionsLoading(false);
      }
    }
    loadConnections();
  }, [userId]);

  const loading = realtimeLoading || connectionsLoading;

  async function handleClearData() {
    if (clearing || !userId) return;

    const confirmed = window.confirm(
      'Are you sure you want to clear ALL invoices, transactions, and matches? This cannot be undone.'
    );
    if (!confirmed) return;

    try {
      setClearing(true);
      setSyncStatus('Clearing all data...');

      const result = await clearAllData(userId);

      if (result.success) {
        setSyncStatus(
          `Cleared: ${result.deleted.invoices} invoices, ${result.deleted.transactions} transactions, ${result.deleted.matches} matches`
        );
        // Real-time subscriptions will automatically update the UI
      } else {
        setSyncStatus(`Error: ${result.error}`);
      }
    } catch (error) {
      console.error('Clear data error:', error);
      setSyncStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setClearing(false);
      setTimeout(() => setSyncStatus(null), 10000);
    }
  }

  async function triggerManualSync() {
    if (syncing || !userId) return;

    try {
      setSyncing(true);
      setSyncStatus('Syncing Gmail and FreeAgent...');

      const result = await triggerFullSync(userId);

      const gmailMsg = result.gmail.success
        ? `Gmail: ${result.gmail.processed ?? 0} invoices`
        : `Gmail: ${result.gmail.error}`;
      const faMsg = result.freeagent.success
        ? `FreeAgent: ${result.freeagent.processed ?? 0} items (${result.freeagent.bankTransactions ?? 0} transactions, ${result.freeagent.bills ?? 0} bills)`
        : `FreeAgent: ${result.freeagent.error}`;

      setSyncStatus(`${gmailMsg} | ${faMsg}`);
      // Real-time subscriptions will automatically update the UI
    } catch (error) {
      console.error('Sync error:', error);
      setSyncStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncStatus(null), 10000);
    }
  }

  async function handleFreeAgentSync() {
    if (syncingFreeAgent || !userId) return;

    try {
      setSyncingFreeAgent(true);
      const syncToast = toast.loading('Syncing FreeAgent transactions...');

      const result = await triggerFreeAgentSync(userId);

      if (result.success) {
        const totalSynced = (result.bankTransactions ?? 0) + (result.bills ?? 0);
        toast.success(`Synced ${totalSynced} items from FreeAgent`, {
          id: syncToast,
          description: `${result.bankTransactions ?? 0} bank transactions, ${result.bills ?? 0} bills`,
        });
      } else {
        toast.error('FreeAgent sync failed', {
          id: syncToast,
          description: result.error,
        });
      }
      // Real-time subscriptions will automatically update the UI
    } catch (error) {
      console.error('FreeAgent sync error:', error);
      toast.error('Sync failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setSyncingFreeAgent(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar signOut={signOut} />
        <main className="container mx-auto p-8">
          <div className="flex items-center justify-center h-64">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navbar signOut={signOut} />

      <main className="container mx-auto p-8 space-y-8">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold tracking-tight">Dashboard</h1>
              <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/10 text-green-600 rounded-full text-xs font-medium">
                <Wifi className="h-3 w-3" />
                <span>Live</span>
              </div>
            </div>
            <p className="text-muted-foreground mt-2">AI-powered invoice matching for FreeAgent</p>
          </div>
          <div className="flex gap-3">
            <Button
              onClick={triggerManualSync}
              disabled={syncing || syncingFreeAgent || clearing}
              size="lg"
            >
              {syncing ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Scan Now
                </>
              )}
            </Button>
            <Button
              onClick={handleFreeAgentSync}
              disabled={syncing || syncingFreeAgent || clearing}
              variant="secondary"
              size="lg"
            >
              {syncingFreeAgent ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <TrendingUp className="mr-2 h-4 w-4" />
                  Sync FreeAgent
                </>
              )}
            </Button>
            <Button
              onClick={handleClearData}
              disabled={syncing || syncingFreeAgent || clearing}
              variant="destructive"
              size="lg"
            >
              {clearing ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Clearing...
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Clear Data
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Sync Status */}
        {syncStatus && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{syncStatus}</AlertDescription>
          </Alert>
        )}

        {/* Connection Warning */}
        {(!stats.gmailConnected || !stats.freeagentConnected) && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {!stats.gmailConnected && !stats.freeagentConnected
                ? 'Connect Gmail and FreeAgent to start matching invoices.'
                : !stats.gmailConnected
                  ? 'Connect Gmail to scan for invoices.'
                  : 'Connect FreeAgent to match transactions.'}{' '}
              <Link href="/settings" className="font-medium underline underline-offset-4">
                Go to Settings
              </Link>
            </AlertDescription>
          </Alert>
        )}

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Review</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.pendingReview}</div>
              {stats.pendingReview > 0 && (
                <Link href="/queue" className="text-xs text-muted-foreground hover:underline">
                  Review now →
                </Link>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Auto-Approved</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.autoApproved}</div>
              <p className="text-xs text-muted-foreground">Last 7 days</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Processed Today</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.processedToday}</div>
              <p className="text-xs text-muted-foreground">Invoices</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">FreeAgent Data</CardTitle>
              <Database className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalTransactions + stats.totalBills}</div>
              <p className="text-xs text-muted-foreground">
                {stats.totalTransactions} transactions, {stats.totalBills} bills
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Connections</CardTitle>
              <Link2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <div
                    className={`h-2 w-2 rounded-full ${stats.gmailConnected ? 'bg-green-500' : 'bg-gray-300'}`}
                  />
                  <span className="text-sm">Gmail</span>
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className={`h-2 w-2 rounded-full ${stats.freeagentConnected ? 'bg-green-500' : 'bg-gray-300'}`}
                  />
                  <span className="text-sm">FreeAgent</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest updates from your account</CardDescription>
          </CardHeader>
          <CardContent>
            {recentActivity.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">No recent activity</div>
            ) : (
              <div className="space-y-4">
                {recentActivity.map((activity) => {
                  const invoice = invoices.find((inv) => inv.id === activity.id);
                  return (
                    <button
                      type="button"
                      key={activity.id}
                      onClick={() => invoice && setSelectedInvoice(invoice)}
                      className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0 w-full text-left hover:bg-muted/50 rounded-lg p-2 -mx-2 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-4">
                        <div className="text-2xl">
                          {activity.type === 'invoice'
                            ? '📄'
                            : activity.type === 'match'
                              ? '🔗'
                              : '✓'}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{activity.description}</p>
                          {invoice?.totalAmount && (
                            <p className="text-xs text-muted-foreground">
                              {invoice.currency ?? '£'}
                              {invoice.totalAmount.toFixed(2)}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {new Date(activity.timestamp).toLocaleString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Links */}
        <div className="grid gap-4 md:grid-cols-2">
          <Link href="/queue">
            <Card className="hover:border-primary transition-colors cursor-pointer">
              <CardHeader>
                <CardTitle className="text-lg">Review Queue</CardTitle>
                <CardDescription>Review and approve pending invoice matches</CardDescription>
              </CardHeader>
            </Card>
          </Link>
          <Link href="/settings">
            <Card className="hover:border-primary transition-colors cursor-pointer">
              <CardHeader>
                <CardTitle className="text-lg">Settings</CardTitle>
                <CardDescription>Manage your Gmail and FreeAgent connections</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        </div>
      </main>

      {/* Invoice Detail Dialog */}
      <Dialog open={!!selectedInvoice} onOpenChange={(open) => !open && setSelectedInvoice(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Invoice Details
            </DialogTitle>
            <DialogDescription>{selectedInvoice?.vendorName ?? 'Unknown Vendor'}</DialogDescription>
          </DialogHeader>

          {selectedInvoice && (
            <div className="space-y-6">
              {/* Status Badge */}
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    selectedInvoice.status === 'MATCHED'
                      ? 'default'
                      : selectedInvoice.status === 'EXTRACTED'
                        ? 'secondary'
                        : selectedInvoice.status === 'FAILED'
                          ? 'destructive'
                          : 'outline'
                  }
                >
                  {selectedInvoice.status ?? 'PENDING'}
                </Badge>
                {selectedInvoice.extractionConfidence && (
                  <span className="text-xs text-muted-foreground">
                    {Math.round(selectedInvoice.extractionConfidence * 100)}% confidence
                  </span>
                )}
              </div>

              <Separator />

              {/* Invoice Information */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Invoice Number</p>
                  <p className="font-medium">{selectedInvoice.invoiceNumber ?? 'N/A'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Amount</p>
                  <p className="font-medium text-lg">
                    {selectedInvoice.currency ?? '£'}
                    {selectedInvoice.totalAmount?.toFixed(2) ?? 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Invoice Date</p>
                  <p className="font-medium">
                    {selectedInvoice.invoiceDate
                      ? new Date(selectedInvoice.invoiceDate).toLocaleDateString('en-GB')
                      : 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Due Date</p>
                  <p className="font-medium">
                    {selectedInvoice.dueDate
                      ? new Date(selectedInvoice.dueDate).toLocaleDateString('en-GB')
                      : 'N/A'}
                  </p>
                </div>
              </div>

              <Separator />

              {/* Email Information */}
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Source Email</p>
                <div className="flex items-center gap-2">
                  <p className="font-medium">{selectedInvoice.senderEmail ?? 'Unknown sender'}</p>
                </div>
                {selectedInvoice.receivedAt && (
                  <p className="text-xs text-muted-foreground">
                    Received: {new Date(selectedInvoice.receivedAt).toLocaleString('en-GB')}
                  </p>
                )}
              </div>

              {/* Line Items (if available) */}
              {selectedInvoice.lineItems && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Line Items</p>
                    <div className="bg-muted/50 rounded-lg p-3 text-xs font-mono overflow-auto max-h-40">
                      <pre>{JSON.stringify(selectedInvoice.lineItems, null, 2)}</pre>
                    </div>
                  </div>
                </>
              )}

              {/* Processing Info */}
              <Separator />
              <div className="text-xs text-muted-foreground space-y-1">
                <p>ID: {selectedInvoice.id}</p>
                {selectedInvoice.processingStep && (
                  <p>Processing Step: {selectedInvoice.processingStep}</p>
                )}
                {selectedInvoice.s3Key && <p>S3 Key: {selectedInvoice.s3Key}</p>}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function App() {
  return (
    <AmplifyAuthenticator>{(signOut) => <Dashboard signOut={signOut} />}</AmplifyAuthenticator>
  );
}
