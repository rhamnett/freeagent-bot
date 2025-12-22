/**
 * @file amplify/data/resource.ts
 * @description AppSync GraphQL API schema with DynamoDB models for FreeAgent Invoice Matching
 */

import { a, type ClientSchema, defineData } from '@aws-amplify/backend';
import { freeagentSync } from '../functions/freeagent-sync/resource';
import { gmailPoller } from '../functions/gmail-poller/resource';
import { oauthTokenStore } from '../functions/oauth-token-store/resource';

const schema = a.schema({
  // ============================================================================
  // Custom types for OAuth token exchange responses
  // ============================================================================
  TokenStoreResult: a.customType({
    success: a.boolean().required(),
    secretArn: a.string(),
    email: a.string(),
    expiresAt: a.string(),
    error: a.string(),
  }),
  SyncResult: a.customType({
    success: a.boolean().required(),
    processed: a.integer(),
    invoiceIds: a.string().array(),
    bankTransactions: a.integer(),
    bills: a.integer(),
    error: a.string(),
  }),
  // ============================================================================
  // Enum definitions
  // ============================================================================
  OAuthProvider: a.enum(['GMAIL', 'FREEAGENT']),
  InvoiceStatus: a.enum(['PENDING', 'EXTRACTED', 'MATCHED', 'APPROVED', 'FAILED']),
  ProcessingStep: a.enum([
    'PENDING',
    'TEXTRACT_STARTED',
    'TEXTRACT_COMPLETE',
    'BEDROCK_ENHANCE',
    'EXTRACTED',
    'MATCHING',
    'COMPLETE',
    'FAILED',
  ]),
  TransactionType: a.enum(['BANK_TRANSACTION', 'BILL']),
  MatchStatus: a.enum(['PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED']),
  JobType: a.enum(['GMAIL_POLL', 'FREEAGENT_SYNC', 'MATCHING']),
  JobStatus: a.enum(['RUNNING', 'COMPLETED', 'FAILED']),

  // ============================================================================
  // OAuth connection metadata (tokens stored in Secrets Manager)
  // Composite key: "{userId}#{provider}" e.g. "abc123#GMAIL"
  // ============================================================================
  OAuthConnection: a
    .model({
      id: a.string().required(), // Composite key: "{userId}#{provider}"
      userId: a.string().required(),
      provider: a.ref('OAuthProvider').required(),
      secretArn: a.string().required(),
      expiresAt: a.datetime().required(),
      email: a.string(),
      lastRefreshedAt: a.datetime(),
    })
    .identifier(['id'])
    .secondaryIndexes((index) => [index('userId').name('byUserId')])
    .authorization((allow) => [allow.owner()]),

  // ============================================================================
  // Extracted invoices from Gmail attachments
  // ============================================================================
  Invoice: a
    .model({
      userId: a.string().required(),
      gmailMessageId: a.string().required(),
      attachmentId: a.string(),
      s3Key: a.string(),
      senderEmail: a.string(),
      receivedAt: a.datetime(),
      // Extracted fields from Textract/Bedrock
      vendorName: a.string(),
      invoiceNumber: a.string(),
      invoiceDate: a.date(),
      dueDate: a.date(),
      totalAmount: a.float(),
      currency: a.string(),
      lineItems: a.json(),
      // Processing state
      status: a.ref('InvoiceStatus'),
      extractionConfidence: a.float(),
      rawTextractOutput: a.json(),
      // Step Functions async processing fields
      taskToken: a.string(), // Step Functions task token for callback
      textractJobId: a.string(), // Textract async job ID
      processingStep: a.ref('ProcessingStep'), // Current step in the workflow
      stepFunctionExecutionArn: a.string(), // ARN of the Step Functions execution
    })
    .secondaryIndexes((index) => [
      index('gmailMessageId').name('byGmailMessageId'),
      index('textractJobId').name('byTextractJobId'),
    ])
    .authorization((allow) => [allow.owner()]),

  // ============================================================================
  // FreeAgent transactions cache (bank transactions + bills)
  // ============================================================================
  Transaction: a
    .model({
      userId: a.string().required(),
      freeagentUrl: a.string().required(),
      type: a.ref('TransactionType'),
      amount: a.float().required(),
      date: a.date().required(),
      description: a.string(),
      unexplainedAmount: a.float(),
      contactName: a.string(),
      status: a.string(), // Open, Overdue, Paid, etc.
      lastSyncedAt: a.datetime(),
    })
    .secondaryIndexes((index) => [
      index('freeagentUrl').name('byFreeagentUrl'),
      index('userId').sortKeys(['type']).name('byUserIdAndType'),
    ])
    .authorization((allow) => [allow.owner()]),

  // ============================================================================
  // Match proposals between invoices and transactions
  // ============================================================================
  Match: a
    .model({
      userId: a.string().required(),
      invoiceId: a.string().required(),
      transactionId: a.string().required(),
      confidenceScore: a.float().required(),
      matchReasons: a.string().array(),
      status: a.ref('MatchStatus'),
      reviewedAt: a.datetime(),
    })
    .secondaryIndexes((index) => [
      index('invoiceId').name('byInvoiceId'),
      index('transactionId').name('byTransactionId'),
    ])
    .authorization((allow) => [allow.owner()]),

  // ============================================================================
  // Processing jobs for tracking async operations
  // ============================================================================
  ProcessingJob: a
    .model({
      userId: a.string().required(),
      type: a.ref('JobType'),
      status: a.ref('JobStatus'),
      startedAt: a.datetime(),
      completedAt: a.datetime(),
      itemsProcessed: a.integer(),
      errors: a.json(),
    })
    .authorization((allow) => [allow.owner()]),

  // ============================================================================
  // User settings for polling frequency and thresholds
  // ============================================================================
  UserSettings: a
    .model({
      userId: a.string().required(),
      pollingFrequencyMinutes: a.integer().default(15),
      autoApproveThreshold: a.float().default(0.85),
      reviewThreshold: a.float().default(0.5),
      lastGmailPollAt: a.datetime(),
      lastFreeAgentSyncAt: a.datetime(),
    })
    .identifier(['userId'])
    .authorization((allow) => [allow.owner()]),

  // ============================================================================
  // Custom mutations for OAuth token exchange (invokes Lambda)
  // ============================================================================
  exchangeGmailToken: a
    .mutation()
    .arguments({
      code: a.string().required(),
      redirectUri: a.string().required(),
      userId: a.string().required(),
      provider: a.string().required(), // "GMAIL"
    })
    .returns(a.ref('TokenStoreResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(oauthTokenStore)),

  exchangeFreeAgentToken: a
    .mutation()
    .arguments({
      code: a.string().required(),
      redirectUri: a.string().required(),
      userId: a.string().required(),
      provider: a.string().required(), // "FREEAGENT"
    })
    .returns(a.ref('TokenStoreResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(oauthTokenStore)),

  // ============================================================================
  // Manual sync triggers (invokes Lambda functions)
  // ============================================================================
  triggerGmailSync: a
    .mutation()
    .arguments({
      userId: a.string().required(),
      forceFullScan: a.boolean(),
    })
    .returns(a.ref('SyncResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(gmailPoller)),

  triggerFreeAgentSync: a
    .mutation()
    .arguments({
      userId: a.string().required(),
    })
    .returns(a.ref('SyncResult'))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(freeagentSync)),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
    apiKeyAuthorizationMode: {
      expiresInDays: 30,
    },
  },
});
