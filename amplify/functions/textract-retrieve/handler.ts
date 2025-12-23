/**
 * @file amplify/functions/textract-retrieve/handler.ts
 * @description SNS handler for Textract async job completion - retrieves results and sends to Step Functions
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { GetExpenseAnalysisCommand, TextractClient } from '@aws-sdk/client-textract';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Handler, SNSEvent } from 'aws-lambda';

interface TextractNotification {
  JobId: string;
  Status: 'SUCCEEDED' | 'FAILED' | 'PARTIAL_SUCCESS';
  API: string;
  JobTag?: string;
  Timestamp: string;
  DocumentLocation?: {
    S3ObjectName: string;
    S3Bucket: string;
  };
}

interface CandidateAmount {
  value: number;
  type: string; // 'TOTAL', 'AMOUNT_DUE', 'SUBTOTAL', 'SERVICE_CHARGES', etc.
  currency?: string; // 'GBP', 'USD', 'EUR', etc.
  label?: string; // Raw label text like "TOTAL AMOUNT" or "AWS Service Charges"
  confidence: number;
}

interface CandidateVendor {
  name: string;
  type: string; // 'VENDOR_NAME', 'NAME', 'RECEIVER_NAME', etc.
  confidence: number;
}

interface ExtractedData {
  vendorName?: string;
  invoiceDate?: string;
  dueDate?: string;
  totalAmount?: number;
  currency?: string;
  invoiceNumber?: string;
  lineItems: Array<{
    description?: string;
    quantity?: number;
    unitPrice?: number;
    amount?: number;
  }>;
  // New: All candidate amounts for LLM to choose from
  candidateAmounts: CandidateAmount[];
  // New: All candidate vendors for LLM to choose from
  candidateVendors: CandidateVendor[];
  // New: All date candidates
  candidateDates: string[];
  confidence: number;
  rawTextractOutput?: Record<string, unknown>;
}

const textractClient = new TextractClient({});
const sfnClient = new SFNClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INVOICE_TABLE = process.env.INVOICE_TABLE ?? '';

/**
 * Parse various date formats and convert to ISO YYYY-MM-DD format
 */
function parseDate(dateStr: string): string | undefined {
  if (!dateStr?.trim()) return undefined;

  const cleaned = dateStr.trim();

  // Try DD/MM/YYYY or DD-MM-YYYY (UK format)
  const ukMatch = cleaned.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (ukMatch) {
    const [, day, month, year] = ukMatch;
    const d = Number.parseInt(day, 10);
    const m = Number.parseInt(month, 10);
    const y = Number.parseInt(year, 10);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1900 && y <= 2100) {
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }

  // Try YYYY-MM-DD (ISO format - already correct)
  const isoMatch = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Try Month DD, YYYY (e.g., "March 05, 2023")
  const monthNames: Record<string, string> = {
    january: '01',
    february: '02',
    march: '03',
    april: '04',
    may: '05',
    june: '06',
    july: '07',
    august: '08',
    september: '09',
    october: '10',
    november: '11',
    december: '12',
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12',
  };
  const monthMatch = cleaned.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (monthMatch) {
    const [, monthName, day, year] = monthMatch;
    const month = monthNames[monthName.toLowerCase()];
    if (month) {
      return `${year}-${month}-${day.padStart(2, '0')}`;
    }
  }

  // Try DD Month YYYY (e.g., "05 March 2023")
  const dayMonthMatch = cleaned.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/i);
  if (dayMonthMatch) {
    const [, day, monthName, year] = dayMonthMatch;
    const month = monthNames[monthName.toLowerCase()];
    if (month) {
      return `${year}-${month}-${day.padStart(2, '0')}`;
    }
  }

  return undefined;
}

export const handler: Handler<SNSEvent> = async (event) => {
  console.log('Textract notification received', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.Sns.Message) as TextractNotification;
      const { JobId, Status, API, JobTag } = message;

      console.log(
        `Processing Textract job: ${JobId}, status: ${Status}, API: ${API}, tag: ${JobTag}`
      );

      // Get invoice record by jobId to find the task token
      const invoiceQuery = await ddbClient.send(
        new QueryCommand({
          TableName: INVOICE_TABLE,
          IndexName: 'byTextractJobId',
          KeyConditionExpression: 'textractJobId = :jobId',
          ExpressionAttributeValues: {
            ':jobId': JobId,
          },
          Limit: 1,
        })
      );

      const invoice = invoiceQuery.Items?.[0];
      if (!invoice) {
        console.error(`No invoice found for Textract job ${JobId}`);
        continue;
      }

      const { id: invoiceId, taskToken } = invoice;
      console.log(`Found invoice: ${invoiceId}`);

      if (!taskToken) {
        console.error(`Invoice ${invoiceId} has no task token`);
        continue;
      }

      if (Status === 'FAILED') {
        console.error(`Textract job ${JobId} failed`);

        // Update invoice
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

        // Send failure to Step Functions
        await sfnClient.send(
          new SendTaskFailureCommand({
            taskToken,
            error: 'TextractJobFailed',
            cause: `Textract job ${JobId} failed`,
          })
        );

        continue;
      }

      // Status is SUCCEEDED or PARTIAL_SUCCESS - retrieve results
      console.log(`Retrieving results for job ${JobId}...`);

      const getResultsResponse = await textractClient.send(
        new GetExpenseAnalysisCommand({
          JobId: JobId,
        })
      );

      console.log('Textract results retrieved');

      // Extract structured data
      const extractedData = extractExpenseData(getResultsResponse);
      console.log(
        `Extracted: vendor=${extractedData.vendorName}, amount=${extractedData.totalAmount}, confidence=${extractedData.confidence}`
      );

      // Update invoice with extracted data
      await ddbClient.send(
        new UpdateCommand({
          TableName: INVOICE_TABLE,
          Key: { id: invoiceId },
          UpdateExpression: `SET 
            vendorName = :vendorName,
            invoiceDate = :invoiceDate,
            totalAmount = :totalAmount,
            currency = :currency,
            invoiceNumber = :invoiceNumber,
            extractionConfidence = :confidence,
            processingStep = :step,
            #status = :status,
            updatedAt = :now`,
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':vendorName': extractedData.vendorName ?? null,
            ':invoiceDate': extractedData.invoiceDate ?? null,
            ':totalAmount': extractedData.totalAmount ?? null,
            ':currency': extractedData.currency ?? 'GBP',
            ':invoiceNumber': extractedData.invoiceNumber ?? null,
            ':confidence': extractedData.confidence,
            ':step': 'TEXTRACT_COMPLETE',
            ':status': 'EXTRACTED',
            ':now': new Date().toISOString(),
          },
        })
      );

      // Send success to Step Functions (exclude rawTextractOutput to stay under 256KB limit)
      const { rawTextractOutput: _raw, ...extractedDataWithoutRaw } = extractedData;
      await sfnClient.send(
        new SendTaskSuccessCommand({
          taskToken,
          output: JSON.stringify(extractedDataWithoutRaw),
        })
      );

      console.log(`Invoice ${invoiceId} processing complete via async Textract`);
    } catch (error) {
      console.error('Error processing Textract notification:', error);
      // Don't throw - process other records
    }
  }
};

/**
 * Extract currency from a value string (e.g., "GBP 174.43" -> "GBP")
 */
function extractCurrency(value: string): string | undefined {
  const currencyPatterns = [/^(GBP|USD|EUR|£|\$|€)\s*/i, /\s*(GBP|USD|EUR)$/i];

  for (const pattern of currencyPatterns) {
    const match = value.match(pattern);
    if (match) {
      const currency = match[1].toUpperCase();
      // Normalize symbols to codes
      if (currency === '£') return 'GBP';
      if (currency === '$') return 'USD';
      if (currency === '€') return 'EUR';
      return currency;
    }
  }
  return undefined;
}

/**
 * Extract structured expense data from Textract GetExpenseAnalysis response
 * Now extracts ALL amounts, vendors, and dates for LLM to choose from
 */
function extractExpenseData(response: any): ExtractedData {
  const result: ExtractedData = {
    lineItems: [],
    candidateAmounts: [],
    candidateVendors: [],
    candidateDates: [],
    confidence: 0,
    rawTextractOutput: response,
  };

  let totalConfidence = 0;
  let confidenceCount = 0;

  // Track seen amounts to avoid duplicates
  const seenAmounts = new Set<string>();

  // Process expense documents
  for (const doc of response.ExpenseDocuments || []) {
    // Extract summary fields - collect ALL candidates
    for (const field of doc.SummaryFields || []) {
      const type = field.Type?.Text?.toUpperCase() || '';
      const value = field.ValueDetection?.Text || '';
      const labelText = field.LabelDetection?.Text || '';
      const confidence = field.ValueDetection?.Confidence || 0;

      if (confidence > 0) {
        totalConfidence += confidence;
        confidenceCount++;
      }

      // Collect vendor candidates
      if (
        type === 'VENDOR_NAME' ||
        type === 'NAME' ||
        type === 'RECEIVER_NAME' ||
        type === 'VENDOR'
      ) {
        if (value?.trim()) {
          result.candidateVendors.push({
            name: value.trim(),
            type: type,
            confidence: confidence,
          });
        }
      }

      // Collect date candidates
      if (
        type === 'INVOICE_RECEIPT_DATE' ||
        type === 'ORDER_DATE' ||
        type === 'DUE_DATE' ||
        type === 'DATE'
      ) {
        if (value?.trim() && !result.candidateDates.includes(value.trim())) {
          result.candidateDates.push(value.trim());
        }
        // Set primary date (prefer INVOICE_RECEIPT_DATE) - convert to ISO format
        if (!result.invoiceDate && (type === 'INVOICE_RECEIPT_DATE' || type === 'ORDER_DATE')) {
          result.invoiceDate = parseDate(value);
        }
        if (!result.dueDate && type === 'DUE_DATE') {
          result.dueDate = parseDate(value);
        }
      }

      // Collect ALL amount candidates
      if (
        type === 'TOTAL' ||
        type === 'AMOUNT_DUE' ||
        type === 'SUBTOTAL' ||
        type === 'TAX' ||
        type === 'AMOUNT' ||
        type === 'PRICE' ||
        type === 'NET_TOTAL' ||
        type === 'GROSS_TOTAL'
      ) {
        if (value) {
          const amount = parseFloat(value.replace(/[^0-9.-]/g, ''));
          if (!Number.isNaN(amount) && amount > 0) {
            const currency = extractCurrency(value);
            const amountKey = `${amount}-${currency || 'unknown'}-${type}`;

            if (!seenAmounts.has(amountKey)) {
              seenAmounts.add(amountKey);
              result.candidateAmounts.push({
                value: amount,
                type: type,
                currency: currency,
                label: labelText || type,
                confidence: confidence,
              });
            }
          }
        }
      }

      // Invoice number
      if (type === 'INVOICE_RECEIPT_ID' && !result.invoiceNumber) {
        result.invoiceNumber = value;
      }
    }

    // Extract line items and their amounts
    for (const lineItemGroup of doc.LineItemGroups || []) {
      for (const lineItem of lineItemGroup.LineItems || []) {
        const item: ExtractedData['lineItems'][0] = {};
        let lineDescription = '';

        for (const field of lineItem.LineItemExpenseFields || []) {
          const type = field.Type?.Text?.toUpperCase() || '';
          const value = field.ValueDetection?.Text || '';
          const confidence = field.ValueDetection?.Confidence || 0;

          switch (type) {
            case 'ITEM':
            case 'DESCRIPTION':
              item.description = value;
              lineDescription = value;
              break;
            case 'QUANTITY':
              item.quantity = parseFloat(value || '0');
              break;
            case 'UNIT_PRICE':
              item.unitPrice = parseFloat((value || '0').replace(/[^0-9.-]/g, ''));
              // Also capture as candidate amount if significant
              if (item.unitPrice && item.unitPrice > 10) {
                const currency = extractCurrency(value);
                const amountKey = `${item.unitPrice}-${currency || 'unknown'}-LINE_UNIT_PRICE`;
                if (!seenAmounts.has(amountKey)) {
                  seenAmounts.add(amountKey);
                  result.candidateAmounts.push({
                    value: item.unitPrice,
                    type: 'LINE_UNIT_PRICE',
                    currency: currency,
                    label: lineDescription || 'Line Item Unit Price',
                    confidence: confidence,
                  });
                }
              }
              break;
            case 'PRICE':
            case 'AMOUNT':
              item.amount = parseFloat((value || '0').replace(/[^0-9.-]/g, ''));
              // Capture line amounts as candidates (may include GBP totals)
              if (item.amount && item.amount > 10) {
                const currency = extractCurrency(value);
                const amountKey = `${item.amount}-${currency || 'unknown'}-LINE_AMOUNT`;
                if (!seenAmounts.has(amountKey)) {
                  seenAmounts.add(amountKey);
                  result.candidateAmounts.push({
                    value: item.amount,
                    type: 'LINE_AMOUNT',
                    currency: currency,
                    label: lineDescription || 'Line Item Amount',
                    confidence: confidence,
                  });
                }
              }
              break;
          }
        }

        if (Object.keys(item).length > 0) {
          result.lineItems.push(item);
        }
      }
    }
  }

  // Set primary vendor: prefer VENDOR_NAME over NAME
  const vendorNameCandidate = result.candidateVendors.find((v) => v.type === 'VENDOR_NAME');
  const nameCandidate = result.candidateVendors.find((v) => v.type === 'NAME');
  result.vendorName = vendorNameCandidate?.name || nameCandidate?.name;

  // Set primary totalAmount: prefer GBP TOTAL, then any TOTAL
  const gbpTotal = result.candidateAmounts.find((a) => a.type === 'TOTAL' && a.currency === 'GBP');
  const anyTotal = result.candidateAmounts.find((a) => a.type === 'TOTAL');
  const amountDue = result.candidateAmounts.find((a) => a.type === 'AMOUNT_DUE');

  if (gbpTotal) {
    result.totalAmount = gbpTotal.value;
    result.currency = 'GBP';
  } else if (anyTotal) {
    result.totalAmount = anyTotal.value;
    result.currency = anyTotal.currency;
  } else if (amountDue) {
    result.totalAmount = amountDue.value;
    result.currency = amountDue.currency;
  }

  // Sort candidate amounts by confidence (highest first)
  result.candidateAmounts.sort((a, b) => b.confidence - a.confidence);

  // Calculate average confidence
  result.confidence = confidenceCount > 0 ? totalConfidence / confidenceCount / 100 : 0;

  console.log(
    `Extracted ${result.candidateAmounts.length} candidate amounts:`,
    result.candidateAmounts.map((a) => `${a.currency || '?'} ${a.value} (${a.type})`).join(', ')
  );
  console.log(
    `Extracted ${result.candidateVendors.length} candidate vendors:`,
    result.candidateVendors.map((v) => `${v.name} (${v.type})`).join(', ')
  );

  return result;
}
