/**
 * @file amplify/functions/approve-match/handler.ts
 * @description Lambda handler for approving matches and attaching invoice PDFs to FreeAgent
 * Uses Amplify Data client for updates to trigger real-time subscriptions
 */

import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import type { Handler } from 'aws-lambda';
import { env } from '$amplify/env/approve-match';
import type { Schema } from '../../data/resource';
import { FreeAgentClient } from '../freeagent-sync/freeagent-client';

// Configure Amplify for Lambda environment
const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);

const dataClient = generateClient<Schema>();

interface ApproveMatchEvent {
  matchId?: string;
  userId?: string;
  // AppSync wraps arguments in this object
  arguments?: {
    matchId: string;
    userId: string;
  };
}

interface ApproveMatchResult {
  success: boolean;
  matchId?: string;
  error?: string;
  attachmentUploaded?: boolean;
}

interface InvoiceRecord {
  id: string;
  userId: string;
  vendorName?: string;
  s3Key?: string;
  fileName?: string;
}

interface TransactionRecord {
  id: string;
  userId: string;
  freeagentUrl: string;
  type: string;
}

interface MatchRecord {
  id: string;
  userId: string;
  invoiceId: string;
  transactionId: string;
  status: string;
}

interface OAuthConnection {
  userId: string;
  provider: string;
  secretArn: string;
}

const s3Client = new S3Client({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INVOICE_TABLE = process.env.INVOICE_TABLE ?? '';
const TRANSACTION_TABLE = process.env.TRANSACTION_TABLE ?? '';
const MATCH_TABLE = process.env.MATCH_TABLE ?? '';
const OAUTH_TABLE = process.env.OAUTH_TABLE ?? '';
const STORAGE_BUCKET_NAME = process.env.STORAGE_BUCKET_NAME ?? '';
const FREEAGENT_CLIENT_ID = process.env.FREEAGENT_CLIENT_ID ?? '';
const FREEAGENT_CLIENT_SECRET = process.env.FREEAGENT_CLIENT_SECRET ?? '';
const USE_SANDBOX = process.env.FREEAGENT_USE_SANDBOX === 'true';

export const handler: Handler<ApproveMatchEvent, ApproveMatchResult> = async (event) => {
  // Support both direct invocation and GraphQL mutation format
  const matchId = event.arguments?.matchId ?? event.matchId;
  const userId = event.arguments?.userId ?? event.userId;

  if (!matchId || !userId) {
    return { success: false, error: 'matchId and userId are required' };
  }

  console.log(`Approving match: ${matchId} for user: ${userId}`);

  try {
    // Get match record
    const matchResponse = await ddbClient.send(
      new GetCommand({
        TableName: MATCH_TABLE,
        Key: { id: matchId },
      })
    );

    const match = matchResponse.Item as MatchRecord | undefined;
    if (!match) {
      return { success: false, error: 'Match not found' };
    }

    // Verify ownership
    if (match.userId !== userId) {
      return { success: false, error: 'Unauthorized' };
    }

    // Get invoice record
    const invoiceResponse = await ddbClient.send(
      new GetCommand({
        TableName: INVOICE_TABLE,
        Key: { id: match.invoiceId },
      })
    );

    const invoice = invoiceResponse.Item as InvoiceRecord | undefined;
    if (!invoice) {
      return { success: false, error: 'Invoice not found' };
    }

    // Get transaction record
    const transactionResponse = await ddbClient.send(
      new GetCommand({
        TableName: TRANSACTION_TABLE,
        Key: { id: match.transactionId },
      })
    );

    const transaction = transactionResponse.Item as TransactionRecord | undefined;
    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    let attachmentUploaded = false;

    // Only upload attachment if we have an s3Key and it's a bank transaction
    if (invoice.s3Key && transaction.freeagentUrl) {
      try {
        // Get FreeAgent OAuth connection
        const oauthResponse = await ddbClient.send(
          new GetCommand({
            TableName: OAUTH_TABLE,
            Key: { id: `${userId}#FREEAGENT` },
          })
        );

        const oauth = oauthResponse.Item as OAuthConnection | undefined;
        if (!oauth) {
          console.log('No FreeAgent OAuth connection, skipping attachment');
        } else {
          // Download file from S3
          console.log(`Downloading file from S3: ${invoice.s3Key}`);
          const s3Response = await s3Client.send(
            new GetObjectCommand({
              Bucket: STORAGE_BUCKET_NAME,
              Key: invoice.s3Key,
            })
          );

          if (!s3Response.Body) {
            throw new Error('Empty S3 response body');
          }

          // Convert stream to buffer and then to base64
          const chunks: Uint8Array[] = [];
          const stream = s3Response.Body as AsyncIterable<Uint8Array>;
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          const buffer = Buffer.concat(chunks);
          const base64Data = buffer.toString('base64');

          // Determine content type from file extension
          const fileName = invoice.s3Key.split('/').pop() ?? 'invoice.pdf';
          const extension = fileName.split('.').pop()?.toLowerCase();
          let contentType: 'application/x-pdf' | 'image/png' | 'image/jpeg' | 'image/gif' =
            'application/x-pdf';

          if (extension === 'png') {
            contentType = 'image/png';
          } else if (extension === 'jpg' || extension === 'jpeg') {
            contentType = 'image/jpeg';
          } else if (extension === 'gif') {
            contentType = 'image/gif';
          }

          // Initialize FreeAgent client
          const freeagentClient = new FreeAgentClient(
            oauth.secretArn,
            FREEAGENT_CLIENT_ID,
            FREEAGENT_CLIENT_SECRET,
            USE_SANDBOX
          );

          // Upload attachment to FreeAgent
          console.log(`Uploading attachment to FreeAgent transaction: ${transaction.freeagentUrl}`);
          await freeagentClient.approveTransactionWithAttachment(transaction.freeagentUrl, {
            data: base64Data,
            fileName,
            contentType,
            description: `Invoice from ${invoice.vendorName ?? 'vendor'}`,
          });

          attachmentUploaded = true;
          console.log('Attachment uploaded successfully');
        }
      } catch (attachError) {
        console.error('Error uploading attachment:', attachError);
        // Continue with approval even if attachment fails
      }
    }

    // Update match status to APPROVED via Amplify (triggers real-time subscriptions)
    const now = new Date().toISOString();
    const { errors: matchErrors } = await dataClient.models.Match.update({
      id: matchId,
      status: 'APPROVED',
      reviewedAt: now,
    });

    if (matchErrors) {
      console.error('Match update errors:', JSON.stringify(matchErrors, null, 2));
    }

    // Update invoice status to APPROVED via Amplify (triggers real-time subscriptions)
    const { errors: invoiceErrors } = await dataClient.models.Invoice.update({
      id: match.invoiceId,
      status: 'APPROVED',
    });

    if (invoiceErrors) {
      console.error('Invoice update errors:', JSON.stringify(invoiceErrors, null, 2));
    }

    console.log(
      `Match ${matchId} approved successfully, attachment uploaded: ${attachmentUploaded}`
    );

    return {
      success: true,
      matchId,
      attachmentUploaded,
    };
  } catch (error) {
    console.error(`Error approving match ${matchId}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};
