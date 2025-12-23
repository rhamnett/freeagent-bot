'use client';

import { fetchAuthSession } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/data';
import { AlertCircle, CheckCircle2, Mail, RefreshCw, TrendingUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Schema } from '@/amplify/data/resource';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const client = generateClient<Schema>();

interface ConnectionStatus {
  connected: boolean;
  email?: string;
  expiresAt?: string;
}

export default function SettingsPage() {
  const [gmailStatus, setGmailStatus] = useState<ConnectionStatus>({
    connected: false,
  });
  const [freeagentStatus, setFreeagentStatus] = useState<ConnectionStatus>({
    connected: false,
  });
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    async function checkConnections() {
      try {
        const session = await fetchAuthSession();
        const currentUserId = session.tokens?.idToken?.payload.sub as string;
        setUserId(currentUserId);

        // Check Gmail connection
        const gmailConnection = await client.models.OAuthConnection.get({
          id: `${currentUserId}#GMAIL`,
        });

        if (gmailConnection.data) {
          setGmailStatus({
            connected: true,
            email: gmailConnection.data.email ?? undefined,
            expiresAt: gmailConnection.data.expiresAt,
          });
        }

        // Check FreeAgent connection
        const freeagentConnection = await client.models.OAuthConnection.get({
          id: `${currentUserId}#FREEAGENT`,
        });

        if (freeagentConnection.data) {
          setFreeagentStatus({
            connected: true,
            email: freeagentConnection.data.email ?? undefined,
            expiresAt: freeagentConnection.data.expiresAt,
          });
        }
      } catch (error) {
        console.error('Error checking connections:', error);
      } finally {
        setLoading(false);
      }
    }

    checkConnections();
  }, []);

  const connectGmail = () => {
    // Redirect to Gmail OAuth flow
    const params = new URLSearchParams({
      client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '',
      redirect_uri: `${window.location.origin}/auth/gmail/callback`,
      response_type: 'code',
      scope:
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify',
      access_type: 'offline',
      prompt: 'consent',
    });

    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  };

  const connectFreeAgent = () => {
    // Redirect to FreeAgent OAuth flow
    const params = new URLSearchParams({
      client_id: process.env.NEXT_PUBLIC_FREEAGENT_CLIENT_ID ?? '',
      redirect_uri: `${window.location.origin}/auth/freeagent/callback`,
      response_type: 'code',
    });

    const baseUrl =
      process.env.NEXT_PUBLIC_FREEAGENT_USE_SANDBOX === 'true'
        ? 'https://api.sandbox.freeagent.com'
        : 'https://api.freeagent.com';

    window.location.href = `${baseUrl}/v2/approve_app?${params.toString()}`;
  };

  const disconnectService = async (provider: 'GMAIL' | 'FREEAGENT') => {
    if (!userId) return;

    try {
      await client.models.OAuthConnection.delete({
        id: `${userId}#${provider}`,
      });

      if (provider === 'GMAIL') {
        setGmailStatus({ connected: false });
      } else {
        setFreeagentStatus({ connected: false });
      }
    } catch (error) {
      console.error(`Error disconnecting ${provider}:`, error);
    }
  };

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
    <div className="container max-w-4xl mx-auto p-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-4xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-2">
          Connect your Gmail and FreeAgent accounts to enable automatic invoice matching
        </p>
      </div>

      {/* Connections */}
      <div className="space-y-6">
        {/* Gmail Connection */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900">
                <Mail className="h-6 w-6 text-blue-600 dark:text-blue-400" />
              </div>
              <div className="flex-1">
                <CardTitle>Gmail</CardTitle>
                <CardDescription>Read invoices from email attachments</CardDescription>
              </div>
              {gmailStatus.connected ? (
                <Badge variant="default" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Not Connected
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {gmailStatus.connected && gmailStatus.email && (
              <div className="rounded-lg bg-muted p-3">
                <p className="text-sm text-muted-foreground">Connected as</p>
                <p className="text-sm font-medium">{gmailStatus.email}</p>
              </div>
            )}
            <div className="flex gap-2">
              {gmailStatus.connected ? (
                <Button onClick={() => disconnectService('GMAIL')} variant="outline">
                  Disconnect
                </Button>
              ) : (
                <Button onClick={connectGmail}>
                  <Mail className="mr-2 h-4 w-4" />
                  Connect Gmail
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* FreeAgent Connection */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-green-100 dark:bg-green-900">
                <TrendingUp className="h-6 w-6 text-green-600 dark:text-green-400" />
              </div>
              <div className="flex-1">
                <CardTitle>FreeAgent</CardTitle>
                <CardDescription>Match invoices to transactions and bills</CardDescription>
              </div>
              {freeagentStatus.connected ? (
                <Badge variant="default" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Not Connected
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {freeagentStatus.connected && freeagentStatus.email && (
              <div className="rounded-lg bg-muted p-3">
                <p className="text-sm text-muted-foreground">Connected as</p>
                <p className="text-sm font-medium">{freeagentStatus.email}</p>
              </div>
            )}
            <div className="flex gap-2">
              {freeagentStatus.connected ? (
                <Button onClick={() => disconnectService('FREEAGENT')} variant="outline">
                  Disconnect
                </Button>
              ) : (
                <Button onClick={connectFreeAgent}>
                  <TrendingUp className="mr-2 h-4 w-4" />
                  Connect FreeAgent
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Setup Instructions */}
      {(!gmailStatus.connected || !freeagentStatus.connected) && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="space-y-3">
              <p className="font-semibold">Setup Required</p>
              <p>Before connecting, you need to configure OAuth credentials:</p>
              <ol className="list-decimal list-inside space-y-2 ml-2">
                <li>
                  <strong>Gmail:</strong> Create OAuth credentials in the{' '}
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Google Cloud Console
                  </a>
                </li>
                <li>
                  <strong>FreeAgent:</strong> Register your app at the{' '}
                  <a
                    href="https://dev.freeagent.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    FreeAgent Developer Dashboard
                  </a>
                </li>
              </ol>
              <p className="text-sm">
                Set the environment variables{' '}
                <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                  NEXT_PUBLIC_GOOGLE_CLIENT_ID
                </code>{' '}
                and{' '}
                <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                  NEXT_PUBLIC_FREEAGENT_CLIENT_ID
                </code>{' '}
                in your deployment.
              </p>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
