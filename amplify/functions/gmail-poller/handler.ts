/**
 * @file amplify/functions/gmail-poller/handler.ts
 * @description Lambda handler for polling Gmail for invoice attachments
 * Uses Amplify Data client to trigger real-time subscriptions
 */

import { createHash } from 'node:crypto';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import type { Handler } from 'aws-lambda';
import { env } from '$amplify/env/gmail-poller';
import type { Schema } from '../../data/resource';
import { GmailClient } from './gmail-client';

// Configure Amplify for Lambda environment
const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
console.log('Amplify configured');

export const dataClient = generateClient<Schema>();
console.log('Generated Amplify Data client');

interface PollEvent {
  userId?: string;
  forceFullScan?: boolean;
  arguments?: {
    userId: string;
    forceFullScan?: boolean;
  };
}

interface SyncResult {
  success: boolean;
  processed?: number;
  invoiceIds?: string[];
  error?: string;
}

interface OAuthConnection {
  userId: string;
  provider: string;
  secretArn: string;
  expiresAt: string;
  email?: string;
}

const s3Client = new S3Client({});
const sfnClient = new SFNClient({});
// Keep DynamoDB client for OAuth reads only
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET_NAME = process.env.STORAGE_BUCKET_NAME ?? '';
const INVOICE_STATE_MACHINE_ARN = process.env.INVOICE_STATE_MACHINE_ARN ?? '';
const OAUTH_TABLE = process.env.OAUTH_TABLE ?? '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';

export const handler: Handler<PollEvent, SyncResult> = async (event) => {
  // Support both direct invocation and GraphQL mutation format
  const userId = event.arguments?.userId ?? event.userId;
  const forceFullScan = event.arguments?.forceFullScan ?? event.forceFullScan ?? false;

  if (!userId) {
    return { success: false, error: 'userId is required' };
  }

  console.log(`Starting Gmail poll for user: ${userId}, forceFullScan: ${forceFullScan}`);

  try {
    // Get OAuth connection for Gmail (id format: "{userId}#GMAIL")
    const oauthResponse = await ddbClient.send(
      new GetCommand({
        TableName: OAUTH_TABLE,
        Key: { id: `${userId}#GMAIL` },
      })
    );

    const oauth = oauthResponse.Item as OAuthConnection | undefined;
    if (!oauth) {
      console.log('No Gmail OAuth connection found for user');
      return { success: false, processed: 0, error: 'No Gmail connection' };
    }

    // Initialize Gmail client
    const gmailClient = new GmailClient(oauth.secretArn, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

    // Get user settings for last poll time using Amplify
    const { data: settings } = await dataClient.models.UserSettings.get({ userId });

    // Determine date range for fetching messages
    let lastPollDate: Date;
    if (forceFullScan || !settings?.lastGmailPollAt) {
      // First run or force scan: go back 30 days
      lastPollDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      console.log('Scanning last 30 days (force scan or first run)');
    } else {
      lastPollDate = new Date(settings.lastGmailPollAt);
      console.log(`Scanning since last poll: ${lastPollDate.toISOString()}`);
    }

    // List messages with attachments since last poll
    console.log('Fetching messages with attachments from Gmail...');
    const messages = await gmailClient.listMessagesWithAttachments(lastPollDate);
    console.log(`Found ${messages.length} messages with attachments`);

    let processedCount = 0;
    const invoicesToProcess: Map<string, string> = new Map(); // invoiceId -> s3Key

    // Process regular attachment emails
    for (const messageRef of messages) {
      try {
        console.log(`[${messageRef.id}] Checking if already processed...`);

        // Check if we've already processed this message
        // Note: Don't use limit with filter - DynamoDB applies limit BEFORE filter on scans
        const { data: existingInvoices } = await dataClient.models.Invoice.list({
          filter: {
            gmailMessageId: { eq: messageRef.id },
          },
        });

        if (existingInvoices && existingInvoices.length > 0) {
          console.log(`[${messageRef.id}] Skipping already processed message`);
          continue;
        }

        console.log(`[${messageRef.id}] Fetching message details from Gmail...`);
        // Get full message details
        const message = await gmailClient.getMessage(messageRef.id);
        const attachments = gmailClient.extractAttachments(message);
        const senderEmail = gmailClient.getSenderEmail(message);

        console.log(
          `[${messageRef.id}] Found ${attachments.length} attachments from ${senderEmail}`
        );

        for (const attachment of attachments) {
          console.log(`[${messageRef.id}] Downloading attachment: ${attachment.filename}`);
          // Download attachment
          const data = await gmailClient.getAttachment(
            attachment.messageId,
            attachment.attachmentId
          );
          console.log(`[${messageRef.id}] Downloaded ${data.length} bytes`);

          // Generate S3 key
          const timestamp = Date.now();
          const safeFilename = attachment.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
          const s3Key = `invoices/${userId}/${timestamp}-${safeFilename}`;

          console.log(`[${messageRef.id}] Uploading to S3: ${s3Key}`);

          // Determine correct ContentType from filename extension
          let contentType = attachment.mimeType;
          const lowerFilename = attachment.filename.toLowerCase();
          if (lowerFilename.endsWith('.pdf')) {
            contentType = 'application/pdf';
          } else if (lowerFilename.endsWith('.png')) {
            contentType = 'image/png';
          } else if (lowerFilename.endsWith('.jpg') || lowerFilename.endsWith('.jpeg')) {
            contentType = 'image/jpeg';
          }

          // Upload to S3
          await s3Client.send(
            new PutObjectCommand({
              Bucket: BUCKET_NAME,
              Key: s3Key,
              Body: data,
              ContentType: contentType,
              Metadata: {
                gmailMessageId: messageRef.id,
                attachmentId: attachment.attachmentId,
                originalFilename: attachment.filename,
              },
            })
          );
          console.log(`[${messageRef.id}] S3 upload complete`);

          // Create invoice record using Amplify Data client (triggers subscriptions)
          const { data: created, errors: createErrors } = await dataClient.models.Invoice.create({
            userId,
            gmailMessageId: messageRef.id,
            attachmentId: attachment.attachmentId,
            s3Key,
            senderEmail,
            receivedAt: new Date(Number.parseInt(message.internalDate, 10)).toISOString(),
            status: 'PENDING',
            processingStep: 'PENDING',
          });

          if (createErrors) {
            console.error(
              `[${messageRef.id}] Create errors:`,
              JSON.stringify(createErrors, null, 2)
            );
            continue;
          }

          const invoiceId = created?.id;
          if (invoiceId) {
            invoicesToProcess.set(invoiceId, s3Key);
            processedCount++;
            console.log(`[${messageRef.id}] SUCCESS - Invoice created: ${invoiceId}`);
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : 'Unknown';
        console.error(`[${messageRef.id}] FAILED - ${errorName}: ${errorMessage}`);
        if (error instanceof Error && error.stack) {
          console.error(`[${messageRef.id}] Stack:`, error.stack);
        }
      }
    }

    // Update last poll time using Amplify
    try {
      const now = new Date().toISOString();
      if (settings) {
        await dataClient.models.UserSettings.update({
          userId,
          lastGmailPollAt: now,
        });
      } else {
        await dataClient.models.UserSettings.create({
          userId,
          lastGmailPollAt: now,
        });
      }
    } catch (error) {
      console.error('Error updating user settings:', error);
    }

    // Start Step Functions executions with aggressive throttling to respect Textract limits
    const DELAY_BETWEEN_STARTS_MS = 3000;
    const invoiceArray = Array.from(invoicesToProcess.entries());

    console.log(
      `Starting ${invoiceArray.length} Step Functions executions with ${DELAY_BETWEEN_STARTS_MS}ms delays...`
    );

    for (let i = 0; i < invoiceArray.length; i++) {
      const [invoiceId, s3Key] = invoiceArray[i];

      if (INVOICE_STATE_MACHINE_ARN) {
        try {
          const hash = createHash('md5').update(invoiceId).digest('hex').substring(0, 16);
          const timestamp = Date.now();
          const executionName = `inv-${hash}-${timestamp}`;

          const execution = await sfnClient.send(
            new StartExecutionCommand({
              stateMachineArn: INVOICE_STATE_MACHINE_ARN,
              name: executionName,
              input: JSON.stringify({
                invoiceId,
                userId,
                s3Key,
                bucketName: BUCKET_NAME,
              }),
            })
          );

          // Update invoice with execution ARN using Amplify (triggers subscriptions)
          const { errors: updateErrors } = await dataClient.models.Invoice.update({
            id: invoiceId,
            stepFunctionExecutionArn: execution.executionArn,
          });

          if (updateErrors) {
            console.error(`Update errors for ${invoiceId}:`, JSON.stringify(updateErrors, null, 2));
          }

          console.log(
            `[${i + 1}/${invoiceArray.length}] Started Step Functions execution for ${invoiceId}: ${execution.executionArn}`
          );
        } catch (sfnError) {
          console.error(`Failed to start Step Functions execution for ${invoiceId}:`, sfnError);
        }
      }

      // Add delay between starts (except for the last one)
      if (i < invoiceArray.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_STARTS_MS));
      }
    }

    console.log(`Gmail poll complete. Processed ${processedCount} attachments.`);

    return {
      success: true,
      processed: processedCount,
      invoiceIds: Array.from(invoicesToProcess.keys()),
    };
  } catch (error) {
    console.error('Gmail poll failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};
