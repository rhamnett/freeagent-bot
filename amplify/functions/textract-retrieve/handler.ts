/**
 * @file amplify/functions/textract-retrieve/handler.ts
 * @description Handle Textract SNS callback, retrieve results, send Step Functions callback
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import {
  type ExpenseDocument,
  GetExpenseAnalysisCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Handler, SNSEvent } from 'aws-lambda';

interface TextractSNSMessage {
  JobId: string;
  Status: 'SUCCEEDED' | 'FAILED' | 'PARTIAL_SUCCESS';
  API: string;
  JobTag?: string;
  Timestamp: number;
  DocumentLocation?: {
    S3ObjectName: string;
    S3Bucket: string;
  };
}

interface ExtractedInvoiceData {
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
}

interface InvoiceRecord {
  id: string;
  userId: string;
  s3Key: string;
  currentTaskToken: string;
  textractJobId: string;
}

const textractClient = new TextractClient({});
const sfnClient = new SFNClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INVOICE_TABLE = process.env.INVOICE_TABLE ?? '';

export const handler: Handler<SNSEvent, void> = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message) as TextractSNSMessage;
    const { JobId, Status, JobTag: invoiceId } = message;

    console.log(
      `Received Textract callback: JobId=${JobId}, Status=${Status}, InvoiceId=${invoiceId}`
    );

    if (!invoiceId) {
      console.error('No JobTag (invoiceId) in Textract notification, cannot process');
      continue;
    }

    // Get invoice record with task token
    const invoiceResponse = await ddbClient.send(
      new GetCommand({
        TableName: INVOICE_TABLE,
        Key: { id: invoiceId },
      })
    );

    const invoice = invoiceResponse.Item as InvoiceRecord | undefined;
    if (!invoice) {
      console.error(`Invoice ${invoiceId} not found in database`);
      continue;
    }

    const taskToken = invoice.currentTaskToken;
    if (!taskToken) {
      console.error(`Invoice ${invoiceId} has no task token`);
      continue;
    }

    try {
      if (Status === 'SUCCEEDED' || Status === 'PARTIAL_SUCCESS') {
        // Get Textract results with pagination
        const extractedData = await getTextractResults(JobId);

        console.log(`Extracted data for invoice ${invoiceId}:`, JSON.stringify(extractedData));

        // Update invoice with extracted data
        await ddbClient.send(
          new UpdateCommand({
            TableName: INVOICE_TABLE,
            Key: { id: invoiceId },
            UpdateExpression:
              'SET processingStep = :step, vendorName = :vendor, invoiceNumber = :invNum, ' +
              'invoiceDate = :invDate, dueDate = :dueDate, totalAmount = :amount, currency = :currency, ' +
              'extractionConfidence = :confidence, updatedAt = :now',
            ExpressionAttributeValues: {
              ':step': 'TEXTRACT_COMPLETE',
              ':vendor': extractedData.vendorName ?? null,
              ':invNum': extractedData.invoiceNumber ?? null,
              ':invDate': extractedData.invoiceDate ?? null,
              ':dueDate': extractedData.dueDate ?? null,
              ':amount': extractedData.totalAmount ?? null,
              ':currency': extractedData.currency ?? null,
              ':confidence': extractedData.confidence,
              ':now': new Date().toISOString(),
            },
          })
        );

        // Send success to Step Functions
        await sfnClient.send(
          new SendTaskSuccessCommand({
            taskToken,
            output: JSON.stringify({
              invoiceId,
              userId: invoice.userId,
              s3Key: invoice.s3Key,
              bucketName: message.DocumentLocation?.S3Bucket,
              extractedData,
              confidence: extractedData.confidence,
            }),
          })
        );

        console.log(`Successfully processed invoice ${invoiceId}, sent TaskSuccess`);
      } else {
        // Textract job failed
        console.error(`Textract job ${JobId} failed for invoice ${invoiceId}`);

        // Update invoice status
        await ddbClient.send(
          new UpdateCommand({
            TableName: INVOICE_TABLE,
            Key: { id: invoiceId },
            UpdateExpression: 'SET processingStep = :step, status = :status, updatedAt = :now',
            ExpressionAttributeValues: {
              ':step': 'FAILED',
              ':status': 'FAILED',
              ':now': new Date().toISOString(),
            },
          })
        );

        // Send failure to Step Functions
        await sfnClient.send(
          new SendTaskFailureCommand({
            taskToken,
            error: 'TextractJobFailed',
            cause: JSON.stringify({
              jobId: JobId,
              status: Status,
              invoiceId,
            }),
          })
        );

        console.log(`Sent TaskFailure for invoice ${invoiceId}`);
      }
    } catch (error) {
      console.error(`Error processing Textract callback for invoice ${invoiceId}:`, error);

      // Try to send failure to Step Functions
      try {
        await sfnClient.send(
          new SendTaskFailureCommand({
            taskToken,
            error: 'TextractRetrieveError',
            cause: error instanceof Error ? error.message : String(error),
          })
        );
      } catch (sfnError) {
        console.error('Failed to send TaskFailure:', sfnError);
      }
    }
  }
};

/**
 * Get Textract expense analysis results with pagination
 */
async function getTextractResults(jobId: string): Promise<ExtractedInvoiceData> {
  const allExpenseDocuments: ExpenseDocument[] = [];
  let nextToken: string | undefined;

  // Fetch all pages of results
  do {
    const command = new GetExpenseAnalysisCommand({
      JobId: jobId,
      NextToken: nextToken,
    });

    const response = await textractClient.send(command);
    if (response.ExpenseDocuments) {
      allExpenseDocuments.push(...response.ExpenseDocuments);
    }
    nextToken = response.NextToken;
  } while (nextToken);

  // Parse expense documents
  return parseExpenseDocuments(allExpenseDocuments);
}

/**
 * Parse Textract expense documents into structured invoice data
 */
function parseExpenseDocuments(documents: ExpenseDocument[]): ExtractedInvoiceData {
  const result: ExtractedInvoiceData = {
    confidence: 0,
  };

  let totalConfidence = 0;
  let confidenceCount = 0;

  for (const doc of documents) {
    // Parse summary fields
    for (const field of doc.SummaryFields ?? []) {
      const fieldType = field.Type?.Text?.toUpperCase();
      const fieldValue = field.ValueDetection?.Text;
      const fieldConfidence = field.ValueDetection?.Confidence ?? 0;

      if (!fieldType || !fieldValue) continue;

      totalConfidence += fieldConfidence;
      confidenceCount++;

      switch (fieldType) {
        case 'VENDOR_NAME':
        case 'SUPPLIER_NAME':
        case 'NAME':
          if (!result.vendorName) {
            result.vendorName = fieldValue;
          }
          break;

        case 'INVOICE_RECEIPT_ID':
        case 'INVOICE_NUMBER':
          if (!result.invoiceNumber) {
            result.invoiceNumber = fieldValue;
          }
          break;

        case 'INVOICE_RECEIPT_DATE':
        case 'INVOICE_DATE':
        case 'DATE':
          if (!result.invoiceDate) {
            result.invoiceDate = parseDate(fieldValue);
          }
          break;

        case 'DUE_DATE':
        case 'PAYMENT_DUE_DATE':
          if (!result.dueDate) {
            result.dueDate = parseDate(fieldValue);
          }
          break;

        case 'TOTAL':
        case 'AMOUNT_DUE':
        case 'SUBTOTAL':
          if (!result.totalAmount) {
            const parsed = parseAmount(fieldValue);
            if (parsed) {
              result.totalAmount = parsed.amount;
              result.currency = parsed.currency ?? result.currency;
            }
          }
          break;
      }
    }

    // Parse line items
    const lineItems: ExtractedInvoiceData['lineItems'] = [];
    for (const lineItemGroup of doc.LineItemGroups ?? []) {
      for (const lineItem of lineItemGroup.LineItems ?? []) {
        const item: {
          description: string;
          quantity?: number;
          unitPrice?: number;
          amount: number;
        } = {
          description: '',
          amount: 0,
        };

        for (const field of lineItem.LineItemExpenseFields ?? []) {
          const fieldType = field.Type?.Text?.toUpperCase();
          const fieldValue = field.ValueDetection?.Text;

          if (!fieldType || !fieldValue) continue;

          switch (fieldType) {
            case 'ITEM':
            case 'DESCRIPTION':
            case 'PRODUCT_CODE':
              item.description = fieldValue;
              break;

            case 'QUANTITY':
              item.quantity = parseFloat(fieldValue) || undefined;
              break;

            case 'UNIT_PRICE':
            case 'PRICE': {
              const unitParsed = parseAmount(fieldValue);
              item.unitPrice = unitParsed?.amount;
              break;
            }

            case 'EXPENSE_ROW_TOTAL':
            case 'AMOUNT':
            case 'TOTAL': {
              const amountParsed = parseAmount(fieldValue);
              item.amount = amountParsed?.amount ?? 0;
              break;
            }
          }
        }

        if (item.description || item.amount > 0) {
          lineItems.push(item);
        }
      }
    }

    if (lineItems.length > 0) {
      result.lineItems = lineItems;
    }
  }

  // Calculate average confidence
  result.confidence = confidenceCount > 0 ? totalConfidence / confidenceCount / 100 : 0;

  return result;
}

/**
 * Parse date string into YYYY-MM-DD format
 */
function parseDate(dateStr: string): string | undefined {
  // Try various date formats
  const date = new Date(dateStr);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }

  // Try DD/MM/YYYY format (common in UK)
  const ukMatch = dateStr.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (ukMatch) {
    const day = parseInt(ukMatch[1], 10);
    const month = parseInt(ukMatch[2], 10);
    let year = parseInt(ukMatch[3], 10);
    if (year < 100) year += 2000;

    const parsed = new Date(year, month - 1, day);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
  }

  return undefined;
}

/**
 * Parse amount string, extracting currency if present
 */
function parseAmount(amountStr: string): { amount: number; currency?: string } | undefined {
  // Remove common currency symbols and extract
  const currencyMatch = amountStr.match(/([£$€]|GBP|USD|EUR)/i);
  const currency = currencyMatch ? normalizeCurrency(currencyMatch[1]) : undefined;

  // Extract numeric value
  const numericStr = amountStr.replace(/[^0-9.,-]/g, '');

  // Handle both comma and period as decimal separator
  let cleanStr = numericStr;
  // If there's a comma followed by exactly 2 digits at the end, treat comma as decimal
  if (/,\d{2}$/.test(cleanStr)) {
    cleanStr = cleanStr.replace(/\./g, '').replace(',', '.');
  } else {
    // Otherwise, remove commas (thousands separator)
    cleanStr = cleanStr.replace(/,/g, '');
  }

  const amount = parseFloat(cleanStr);
  if (Number.isNaN(amount)) return undefined;

  return { amount, currency };
}

/**
 * Normalize currency symbol to ISO code
 */
function normalizeCurrency(symbol: string): string {
  const upper = symbol.toUpperCase();
  switch (upper) {
    case '£':
    case 'GBP':
      return 'GBP';
    case '$':
    case 'USD':
      return 'USD';
    case '€':
    case 'EUR':
      return 'EUR';
    default:
      return upper;
  }
}
