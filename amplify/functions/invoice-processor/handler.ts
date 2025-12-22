/**
 * @file amplify/functions/invoice-processor/handler.ts
 * @description Lambda handler for processing invoice images/PDFs with Textract and Bedrock
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Handler } from 'aws-lambda';
import { extractInvoiceWithBedrock } from './bedrock-client';
import { analyzeExpenseDocument, extractInvoiceData } from './textract-client';

interface ProcessEvent {
  invoiceId: string;
  userId: string;
}

interface Invoice {
  id: string;
  userId: string;
  s3Key: string;
  status: string;
  vendorName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  totalAmount?: number;
  currency?: string;
  lineItems?: Array<{
    description: string;
    quantity?: number;
    unitPrice?: number;
    amount: number;
  }>;
  extractionConfidence?: number;
  rawTextractOutput?: Record<string, unknown>;
}

const s3Client = new S3Client({});
const lambdaClient = new LambdaClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET_NAME = process.env.STORAGE_BUCKET_NAME ?? '';
const MATCHER_ARN = process.env.MATCHER_ARN ?? '';
const INVOICE_TABLE = process.env.INVOICE_TABLE ?? '';

// Confidence threshold below which we use Bedrock for verification
const TEXTRACT_CONFIDENCE_THRESHOLD = 0.7;

export const handler: Handler<ProcessEvent> = async (event) => {
  const { invoiceId, userId } = event;

  console.log(`Processing invoice: ${invoiceId}`);

  try {
    // Get invoice record
    const invoiceResponse = await ddbClient.send(
      new GetCommand({
        TableName: INVOICE_TABLE,
        Key: { id: invoiceId },
      })
    );

    const invoice = invoiceResponse.Item as Invoice | undefined;
    if (!invoice) {
      throw new Error(`Invoice not found: ${invoiceId}`);
    }

    if (invoice.status !== 'PENDING') {
      console.log(`Invoice ${invoiceId} already processed, status: ${invoice.status}`);
      return { skipped: true, status: invoice.status };
    }

    // Download file from S3
    const s3Response = await s3Client.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: invoice.s3Key,
      })
    );

    if (!s3Response.Body) {
      throw new Error('Empty file from S3');
    }

    const fileBytes = Buffer.from(await s3Response.Body.transformToByteArray());
    const mimeType = s3Response.ContentType ?? 'application/pdf';

    console.log(`Downloaded ${fileBytes.length} bytes, mime type: ${mimeType}`);

    // Try Textract first
    let extractedData: {
      vendorName?: string;
      invoiceNumber?: string;
      invoiceDate?: string;
      dueDate?: string;
      totalAmount?: number;
      currency?: string;
      lineItems?: Array<{
        description: string;
        quantity?: number;
        unitPrice?: number;
        amount: number;
      }>;
      confidence: number;
    };
    let rawTextractOutput: Record<string, unknown> | undefined;

    try {
      console.log('Running Textract AnalyzeExpense...');
      const textractResult = await analyzeExpenseDocument(fileBytes);
      extractedData = extractInvoiceData(textractResult.document);
      rawTextractOutput = textractResult.raw as unknown as Record<string, unknown>;

      console.log(`Textract extraction complete, confidence: ${extractedData.confidence}`);

      // If Textract confidence is low or key fields are missing, use Bedrock
      if (
        extractedData.confidence < TEXTRACT_CONFIDENCE_THRESHOLD ||
        !extractedData.totalAmount ||
        !extractedData.vendorName
      ) {
        console.log('Low confidence or missing fields, using Bedrock for verification...');

        const bedrockData = await extractInvoiceWithBedrock(fileBytes, mimeType);

        // Merge Bedrock results, preferring Bedrock for missing/low-confidence fields
        if (!extractedData.vendorName && bedrockData.vendorName) {
          extractedData.vendorName = bedrockData.vendorName;
        }
        if (!extractedData.invoiceNumber && bedrockData.invoiceNumber) {
          extractedData.invoiceNumber = bedrockData.invoiceNumber;
        }
        if (!extractedData.invoiceDate && bedrockData.invoiceDate) {
          extractedData.invoiceDate = bedrockData.invoiceDate;
        }
        if (!extractedData.dueDate && bedrockData.dueDate) {
          extractedData.dueDate = bedrockData.dueDate;
        }
        if (!extractedData.totalAmount && bedrockData.totalAmount) {
          extractedData.totalAmount = bedrockData.totalAmount;
        }
        if (!extractedData.currency && bedrockData.currency) {
          extractedData.currency = bedrockData.currency;
        }
        if (
          (!extractedData.lineItems || extractedData.lineItems.length === 0) &&
          bedrockData.lineItems
        ) {
          extractedData.lineItems = bedrockData.lineItems;
        }

        // Adjust confidence based on Bedrock results
        extractedData.confidence = Math.max(extractedData.confidence, bedrockData.confidence * 0.9);
      }
    } catch (textractError) {
      console.log('Textract failed, falling back to Bedrock only:', textractError);

      // Fallback to Bedrock-only extraction
      extractedData = await extractInvoiceWithBedrock(fileBytes, mimeType);
    }

    // Update invoice record with extracted data
    const now = new Date().toISOString();

    await ddbClient.send(
      new UpdateCommand({
        TableName: INVOICE_TABLE,
        Key: { id: invoiceId },
        UpdateExpression: `
          SET #status = :status,
              vendorName = :vendorName,
              invoiceNumber = :invoiceNumber,
              invoiceDate = :invoiceDate,
              dueDate = :dueDate,
              totalAmount = :totalAmount,
              currency = :currency,
              lineItems = :lineItems,
              extractionConfidence = :confidence,
              rawTextractOutput = :rawOutput,
              updatedAt = :updatedAt
        `,
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': 'EXTRACTED',
          ':vendorName': extractedData.vendorName ?? null,
          ':invoiceNumber': extractedData.invoiceNumber ?? null,
          ':invoiceDate': extractedData.invoiceDate ?? null,
          ':dueDate': extractedData.dueDate ?? null,
          ':totalAmount': extractedData.totalAmount ?? null,
          ':currency': extractedData.currency ?? 'GBP',
          ':lineItems': extractedData.lineItems ?? null,
          ':confidence': extractedData.confidence,
          ':rawOutput': rawTextractOutput ?? null,
          ':updatedAt': now,
        },
      })
    );

    console.log(`Invoice ${invoiceId} extraction complete`);

    // Trigger matcher function
    if (MATCHER_ARN) {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: MATCHER_ARN,
          InvocationType: 'Event',
          Payload: JSON.stringify({ invoiceId, userId }),
        })
      );
      console.log('Triggered matcher function');
    }

    return {
      invoiceId,
      status: 'EXTRACTED',
      vendorName: extractedData.vendorName,
      totalAmount: extractedData.totalAmount,
      currency: extractedData.currency,
      confidence: extractedData.confidence,
    };
  } catch (error) {
    console.error(`Failed to process invoice ${invoiceId}:`, error);

    // Update invoice status to FAILED
    await ddbClient.send(
      new UpdateCommand({
        TableName: INVOICE_TABLE,
        Key: { id: invoiceId },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': 'FAILED',
          ':updatedAt': new Date().toISOString(),
        },
      })
    );

    throw error;
  }
};
