/**
 * @file amplify/backend.ts
 * @description Main Amplify Gen2 backend definition for FreeAgent Invoice Matching Agent
 */

import { defineBackend, secret } from '@aws-amplify/backend';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import {
  attachAIPermissions,
  attachLambdaInvokePermissions,
  attachS3Permissions,
  attachSecretsManagerPermissions,
} from './ai-permissions';
import { auth } from './auth/resource';
import { createInvoiceProcessorStateMachine } from './cdk/invoice-processor-sfn';
import { data } from './data/resource';
import { approveMatch } from './functions/approve-match/resource';
import { bedrockEnhance } from './functions/bedrock-enhance/resource';
import { freeagentCategories } from './functions/freeagent-categories/resource';
import { freeagentSync } from './functions/freeagent-sync/resource';
import { gmailPoller } from './functions/gmail-poller/resource';
import { invoiceProcessor } from './functions/invoice-processor/resource';
import { matcher } from './functions/matcher/resource';
import { oauthTokenStore } from './functions/oauth-token-store/resource';
import { textractRequest } from './functions/textract-request/resource';
import { textractRetrieve } from './functions/textract-retrieve/resource';
import { storage } from './storage/resource';

/**
 * Define backend resources
 */
const backend = defineBackend({
  auth,
  data,
  storage,
  gmailPoller,
  invoiceProcessor, // Keep for backward compatibility, will be deprecated
  freeagentSync,
  freeagentCategories,
  matcher,
  approveMatch,
  oauthTokenStore,
  // New Step Functions-based Lambda functions
  textractRequest,
  textractRetrieve,
  bedrockEnhance,
});

/**
 * Get the backend stack for adding CDK resources
 */
const backendStack = backend.data.stack;

/**
 * Get Lambda function references
 */
const gmailPollerLambda = backend.gmailPoller.resources.lambda as NodejsFunction;
const invoiceProcessorLambda = backend.invoiceProcessor.resources.lambda as NodejsFunction;
const freeagentSyncLambda = backend.freeagentSync.resources.lambda as NodejsFunction;
const freeagentCategoriesLambda = backend.freeagentCategories.resources.lambda as NodejsFunction;
const matcherLambda = backend.matcher.resources.lambda as NodejsFunction;
const approveMatchLambda = backend.approveMatch.resources.lambda as NodejsFunction;
const oauthTokenStoreLambda = backend.oauthTokenStore.resources.lambda as NodejsFunction;
// New Step Functions Lambda functions
const textractRequestLambda = backend.textractRequest.resources.lambda as NodejsFunction;
const textractRetrieveLambda = backend.textractRetrieve.resources.lambda as NodejsFunction;
const bedrockEnhanceLambda = backend.bedrockEnhance.resources.lambda as NodejsFunction;

/**
 * Helper to safely get Lambda role (throws if undefined)
 */
function getLambdaRole(lambda: NodejsFunction, name: string): iam.IRole {
  const role = lambda.role;
  if (!role) {
    throw new Error(`Lambda ${name} does not have an IAM role`);
  }
  return role;
}

// Get roles for permission attachment
const gmailPollerRole = getLambdaRole(gmailPollerLambda, 'gmailPoller');
const invoiceProcessorRole = getLambdaRole(invoiceProcessorLambda, 'invoiceProcessor');
const freeagentSyncRole = getLambdaRole(freeagentSyncLambda, 'freeagentSync');
const freeagentCategoriesRole = getLambdaRole(freeagentCategoriesLambda, 'freeagentCategories');
const matcherRole = getLambdaRole(matcherLambda, 'matcher');
const approveMatchRole = getLambdaRole(approveMatchLambda, 'approveMatch');
const oauthTokenStoreRole = getLambdaRole(oauthTokenStoreLambda, 'oauthTokenStore');
// New Step Functions Lambda roles
const textractRequestRole = getLambdaRole(textractRequestLambda, 'textractRequest');
const textractRetrieveRole = getLambdaRole(textractRetrieveLambda, 'textractRetrieve');
const bedrockEnhanceRole = getLambdaRole(bedrockEnhanceLambda, 'bedrockEnhance');

/**
 * Get storage bucket ARN
 */
const storageBucketArn = backend.storage.resources.bucket.bucketArn;
const storageBucketName = backend.storage.resources.bucket.bucketName;

// ============================================================================
// Allow Textract service principal to access Amplify storage bucket directly
// ============================================================================

backend.storage.resources.bucket.addToResourcePolicy(
  new iam.PolicyStatement({
    sid: 'AllowTextractServicePrincipalRead',
    effect: iam.Effect.ALLOW,
    principals: [new iam.ServicePrincipal('textract.amazonaws.com')],
    actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectAcl'],
    resources: [`${storageBucketArn}/*`],
  })
);

backend.storage.resources.bucket.addToResourcePolicy(
  new iam.PolicyStatement({
    sid: 'AllowTextractServicePrincipalList',
    effect: iam.Effect.ALLOW,
    principals: [new iam.ServicePrincipal('textract.amazonaws.com')],
    actions: ['s3:ListBucket', 's3:GetBucketLocation'],
    resources: [storageBucketArn],
  })
);

// ============================================================================
// Step Functions Infrastructure (SNS Topic, IAM Role, State Machine)
// ============================================================================

// SNS topic for Textract async job completion notifications
const textractNotificationTopic = new sns.Topic(backendStack, 'TextractNotificationTopic', {
  topicName: 'freeagent-bot-textract-notifications',
  displayName: 'Textract Job Notifications',
});

// Create a dedicated IAM role for Textract to assume
// This role must be assumable by textract.amazonaws.com and needs BOTH S3 and SNS permissions
const textractSnsRole = new iam.Role(backendStack, 'TextractSnsRole', {
  assumedBy: new iam.ServicePrincipal('textract.amazonaws.com'),
  description: 'Role for Textract to access S3 and publish SNS notifications',
});

// Grant the Textract role FULL S3 permissions on the storage bucket
// This is CRITICAL - Textract uses this role to read from S3!
// Using s3:* as per working ordo-next-ts project
textractSnsRole.addToPolicy(
  new iam.PolicyStatement({
    sid: 'AllowTextractS3Access',
    effect: iam.Effect.ALLOW,
    actions: ['s3:*'],
    resources: [storageBucketArn, `${storageBucketArn}/*`],
  })
);

// Grant the Textract SNS role permission to publish to the SNS topic
textractNotificationTopic.grantPublish(textractSnsRole);

// Grant Textract service permission to publish to SNS topic (belt and suspenders)
textractNotificationTopic.addToResourcePolicy(
  new iam.PolicyStatement({
    sid: 'AllowTextractPublish',
    effect: iam.Effect.ALLOW,
    principals: [new iam.ServicePrincipal('textract.amazonaws.com')],
    actions: ['sns:Publish'],
    resources: [textractNotificationTopic.topicArn],
  })
);

// Subscribe textract-retrieve Lambda to SNS topic
textractNotificationTopic.addSubscription(
  new snsSubscriptions.LambdaSubscription(textractRetrieveLambda)
);

// Create the Step Functions state machine
const invoiceStateMachine = createInvoiceProcessorStateMachine(
  backendStack,
  textractRequestLambda,
  bedrockEnhanceLambda,
  matcherLambda
);

// ============================================================================
// Environment Variables for Lambda Functions
// ============================================================================

// Get actual DynamoDB table names from Amplify Data resources
const { tables } = backend.data.resources;

// Common environment variables with actual table names
const commonEnvVars = {
  OAUTH_TABLE: tables.OAuthConnection.tableName,
  INVOICE_TABLE: tables.Invoice.tableName,
  TRANSACTION_TABLE: tables.Transaction.tableName,
  MATCH_TABLE: tables.Match.tableName,
  SETTINGS_TABLE: tables.UserSettings.tableName,
  STORAGE_BUCKET_NAME: backend.storage.resources.bucket.bucketName,
};

// Gmail Poller environment
gmailPollerLambda.addEnvironment('OAUTH_TABLE', commonEnvVars.OAUTH_TABLE);
gmailPollerLambda.addEnvironment('INVOICE_TABLE', commonEnvVars.INVOICE_TABLE);
gmailPollerLambda.addEnvironment('SETTINGS_TABLE', commonEnvVars.SETTINGS_TABLE);
gmailPollerLambda.addEnvironment('STORAGE_BUCKET_NAME', commonEnvVars.STORAGE_BUCKET_NAME);
gmailPollerLambda.addEnvironment('INVOICE_PROCESSOR_ARN', invoiceProcessorLambda.functionArn); // Legacy
gmailPollerLambda.addEnvironment('INVOICE_STATE_MACHINE_ARN', invoiceStateMachine.stateMachineArn); // New
// Google OAuth credentials from Amplify secrets
backend.gmailPoller.addEnvironment('GOOGLE_CLIENT_ID', secret('GOOGLE_CLIENT_ID'));
backend.gmailPoller.addEnvironment('GOOGLE_CLIENT_SECRET', secret('GOOGLE_CLIENT_SECRET'));

// Invoice Processor environment
invoiceProcessorLambda.addEnvironment('INVOICE_TABLE', commonEnvVars.INVOICE_TABLE);
invoiceProcessorLambda.addEnvironment('STORAGE_BUCKET_NAME', commonEnvVars.STORAGE_BUCKET_NAME);
invoiceProcessorLambda.addEnvironment('MATCHER_ARN', matcherLambda.functionArn);

// FreeAgent Sync environment
freeagentSyncLambda.addEnvironment('OAUTH_TABLE', commonEnvVars.OAUTH_TABLE);
freeagentSyncLambda.addEnvironment('TRANSACTION_TABLE', commonEnvVars.TRANSACTION_TABLE);
freeagentSyncLambda.addEnvironment('SETTINGS_TABLE', commonEnvVars.SETTINGS_TABLE);
freeagentSyncLambda.addEnvironment('MATCHER_FUNCTION_NAME', matcherLambda.functionName);
// FreeAgent OAuth credentials from Amplify secrets
backend.freeagentSync.addEnvironment('FREEAGENT_CLIENT_ID', secret('FREEAGENT_CLIENT_ID'));
backend.freeagentSync.addEnvironment('FREEAGENT_CLIENT_SECRET', secret('FREEAGENT_CLIENT_SECRET'));
backend.freeagentSync.addEnvironment('FREEAGENT_USE_SANDBOX', secret('FREEAGENT_USE_SANDBOX'));

// FreeAgent Categories environment
freeagentCategoriesLambda.addEnvironment('OAUTH_TABLE', commonEnvVars.OAUTH_TABLE);
backend.freeagentCategories.addEnvironment('FREEAGENT_CLIENT_ID', secret('FREEAGENT_CLIENT_ID'));
backend.freeagentCategories.addEnvironment(
  'FREEAGENT_CLIENT_SECRET',
  secret('FREEAGENT_CLIENT_SECRET')
);
backend.freeagentCategories.addEnvironment(
  'FREEAGENT_USE_SANDBOX',
  secret('FREEAGENT_USE_SANDBOX')
);

// Matcher environment
matcherLambda.addEnvironment('INVOICE_TABLE', commonEnvVars.INVOICE_TABLE);
matcherLambda.addEnvironment('TRANSACTION_TABLE', commonEnvVars.TRANSACTION_TABLE);
matcherLambda.addEnvironment('MATCH_TABLE', commonEnvVars.MATCH_TABLE);
matcherLambda.addEnvironment('SETTINGS_TABLE', commonEnvVars.SETTINGS_TABLE);

// Approve Match environment
approveMatchLambda.addEnvironment('INVOICE_TABLE', commonEnvVars.INVOICE_TABLE);
approveMatchLambda.addEnvironment('TRANSACTION_TABLE', commonEnvVars.TRANSACTION_TABLE);
approveMatchLambda.addEnvironment('MATCH_TABLE', commonEnvVars.MATCH_TABLE);
approveMatchLambda.addEnvironment('OAUTH_TABLE', commonEnvVars.OAUTH_TABLE);
approveMatchLambda.addEnvironment('STORAGE_BUCKET_NAME', commonEnvVars.STORAGE_BUCKET_NAME);
// FreeAgent OAuth credentials from Amplify secrets
backend.approveMatch.addEnvironment('FREEAGENT_CLIENT_ID', secret('FREEAGENT_CLIENT_ID'));
backend.approveMatch.addEnvironment('FREEAGENT_CLIENT_SECRET', secret('FREEAGENT_CLIENT_SECRET'));
backend.approveMatch.addEnvironment('FREEAGENT_USE_SANDBOX', secret('FREEAGENT_USE_SANDBOX'));

// Textract Request environment (async processing with SNS)
textractRequestLambda.addEnvironment('INVOICE_TABLE', commonEnvVars.INVOICE_TABLE);
textractRequestLambda.addEnvironment('STORAGE_BUCKET_NAME', storageBucketName);
textractRequestLambda.addEnvironment('TEXTRACT_SNS_TOPIC_ARN', textractNotificationTopic.topicArn);
textractRequestLambda.addEnvironment('TEXTRACT_SNS_ROLE_ARN', textractSnsRole.roleArn);

// Textract Retrieve environment
textractRetrieveLambda.addEnvironment('INVOICE_TABLE', commonEnvVars.INVOICE_TABLE);

// Bedrock Enhance environment
bedrockEnhanceLambda.addEnvironment('INVOICE_TABLE', commonEnvVars.INVOICE_TABLE);
bedrockEnhanceLambda.addEnvironment('STORAGE_BUCKET_NAME', commonEnvVars.STORAGE_BUCKET_NAME);

// ============================================================================
// IAM Permissions
// ============================================================================

// Gmail Poller permissions
attachSecretsManagerPermissions(backendStack, gmailPollerRole, 'GmailPoller');
attachS3Permissions(backendStack, gmailPollerRole, storageBucketArn, 'GmailPoller');
// Permission to start Step Functions state machine
gmailPollerRole.attachInlinePolicy(
  new iam.Policy(backendStack, 'GmailPollerStepFunctionsPolicy', {
    statements: [
      new iam.PolicyStatement({
        sid: 'AllowStartExecution',
        effect: iam.Effect.ALLOW,
        actions: ['states:StartExecution'],
        resources: [invoiceStateMachine.stateMachineArn],
      }),
    ],
  })
);

// Invoice Processor permissions
attachAIPermissions(backendStack, invoiceProcessorRole, 'InvoiceProcessor');
attachS3Permissions(backendStack, invoiceProcessorRole, storageBucketArn, 'InvoiceProcessor');
attachLambdaInvokePermissions(
  backendStack,
  invoiceProcessorRole,
  [matcherLambda.functionArn],
  'InvoiceProcessor'
);

// FreeAgent Sync permissions
attachSecretsManagerPermissions(backendStack, freeagentSyncRole, 'FreeAgentSync');
// Permission to invoke matcher Lambda for re-matching pending invoices
attachLambdaInvokePermissions(
  backendStack,
  freeagentSyncRole,
  [matcherLambda.functionArn],
  'FreeAgentSync'
);

// FreeAgent Categories permissions (Secrets Manager for OAuth tokens)
attachSecretsManagerPermissions(backendStack, freeagentCategoriesRole, 'FreeAgentCategories');

// Matcher permissions (needs Bedrock for vendor name comparison)
attachAIPermissions(backendStack, matcherRole, 'Matcher');

// Approve Match permissions (S3 for PDF download, Secrets Manager for FreeAgent OAuth)
attachSecretsManagerPermissions(backendStack, approveMatchRole, 'ApproveMatch');
attachS3Permissions(backendStack, approveMatchRole, storageBucketArn, 'ApproveMatch');

// OAuth Token Store permissions (Secrets Manager for storing OAuth tokens)
attachSecretsManagerPermissions(backendStack, oauthTokenStoreRole, 'OAuthTokenStore');

// ============================================================================
// Step Functions Lambda Permissions
// ============================================================================

// Textract Request permissions - Async Textract analysis
textractRequestRole.attachInlinePolicy(
  new iam.Policy(backendStack, 'TextractRequestPolicy', {
    statements: [
      // Async Textract API (StartExpenseAnalysis, StartDocumentAnalysis)
      new iam.PolicyStatement({
        sid: 'AllowAsyncTextractAPIs',
        effect: iam.Effect.ALLOW,
        actions: [
          'textract:StartExpenseAnalysis',
          'textract:StartDocumentAnalysis',
          'textract:StartDocumentTextDetection',
        ],
        resources: ['*'],
      }),
      // S3 permissions - Lambda also needs S3 access (as per ordo-next-ts pattern)
      new iam.PolicyStatement({
        sid: 'AllowS3Access',
        effect: iam.Effect.ALLOW,
        actions: ['s3:*'],
        resources: [storageBucketArn, `${storageBucketArn}/*`],
      }),
      // PassRole to allow Lambda to pass the Textract SNS role
      new iam.PolicyStatement({
        sid: 'AllowPassRoleToTextract',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [textractSnsRole.roleArn],
      }),
    ],
  })
);

// Textract Retrieve permissions - Get async results and send Step Functions callback
textractRetrieveRole.attachInlinePolicy(
  new iam.Policy(backendStack, 'TextractRetrievePolicy', {
    statements: [
      new iam.PolicyStatement({
        sid: 'AllowGetTextractResults',
        effect: iam.Effect.ALLOW,
        actions: [
          'textract:GetExpenseAnalysis',
          'textract:GetDocumentAnalysis',
          'textract:GetDocumentTextDetection',
        ],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        sid: 'AllowSendTaskCallback',
        effect: iam.Effect.ALLOW,
        actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
        resources: [invoiceStateMachine.stateMachineArn],
      }),
    ],
  })
);

// Bedrock Enhance permissions - AI extraction and S3 access
attachAIPermissions(backendStack, bedrockEnhanceRole, 'BedrockEnhance');
attachS3Permissions(backendStack, bedrockEnhanceRole, storageBucketArn, 'BedrockEnhance');

// ============================================================================
// DynamoDB Permissions for all Lambda functions
// ============================================================================

const ddbPermissions = new iam.PolicyStatement({
  sid: 'AllowDynamoDBAccess',
  effect: iam.Effect.ALLOW,
  actions: [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:DeleteItem',
    'dynamodb:Query',
    'dynamodb:Scan',
  ],
  resources: [`arn:aws:dynamodb:*:*:table/*`, `arn:aws:dynamodb:*:*:table/*/index/*`],
});

gmailPollerLambda.addToRolePolicy(ddbPermissions);
invoiceProcessorLambda.addToRolePolicy(ddbPermissions);
freeagentSyncLambda.addToRolePolicy(ddbPermissions);
freeagentCategoriesLambda.addToRolePolicy(ddbPermissions);
matcherLambda.addToRolePolicy(ddbPermissions);
approveMatchLambda.addToRolePolicy(ddbPermissions);
// New Step Functions Lambdas
textractRequestLambda.addToRolePolicy(ddbPermissions);
textractRetrieveLambda.addToRolePolicy(ddbPermissions);
bedrockEnhanceLambda.addToRolePolicy(ddbPermissions);

// ============================================================================
// EventBridge Scheduled Rules
// ============================================================================

// Schedule Gmail polling every 15 minutes
// Note: In production, you'd typically trigger this per-user based on their settings
// For now, this is a placeholder that would need to iterate over all users
const gmailPollSchedule = new events.Rule(backendStack, 'GmailPollSchedule', {
  schedule: events.Schedule.rate(Duration.minutes(15)),
  description: 'Trigger Gmail polling every 15 minutes',
  enabled: false, // Disabled by default - enable after OAuth setup
});

gmailPollSchedule.addTarget(
  new targets.LambdaFunction(gmailPollerLambda, {
    retryAttempts: 2,
  })
);

// Schedule FreeAgent sync every 30 minutes
const freeagentSyncSchedule = new events.Rule(backendStack, 'FreeAgentSyncSchedule', {
  schedule: events.Schedule.rate(Duration.minutes(30)),
  description: 'Trigger FreeAgent sync every 30 minutes',
  enabled: false, // Disabled by default - enable after OAuth setup
});

freeagentSyncSchedule.addTarget(
  new targets.LambdaFunction(freeagentSyncLambda, {
    retryAttempts: 2,
  })
);

// ============================================================================
// Stack Outputs
// ============================================================================

new CfnOutput(backendStack, 'GmailPollerArn', {
  value: gmailPollerLambda.functionArn,
  description: 'Gmail Poller Lambda ARN',
});

new CfnOutput(backendStack, 'InvoiceProcessorArn', {
  value: invoiceProcessorLambda.functionArn,
  description: 'Invoice Processor Lambda ARN',
});

new CfnOutput(backendStack, 'FreeAgentSyncArn', {
  value: freeagentSyncLambda.functionArn,
  description: 'FreeAgent Sync Lambda ARN',
});

new CfnOutput(backendStack, 'MatcherArn', {
  value: matcherLambda.functionArn,
  description: 'Matcher Lambda ARN',
});

new CfnOutput(backendStack, 'ApproveMatchArn', {
  value: approveMatchLambda.functionArn,
  description: 'Approve Match Lambda ARN',
});

new CfnOutput(backendStack, 'StorageBucketName', {
  value: backend.storage.resources.bucket.bucketName,
  description: 'Invoice storage S3 bucket name',
});

new CfnOutput(backendStack, 'GmailPollScheduleArn', {
  value: gmailPollSchedule.ruleArn,
  description: 'Gmail poll EventBridge rule ARN (enable after OAuth setup)',
});

new CfnOutput(backendStack, 'FreeAgentSyncScheduleArn', {
  value: freeagentSyncSchedule.ruleArn,
  description: 'FreeAgent sync EventBridge rule ARN (enable after OAuth setup)',
});

// Step Functions outputs
new CfnOutput(backendStack, 'InvoiceStateMachineArn', {
  value: invoiceStateMachine.stateMachineArn,
  description: 'Invoice Processor Step Functions state machine ARN',
});

new CfnOutput(backendStack, 'TextractNotificationTopicArn', {
  value: textractNotificationTopic.topicArn,
  description: 'Textract SNS notification topic ARN',
});

new CfnOutput(backendStack, 'TextractSnsRoleArn', {
  value: textractSnsRole.roleArn,
  description: 'IAM role ARN for Textract to publish SNS notifications',
});
