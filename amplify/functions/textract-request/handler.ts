/**
 * @file amplify/functions/textract-request/handler.ts
 * @description Async Textract expense analysis - starts async job directly on storage bucket
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { StartExpenseAnalysisCommand, TextractClient } from '@aws-sdk/client-textract';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Handler } from 'aws-lambda';

interface TextractRequestEvent {
  invoiceId: string;
  userId: string;
  s3Key: string;
  bucketName: string;
  taskToken: string;
}

interface TextractRequestResult {
  jobId: string;
  taskToken: string;
}

const textractClient = new TextractClient({ region: 'eu-west-1' });
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INVOICE_TABLE = process.env.INVOICE_TABLE ?? '';
const STORAGE_BUCKET_NAME = process.env.STORAGE_BUCKET_NAME ?? '';
const TEXTRACT_SNS_TOPIC_ARN = process.env.TEXTRACT_SNS_TOPIC_ARN ?? '';
const TEXTRACT_SNS_ROLE_ARN = process.env.TEXTRACT_SNS_ROLE_ARN ?? '';

export const handler: Handler<TextractRequestEvent, TextractRequestResult> = async (event) => {
  const { invoiceId, userId: _userId, s3Key, bucketName, taskToken } = event;

  console.log(`Starting async Textract for invoice: ${invoiceId}`);
  console.log(`Source: s3://${bucketName}/${s3Key}`);

  // Validate inputs
  if (!invoiceId || !s3Key || !bucketName || !taskToken) {
    throw new Error(
      `Missing required parameters: invoiceId=${invoiceId}, s3Key=${s3Key}, bucketName=${bucketName}, taskToken=${taskToken ? '[present]' : '[missing]'}`
    );
  }

  if (!TEXTRACT_SNS_TOPIC_ARN || !TEXTRACT_SNS_ROLE_ARN) {
    throw new Error('Missing environment: TEXTRACT_SNS_TOPIC_ARN or TEXTRACT_SNS_ROLE_ARN');
  }

  try {
    // Start async Textract job directly on the storage bucket
    // The bucket policy now allows Textract service principal to read
    const textractParams = {
      DocumentLocation: {
        S3Object: {
          Bucket: STORAGE_BUCKET_NAME,
          Name: s3Key,
        },
      },
      NotificationChannel: {
        SNSTopicArn: TEXTRACT_SNS_TOPIC_ARN,
        RoleArn: TEXTRACT_SNS_ROLE_ARN,
      },
      JobTag: invoiceId,
    };
    
    console.log('Starting Textract StartExpenseAnalysis with params:', JSON.stringify(textractParams, null, 2));
    const startResponse = await textractClient.send(
      new StartExpenseAnalysisCommand(textractParams)
    );

    const jobId = startResponse.JobId;
    if (!jobId) {
      throw new Error('Textract did not return a JobId');
    }

    console.log(`Textract job started: ${jobId}`);

    // Update DynamoDB with job ID and task token
    await ddbClient.send(
      new UpdateCommand({
        TableName: INVOICE_TABLE,
        Key: { id: invoiceId },
        UpdateExpression: 'SET textractJobId = :jobId, taskToken = :token, processingStep = :step, updatedAt = :now',
        ExpressionAttributeValues: {
          ':jobId': jobId,
          ':token': taskToken,
          ':step': 'TEXTRACT_PROCESSING',
          ':now': new Date().toISOString(),
        },
      })
    );

    console.log(`Invoice ${invoiceId} updated with jobId and taskToken`);

    // Return job info (but Step Functions will wait for SNS notification)
    return {
      jobId,
      taskToken,
    };
  } catch (error) {
    console.error(`Textract job start failed for ${invoiceId}:`, error);

    // Update invoice status to failed
    await ddbClient.send(
      new UpdateCommand({
        TableName: INVOICE_TABLE,
        Key: { id: invoiceId },
        UpdateExpression: 'SET processingStep = :step, #status = :status, updatedAt = :now',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':step': 'TEXTRACT_FAILED',
          ':status': 'FAILED',
          ':now': new Date().toISOString(),
        },
      })
    );

    throw error;
  }
};
