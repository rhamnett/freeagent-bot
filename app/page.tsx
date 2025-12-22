"use client";

import { fetchAuthSession } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useEffect, useState } from "react";
import type { Schema } from "@/amplify/data/resource";
import Link from "next/link";
import { clearAllData, triggerFreeAgentSync, triggerFullSync } from "./actions/sync-actions";
import { AmplifyAuthenticator } from "@/components/auth/amplify-authenticator";
import { Navbar } from "@/components/layout/navbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, CheckCircle2, FileText, Link2, RefreshCw, Trash2, TrendingUp } from "lucide-react";

const client = generateClient<Schema>();

interface DashboardStats {
  pendingReview: number;
  autoApproved: number;
  processedToday: number;
  gmailConnected: boolean;
  freeagentConnected: boolean;
}

interface RecentActivity {
  id: string;
  type: "invoice" | "match" | "approval";
  description: string;
  timestamp: string;
}

function Dashboard({ signOut }: { signOut: () => void }) {
  const [stats, setStats] = useState<DashboardStats>({
    pendingReview: 0,
    autoApproved: 0,
    processedToday: 0,
    gmailConnected: false,
    freeagentConnected: false,
  });
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncingFreeAgent, setSyncingFreeAgent] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    loadDashboardData();
  }, []);

  async function loadDashboardData() {
    try {
      const session = await fetchAuthSession();
      const userId = session.tokens?.idToken?.payload.sub as string;

      // Check OAuth connections
      const gmailConnection = await client.models.OAuthConnection.get({
        id: `${userId}#GMAIL`,
      });
      const freeagentConnection = await client.models.OAuthConnection.get({
        id: `${userId}#FREEAGENT`,
      });

      // Get pending matches
      const pendingMatches = await client.models.Match.list({
        filter: {
          userId: { eq: userId },
          status: { eq: "PENDING" },
        },
      });

      // Get auto-approved matches (last 7 days)
      const weekAgo = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const autoApprovedMatches = await client.models.Match.list({
        filter: {
          userId: { eq: userId },
          status: { eq: "AUTO_APPROVED" },
          createdAt: { ge: weekAgo },
        },
      });

      // Get invoices processed today
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const processedToday = await client.models.Invoice.list({
        filter: {
          userId: { eq: userId },
          createdAt: { ge: todayStart.toISOString() },
        },
      });

      setStats({
        pendingReview: pendingMatches.data?.length ?? 0,
        autoApproved: autoApprovedMatches.data?.length ?? 0,
        processedToday: processedToday.data?.length ?? 0,
        gmailConnected: !!gmailConnection.data,
        freeagentConnected: !!freeagentConnection.data,
      });

      // Build recent activity
      const activities: RecentActivity[] = [];

      // Add recent invoices
      const recentInvoices = await client.models.Invoice.list({
        filter: { userId: { eq: userId } },
        limit: 5,
      });

      for (const invoice of recentInvoices.data ?? []) {
        activities.push({
          id: invoice.id,
          type: "invoice",
          description: `Invoice from ${invoice.vendorName ?? "Unknown"} - ${invoice.status}`,
          timestamp: invoice.createdAt ?? "",
        });
      }

      // Sort by timestamp and take top 5
      activities.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      setRecentActivity(activities.slice(0, 5));
    } catch (error) {
      console.error("Error loading dashboard:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleClearData() {
    if (clearing) return;

    const confirmed = window.confirm(
      "Are you sure you want to clear ALL invoices, transactions, and matches? This cannot be undone.",
    );
    if (!confirmed) return;

    try {
      setClearing(true);
      setSyncStatus("Clearing all data...");

      const session = await fetchAuthSession();
      const userId = session.tokens?.idToken?.payload.sub as string;

      if (!userId) {
        setSyncStatus("Error: Not authenticated");
        return;
      }

      const result = await clearAllData(userId);

      if (result.success) {
        setSyncStatus(
          `Cleared: ${result.deleted.invoices} invoices, ${result.deleted.transactions} transactions, ${result.deleted.matches} matches`,
        );
        await loadDashboardData();
      } else {
        setSyncStatus(`Error: ${result.error}`);
      }
    } catch (error) {
      console.error("Clear data error:", error);
      setSyncStatus(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setClearing(false);
      setTimeout(() => setSyncStatus(null), 10000);
    }
  }

  async function triggerManualSync() {
    if (syncing) return;

    try {
      setSyncing(true);
      setSyncStatus("Starting sync...");

      const session = await fetchAuthSession();
      const userId = session.tokens?.idToken?.payload.sub as string;

      if (!userId) {
        setSyncStatus("Error: Not authenticated");
        return;
      }

      setSyncStatus("Syncing Gmail and FreeAgent...");
      const result = await triggerFullSync(userId);

      const gmailMsg = result.gmail.success
        ? `Gmail: ${result.gmail.processed ?? 0} invoices`
        : `Gmail: ${result.gmail.error}`;
      const faMsg = result.freeagent.success
        ? `FreeAgent: ${result.freeagent.processed ?? 0} items (${result.freeagent.bankTransactions ?? 0} transactions, ${result.freeagent.bills ?? 0} bills)`
        : `FreeAgent: ${result.freeagent.error}`;

      setSyncStatus(`${gmailMsg} | ${faMsg}`);

      await loadDashboardData();
    } catch (error) {
      console.error("Sync error:", error);
      setSyncStatus(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncStatus(null), 10000);
    }
  }

  async function handleFreeAgentSync() {
    if (syncingFreeAgent) return;

    try {
      setSyncingFreeAgent(true);
      setSyncStatus("Syncing FreeAgent transactions...");

      const session = await fetchAuthSession();
      const userId = session.tokens?.idToken?.payload.sub as string;

      if (!userId) {
        setSyncStatus("Error: Not authenticated");
        return;
      }

      const result = await triggerFreeAgentSync(userId);

      if (result.success) {
        setSyncStatus(
          `FreeAgent: ${result.processed ?? 0} items synced (${result.bankTransactions ?? 0} transactions, ${result.bills ?? 0} bills)`,
        );
      } else {
        setSyncStatus(`FreeAgent sync failed: ${result.error}`);
      }

      await loadDashboardData();
    } catch (error) {
      console.error("FreeAgent sync error:", error);
      setSyncStatus(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setSyncingFreeAgent(false);
      setTimeout(() => setSyncStatus(null), 10000);
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
            <h1 className="text-4xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground mt-2">
              AI-powered invoice matching for FreeAgent
            </p>
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
                ? "Connect Gmail and FreeAgent to start matching invoices."
                : !stats.gmailConnected
                  ? "Connect Gmail to scan for invoices."
                  : "Connect FreeAgent to match transactions."}
              {" "}
              <Link href="/settings" className="font-medium underline underline-offset-4">
                Go to Settings
              </Link>
            </AlertDescription>
          </Alert>
        )}

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Pending Review
              </CardTitle>
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
              <CardTitle className="text-sm font-medium">
                Auto-Approved
              </CardTitle>
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.autoApproved}</div>
              <p className="text-xs text-muted-foreground">Last 7 days</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Processed Today
              </CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.processedToday}</div>
              <p className="text-xs text-muted-foreground">Invoices</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                Connections
              </CardTitle>
              <Link2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${stats.gmailConnected ? 'bg-green-500' : 'bg-gray-300'}`} />
                  <span className="text-sm">Gmail</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${stats.freeagentConnected ? 'bg-green-500' : 'bg-gray-300'}`} />
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
              <div className="text-center py-8 text-muted-foreground">
                No recent activity
              </div>
            ) : (
              <div className="space-y-4">
                {recentActivity.map((activity) => (
                  <div
                    key={activity.id}
                    className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0"
                  >
                    <div className="flex items-center gap-4">
                      <div className="text-2xl">
                        {activity.type === "invoice"
                          ? "📄"
                          : activity.type === "match"
                            ? "🔗"
                            : "✓"}
                      </div>
                      <div>
                        <p className="text-sm font-medium">{activity.description}</p>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(activity.timestamp).toLocaleString("en-GB", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                ))}
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
                <CardDescription>
                  Review and approve pending invoice matches
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
          <Link href="/settings">
            <Card className="hover:border-primary transition-colors cursor-pointer">
              <CardHeader>
                <CardTitle className="text-lg">Settings</CardTitle>
                <CardDescription>
                  Manage your Gmail and FreeAgent connections
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AmplifyAuthenticator>
      {(signOut) => <Dashboard signOut={signOut} />}
    </AmplifyAuthenticator>
  );
}
