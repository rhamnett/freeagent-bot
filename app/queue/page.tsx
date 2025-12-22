"use client";

import { fetchAuthSession } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import { useEffect, useState } from "react";
import type { Schema } from "@/amplify/data/resource";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CheckCircle, RefreshCw, X } from "lucide-react";

const client = generateClient<Schema>();

interface MatchWithDetails {
  id: string;
  invoiceId: string;
  transactionId: string;
  confidenceScore: number;
  matchReasons: string[];
  status: string;
  createdAt: string;
  invoice?: {
    vendorName?: string;
    totalAmount?: number;
    currency?: string;
    invoiceDate?: string;
    s3Key?: string;
  };
  transaction?: {
    type: string;
    amount: number;
    date: string;
    description?: string;
    contactName?: string;
  };
}

export default function QueuePage() {
  const [matches, setMatches] = useState<MatchWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMatch, setSelectedMatch] = useState<MatchWithDetails | null>(
    null,
  );
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    loadPendingMatches();
  }, []);

  async function loadPendingMatches() {
    try {
      const session = await fetchAuthSession();
      const userId = session.tokens?.idToken?.payload.sub as string;

      // Get pending matches
      const matchesResult = await client.models.Match.list({
        filter: {
          userId: { eq: userId },
          status: { eq: "PENDING" },
        },
      });

      const matchesWithDetails: MatchWithDetails[] = [];

      for (const match of matchesResult.data ?? []) {
        // Get invoice details
        const invoiceResult = await client.models.Invoice.get({
          id: match.invoiceId,
        });

        // Get transaction details
        const transactionResult = await client.models.Transaction.get({
          id: match.transactionId,
        });

        matchesWithDetails.push({
          id: match.id,
          invoiceId: match.invoiceId,
          transactionId: match.transactionId,
          confidenceScore: match.confidenceScore,
          matchReasons: (match.matchReasons ?? []).filter((r): r is string => r !== null),
          status: match.status ?? "PENDING",
          createdAt: match.createdAt ?? "",
          invoice: invoiceResult.data
            ? {
                vendorName: invoiceResult.data.vendorName ?? undefined,
                totalAmount: invoiceResult.data.totalAmount ?? undefined,
                currency: invoiceResult.data.currency ?? undefined,
                invoiceDate: invoiceResult.data.invoiceDate ?? undefined,
                s3Key: invoiceResult.data.s3Key ?? undefined,
              }
            : undefined,
          transaction: transactionResult.data
            ? {
                type: transactionResult.data.type ?? "BANK_TRANSACTION",
                amount: transactionResult.data.amount,
                date: transactionResult.data.date,
                description: transactionResult.data.description ?? undefined,
                contactName: transactionResult.data.contactName ?? undefined,
              }
            : undefined,
        });
      }

      setMatches(matchesWithDetails);
    } catch (error) {
      console.error("Error loading matches:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove(matchId: string) {
    setProcessing(matchId);
    try {
      await client.models.Match.update({
        id: matchId,
        status: "APPROVED",
        reviewedAt: new Date().toISOString(),
      });

      // Update the local state
      setMatches((prev) => prev.filter((m) => m.id !== matchId));
      setSelectedMatch(null);
    } catch (error) {
      console.error("Error approving match:", error);
    } finally {
      setProcessing(null);
    }
  }

  async function handleReject(matchId: string) {
    setProcessing(matchId);
    try {
      await client.models.Match.update({
        id: matchId,
        status: "REJECTED",
        reviewedAt: new Date().toISOString(),
      });

      // Update the local state
      setMatches((prev) => prev.filter((m) => m.id !== matchId));
      setSelectedMatch(null);
    } catch (error) {
      console.error("Error rejecting match:", error);
    } finally {
      setProcessing(null);
    }
  }

  function formatConfidence(score: number): string {
    return `${Math.round(score * 100)}%`;
  }

  function formatCurrency(
    amount: number | undefined,
    currency?: string,
  ): string {
    if (amount === undefined) return "-";
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency ?? "GBP",
    }).format(amount);
  }

  function formatDate(dateStr: string | undefined): string {
    if (!dateStr) return "-";
    return new Date(dateStr).toLocaleDateString("en-GB");
  }

  function getConfidenceVariant(score: number): "default" | "secondary" | "destructive" {
    if (score >= 0.75) return "default";
    if (score >= 0.5) return "secondary";
    return "destructive";
  }

  if (loading) {
    return (
      <div className="container mx-auto p-8">
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-4xl font-bold tracking-tight">Review Queue</h1>
        <p className="text-muted-foreground mt-2">
          {matches.length} match{matches.length !== 1 ? "es" : ""} awaiting review
        </p>
      </div>

      {matches.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center py-12">
              <CheckCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-lg font-medium">No matches pending review</p>
              <p className="text-sm text-muted-foreground mt-2">
                New matches will appear here when invoices are processed
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Match List */}
          <div className="space-y-4 max-h-[calc(100vh-12rem)] overflow-y-auto pr-2">
            {matches.map((match) => (
              <Card
                key={match.id}
                className={`cursor-pointer transition-all ${
                  selectedMatch?.id === match.id
                    ? "border-primary ring-2 ring-primary ring-opacity-50"
                    : "hover:border-primary"
                }`}
                onClick={() => setSelectedMatch(match)}
              >
                <CardHeader>
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-lg">
                      {match.invoice?.vendorName ?? "Unknown Vendor"}
                    </CardTitle>
                    <Badge variant={getConfidenceVariant(match.confidenceScore)}>
                      {formatConfidence(match.confidenceScore)}
                    </Badge>
                  </div>
                  <CardDescription className="flex gap-4">
                    <span>
                      {formatCurrency(
                        match.invoice?.totalAmount,
                        match.invoice?.currency,
                      )}
                    </span>
                    <span>•</span>
                    <span>{formatDate(match.invoice?.invoiceDate)}</span>
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {match.matchReasons.map((reason) => (
                      <Badge key={reason} variant="outline" className="text-xs">
                        {reason.replace("_", " ")}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Detail Panel */}
          {selectedMatch && (
            <div className="lg:sticky lg:top-8 h-fit">
              <Card>
                <CardHeader>
                  <CardTitle>Match Details</CardTitle>
                  <CardDescription>
                    Review the invoice and transaction comparison
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Comparison Grid */}
                  <div className="grid grid-cols-2 gap-4">
                    {/* Invoice Section */}
                    <div className="space-y-3">
                      <h3 className="font-semibold text-sm text-muted-foreground uppercase">
                        Invoice
                      </h3>
                      <div className="space-y-2 text-sm">
                        <div>
                          <p className="text-muted-foreground">Vendor</p>
                          <p className="font-medium">
                            {selectedMatch.invoice?.vendorName ?? "-"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Amount</p>
                          <p className="font-medium">
                            {formatCurrency(
                              selectedMatch.invoice?.totalAmount,
                              selectedMatch.invoice?.currency,
                            )}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Date</p>
                          <p className="font-medium">
                            {formatDate(selectedMatch.invoice?.invoiceDate)}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Transaction Section */}
                    <div className="space-y-3">
                      <h3 className="font-semibold text-sm text-muted-foreground uppercase">
                        Transaction
                      </h3>
                      <div className="space-y-2 text-sm">
                        <div>
                          <p className="text-muted-foreground">Type</p>
                          <p className="font-medium">
                            {selectedMatch.transaction?.type ?? "-"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Amount</p>
                          <p className="font-medium">
                            {formatCurrency(selectedMatch.transaction?.amount)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Date</p>
                          <p className="font-medium">
                            {formatDate(selectedMatch.transaction?.date)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Description</p>
                          <p className="font-medium">
                            {selectedMatch.transaction?.description ??
                              selectedMatch.transaction?.contactName ??
                              "-"}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  {/* Confidence Section */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">Confidence Score</h3>
                      <Badge variant={getConfidenceVariant(selectedMatch.confidenceScore)} className="text-base">
                        {formatConfidence(selectedMatch.confidenceScore)}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {selectedMatch.matchReasons.map((reason) => (
                        <Badge key={reason} variant="outline">
                          {reason.replace("_", " ")}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <Separator />

                  {/* Actions */}
                  <div className="flex gap-3">
                    <Button
                      onClick={() => handleApprove(selectedMatch.id)}
                      disabled={processing === selectedMatch.id}
                      className="flex-1"
                      size="lg"
                    >
                      {processing === selectedMatch.id ? (
                        <>
                          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          Processing...
                        </>
                      ) : (
                        <>
                          <CheckCircle className="mr-2 h-4 w-4" />
                          Approve
                        </>
                      )}
                    </Button>
                    <Button
                      onClick={() => handleReject(selectedMatch.id)}
                      disabled={processing === selectedMatch.id}
                      variant="outline"
                      size="lg"
                    >
                      <X className="mr-2 h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
