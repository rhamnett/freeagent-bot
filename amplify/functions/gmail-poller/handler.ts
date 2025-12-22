/**
 * @file amplify/functions/gmail-poller/handler.ts
 * @description Lambda handler for polling Gmail for invoice attachments
 */

import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Handler } from 'aws-lambda';
import { GmailClient } from './gmail-client';

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

interface UserSettings {
  userId: string;
  lastGmailPollAt?: string;
}

interface Invoice {
  id: string;
  userId: string;
  gmailMessageId: string;
  attachmentId: string;
  s3Key: string;
  senderEmail?: string;
  receivedAt: string;
  status: string;
  processingStep: string;
  stepFunctionExecutionArn?: string;
  createdAt: string;
  updatedAt: string;
  owner: string;
}

const s3Client = new S3Client({});
const sfnClient = new SFNClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET_NAME = process.env.STORAGE_BUCKET_NAME ?? '';
const INVOICE_STATE_MACHINE_ARN = process.env.INVOICE_STATE_MACHINE_ARN ?? '';
const OAUTH_TABLE = process.env.OAUTH_TABLE ?? '';
const INVOICE_TABLE = process.env.INVOICE_TABLE ?? '';
const SETTINGS_TABLE = process.env.SETTINGS_TABLE ?? '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';

export const handler: Handler<PollEvent, SyncResult> = async (event) => {
  // Support both direct invocation and GraphQL mutation format
  const userId = event.arguments?.userId ?? event.userId;
  const forceFullScan = event.arguments?.forceFullScan ?? event.forceFullScan ?? false;

  if (!userId) {
    return { success: false, error: 'userId is required' };
  }

  console.log(`Starting Gmail poll for user: ${userId}`);

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

    // Get user settings for last poll time
    const settingsResponse = await ddbClient.send(
      new GetCommand({
        TableName: SETTINGS_TABLE,
        Key: { userId },
      })
    );

    const settings = settingsResponse.Item as UserSettings | undefined;
    console.log('User settings:', JSON.stringify(settings));
    console.log('Force full scan:', forceFullScan);

    // If forceFullScan is true, ignore lastGmailPollAt and scan back 30 days
    // This ensures we capture older invoices like AWS invoices from early Dec
    const lastPollDate = forceFullScan
      ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      : settings?.lastGmailPollAt
        ? new Date(settings.lastGmailPollAt)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default to 30 days ago

    console.log(`Querying Gmail for messages since: ${lastPollDate.toISOString()}`);

    // Initialize Gmail client
    const gmailClient = new GmailClient(oauth.secretArn, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);

    // List messages with attachments since last poll
    const messages = await gmailClient.listMessagesWithAttachments(lastPollDate, 50);

    console.log(`Found ${messages.length} messages with attachments`);

    let processedCount = 0;
    const invoicesToProcess: Map<string, string> = new Map(); // invoiceId -> s3Key

    for (const messageRef of messages) {
      try {
        console.log(`[${messageRef.id}] Checking if already processed...`);

        // Check if we've already processed this message
        const existingInvoice = await ddbClient.send(
          new QueryCommand({
            TableName: INVOICE_TABLE,
            IndexName: 'byGmailMessageId',
            KeyConditionExpression: 'gmailMessageId = :msgId',
            ExpressionAttributeValues: {
              ':msgId': messageRef.id,
            },
            Limit: 1,
          })
        );

        if (existingInvoice.Items && existingInvoice.Items.length > 0) {
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
          // Gmail sometimes reports PDFs as application/octet-stream, so use filename
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

          // Create invoice record
          const invoiceId = `${userId}-${timestamp}-${attachment.attachmentId.slice(0, 8)}`;
          const now = new Date().toISOString();

          const invoice: Invoice = {
            id: invoiceId,
            userId,
            gmailMessageId: messageRef.id,
            attachmentId: attachment.attachmentId,
            s3Key,
            senderEmail,
            receivedAt: new Date(parseInt(message.internalDate, 10)).toISOString(),
            status: 'PENDING',
            processingStep: 'PENDING',
            createdAt: now,
            updatedAt: now,
            owner: userId,
          };

          console.log(`[${messageRef.id}] Creating invoice record: ${invoiceId}`);
          await ddbClient.send(
            new PutCommand({
              TableName: INVOICE_TABLE,
              Item: invoice,
            })
          );

          invoicesToProcess.set(invoiceId, s3Key);
          processedCount++;

          console.log(`[${messageRef.id}] SUCCESS - Invoice created: ${invoiceId}`);
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

    // Update last poll time
    await ddbClient.send(
      new UpdateCommand({
        TableName: SETTINGS_TABLE,
        Key: { userId },
        UpdateExpression: 'SET lastGmailPollAt = :now',
        ExpressionAttributeValues: {
          ':now': new Date().toISOString(),
        },
      })
    );

    // Start Step Functions executions with aggressive throttling to respect Textract limits
    // Textract has a limit of ~2 concurrent StartExpenseAnalysis calls per second
    // Process one at a time with delays to avoid overwhelming Textract
    const DELAY_BETWEEN_STARTS_MS = 3000; // 3 seconds between each start
    const invoiceArray = Array.from(invoicesToProcess.entries());
    
    console.log(`Starting ${invoiceArray.length} Step Functions executions with ${DELAY_BETWEEN_STARTS_MS}ms delays...`);
    
    for (let i = 0; i < invoiceArray.length; i++) {
      const [invoiceId, s3Key] = invoiceArray[i];
      
      if (INVOICE_STATE_MACHINE_ARN) {
        try {
          // Create a short, unique execution name (max 80 chars)
          // Format: inv-<hash>-<timestamp>
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

          // Update invoice with execution ARN
          await ddbClient.send(
            new UpdateCommand({
              TableName: INVOICE_TABLE,
              Key: { id: invoiceId },
              UpdateExpression: 'SET stepFunctionExecutionArn = :arn, updatedAt = :now',
              ExpressionAttributeValues: {
                ':arn': execution.executionArn,
                ':now': new Date().toISOString(),
              },
            })
          );

          console.log(
            `[${i + 1}/${invoiceArray.length}] Started Step Functions execution for ${invoiceId}: ${execution.executionArn}`
          );
        } catch (sfnError) {
          console.error(`Failed to start Step Functions execution for ${invoiceId}:`, sfnError);
        }
      }
      
      // Add delay between starts (except for the last one)
      if (i < invoiceArray.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_STARTS_MS));
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
