/**
 * @file amplify/functions/gmail-poller/gmail-client.ts
 * @description Gmail API client for fetching emails with attachments
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
  UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';

interface GmailTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

interface GmailMessageHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  partId: string;
  mimeType: string;
  filename: string;
  body: {
    attachmentId?: string;
    size: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  payload: {
    headers: GmailMessageHeader[];
    mimeType: string;
    parts?: GmailMessagePart[];
    body?: {
      attachmentId?: string;
      size: number;
      data?: string;
    };
  };
}

interface GmailAttachment {
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  data?: Buffer;
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class GmailClient {
  private secretsClient: SecretsManagerClient;
  private secretArn: string;
  private tokens: GmailTokens | null = null;
  private clientId: string;
  private clientSecret: string;

  constructor(secretArn: string, clientId: string, clientSecret: string) {
    this.secretsClient = new SecretsManagerClient({});
    this.secretArn = secretArn;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  /**
   * Load tokens from Secrets Manager
   */
  private async loadTokens(): Promise<GmailTokens> {
    if (this.tokens) {
      return this.tokens;
    }

    const command = new GetSecretValueCommand({
      SecretId: this.secretArn,
    });

    const response = await this.secretsClient.send(command);
    if (!response.SecretString) {
      throw new Error('No secret string found');
    }

    this.tokens = JSON.parse(response.SecretString) as GmailTokens;
    return this.tokens;
  }

  /**
   * Refresh access token if expired
   */
  private async refreshTokenIfNeeded(): Promise<string> {
    let tokens = await this.loadTokens();
    const expiresAt = new Date(tokens.expiresAt);
    const now = new Date();

    // Refresh if token expires in less than 5 minutes
    if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: tokens.refreshToken,
          grant_type: 'refresh_token',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
      }

      const data = (await response.json()) as {
        access_token: string;
        expires_in: number;
      };

      // Update tokens
      const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
      tokens = {
        accessToken: data.access_token,
        refreshToken: tokens.refreshToken,
        expiresAt: newExpiresAt,
      };
      this.tokens = tokens;

      // Save updated tokens to Secrets Manager
      await this.secretsClient.send(
        new UpdateSecretCommand({
          SecretId: this.secretArn,
          SecretString: JSON.stringify(tokens),
        })
      );
    }

    return tokens.accessToken;
  }

  /**
   * Make authenticated request to Gmail API
   */
  private async gmailRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const accessToken = await this.refreshTokenIfNeeded();

    const response = await fetch(`${GMAIL_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gmail API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * List messages with attachments since a given date
   */
  async listMessagesWithAttachments(
    sinceDate?: Date,
    maxResults = 50,
    beforeDate?: Date
  ): Promise<Array<{ id: string; threadId: string }>> {
    const query: string[] = ['has:attachment'];

    // Filter for PDF and image attachments
    query.push('(filename:pdf OR filename:png OR filename:jpg OR filename:jpeg)');

    // Filter by date if provided
    if (sinceDate) {
      const dateStr = sinceDate.toISOString().split('T')[0].replace(/-/g, '/');
      query.push(`after:${dateStr}`);
    }

    // Filter by end date if provided
    if (beforeDate) {
      const dateStr = beforeDate.toISOString().split('T')[0].replace(/-/g, '/');
      query.push(`before:${dateStr}`);
    }

    const queryStr = encodeURIComponent(query.join(' '));
    console.log(`Gmail query: ${query.join(' ')}`);
    console.log(`Gmail API URL: /users/me/messages?q=${queryStr}&maxResults=${maxResults}`);

    const response = await this.gmailRequest<GmailListResponse>(
      `/users/me/messages?q=${queryStr}&maxResults=${maxResults}`
    );

    console.log(
      `Gmail response: ${response.messages?.length ?? 0} messages, resultSizeEstimate: ${response.resultSizeEstimate}`
    );
    return response.messages ?? [];
  }

  /**
   * Get full message details
   */
  async getMessage(messageId: string): Promise<GmailMessage> {
    return this.gmailRequest<GmailMessage>(`/users/me/messages/${messageId}?format=full`);
  }

  /**
   * Extract attachment metadata from a message
   */
  extractAttachments(message: GmailMessage): GmailAttachment[] {
    const attachments: GmailAttachment[] = [];

    const processPayload = (parts: GmailMessagePart[] | undefined) => {
      if (!parts) return;

      for (const part of parts) {
        // Check if this part has an attachment
        if (part.filename && part.body?.attachmentId) {
          const mimeType = part.mimeType.toLowerCase();
          const filename = part.filename.toLowerCase();

          // Check if it's a PDF or image
          // AWS sends PDFs with application/octet-stream, so also check filename extension
          const isPdf =
            mimeType === 'application/pdf' ||
            (mimeType === 'application/octet-stream' && filename.endsWith('.pdf'));
          const isImage = mimeType.startsWith('image/');

          if (isPdf || isImage) {
            attachments.push({
              messageId: message.id,
              attachmentId: part.body.attachmentId,
              filename: part.filename,
              mimeType: part.mimeType,
              size: part.body.size,
            });
          }
        }

        // Recurse into nested parts
        if (part.parts) {
          processPayload(part.parts);
        }
      }
    };

    processPayload(message.payload.parts);
    return attachments;
  }

  /**
   * Download attachment data
   */
  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const response = await this.gmailRequest<{ data: string; size: number }>(
      `/users/me/messages/${messageId}/attachments/${attachmentId}`
    );

    // Gmail returns base64url encoded data
    const base64 = response.data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64');
  }

  /**
   * Get sender email from message headers
   */
  getSenderEmail(message: GmailMessage): string | undefined {
    const fromHeader = message.payload.headers.find((h) => h.name.toLowerCase() === 'from');
    if (!fromHeader) return undefined;

    // Extract email from "Name <email@domain.com>" format
    const match = fromHeader.value.match(/<([^>]+)>/) ?? fromHeader.value.match(/([^\s]+@[^\s]+)/);
    return match?.[1] ?? fromHeader.value;
  }

  /**
   * Add label to message (e.g., mark as processed)
   */
  async addLabel(messageId: string, labelId: string): Promise<void> {
    await this.gmailRequest(`/users/me/messages/${messageId}/modify`, {
      method: 'POST',
      body: JSON.stringify({
        addLabelIds: [labelId],
      }),
    });
  }
}
