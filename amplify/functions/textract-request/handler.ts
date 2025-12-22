/**
 * @file amplify/functions/textract-request/handler.ts
 * @description Synchronous Textract expense analysis - Lambda downloads file and sends bytes to Textract
 * This avoids S3 bucket policy issues since Lambda (not Textract) accesses S3
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AnalyzeExpenseCommand, DetectDocumentTextCommand, TextractClient } from '@aws-sdk/client-textract';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Handler } from 'aws-lambda';

interface TextractRequestEvent {
  invoiceId: string;
  userId: string;
  s3Key: string;
  bucketName: string;
  taskToken: string;
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
  confidence: number;
  rawTextractOutput?: Record<string, unknown>;
}

const textractClient = new TextractClient({});
const s3Client = new S3Client({});
const sfnClient = new SFNClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INVOICE_TABLE = process.env.INVOICE_TABLE ?? '';

// Max file size for synchronous Textract (5MB)
const MAX_FILE_SIZE = 5 * 1024 * 1024;

export const handler: Handler<TextractRequestEvent, ExtractedData> = async (event) => {
  const { invoiceId, userId: _userId, s3Key, bucketName, taskToken } = event;

  console.log(`Starting Textract expense analysis for invoice: ${invoiceId}`);
  console.log(`S3 location: s3://${bucketName}/${s3Key}`);

  // Validate inputs
  if (!invoiceId || !s3Key || !bucketName || !taskToken) {
    throw new Error(
      `Missing required parameters: invoiceId=${invoiceId}, s3Key=${s3Key}, bucketName=${bucketName}, taskToken=${taskToken ? '[present]' : '[missing]'}`
    );
  }

  try {
    // Step 1: Download file from S3 (Lambda has access)
    console.log('Downloading file from S3...');
    const getObjectResponse = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
      })
    );

    const fileBytes = await getObjectResponse.Body?.transformToByteArray();
    if (!fileBytes) {
      throw new Error('Failed to download file from S3');
    }

    console.log(`Downloaded ${fileBytes.length} bytes, type: ${fileBytes.constructor.name}`);
    
    // Convert to Buffer explicitly for Textract
    const fileBuffer = Buffer.from(fileBytes);
    console.log(`Converted to Buffer: ${fileBuffer.length} bytes, first 4 bytes: ${fileBuffer.subarray(0, 4).toString('hex')}`);

    // Check file size limit
    if (fileBytes.length > MAX_FILE_SIZE) {
      throw new Error(`File size ${fileBytes.length} exceeds Textract sync limit of ${MAX_FILE_SIZE} bytes. Consider using async API.`);
    }

    // Step 2: Call Textract synchronously with the bytes
    // Try AnalyzeExpense first, fall back to DetectDocumentText for unsupported formats
    let extractedData: ExtractedData;
    
    try {
      console.log('Calling Textract AnalyzeExpense...');
      const analyzeResponse = await textractClient.send(
        new AnalyzeExpenseCommand({
          Document: {
            Bytes: fileBuffer,
          },
        })
      );
      console.log('Textract AnalyzeExpense complete');
      extractedData = extractExpenseData(analyzeResponse);
    } catch (expenseError: any) {
      // If AnalyzeExpense fails with UnsupportedDocumentException, try DetectDocumentText
      if (expenseError.name === 'UnsupportedDocumentException') {
        console.log('AnalyzeExpense failed with UnsupportedDocumentException, trying DetectDocumentText...');
        
        try {
          const detectResponse = await textractClient.send(
            new DetectDocumentTextCommand({
              Document: {
                Bytes: fileBuffer,
              },
            })
          );
          console.log('Textract DetectDocumentText complete');
          extractedData = extractTextData(detectResponse);
        } catch (detectError: any) {
          // If DetectDocumentText also fails, return minimal data and let Bedrock handle it
          if (detectError.name === 'UnsupportedDocumentException') {
            console.log('DetectDocumentText also failed - returning minimal data for Bedrock fallback');
            extractedData = {
              lineItems: [],
              confidence: 0, // Low confidence will trigger Bedrock enhancement
              rawTextractOutput: { error: 'UnsupportedDocumentException', message: 'Document format not supported by Textract' },
            };
          } else {
            throw detectError;
          }
        }
      } else {
        throw expenseError;
      }
    }
    console.log(`Extracted: vendor=${extractedData.vendorName}, amount=${extractedData.totalAmount}, confidence=${extractedData.confidence}`);

    // Step 4: Update DynamoDB with results
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

    // Step 5: Send success back to Step Functions
    await sfnClient.send(
      new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify(extractedData),
      })
    );

    console.log(`Invoice ${invoiceId} processing complete`);
    return extractedData;
  } catch (error) {
    console.error(`Textract analysis failed for ${invoiceId}:`, error);
    
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

/**
 * Extract data from DetectDocumentText response (fallback for unsupported formats)
 * This extracts raw text and tries to find invoice-like patterns
 */
function extractTextData(response: any): ExtractedData {
  const result: ExtractedData = {
    lineItems: [],
    confidence: 0.5, // Lower confidence for text-only extraction
    rawTextractOutput: response,
  };

  // Collect all text lines
  const lines: string[] = [];
  for (const block of response.Blocks || []) {
    if (block.BlockType === 'LINE' && block.Text) {
      lines.push(block.Text);
    }
  }

  const fullText = lines.join('\n');
  console.log(`Extracted ${lines.length} lines of text`);

  // Try to find vendor name (usually at the top, look for company-like names)
  // Common patterns: "Amazon Web Services", company names with Ltd, Inc, LLC, etc.
  const vendorPatterns = [
    /Amazon Web Services/i,
    /^([A-Z][A-Za-z\s]+(?:Ltd|Limited|Inc|LLC|PLC|Corp|Corporation))/m,
  ];
  
  for (const pattern of vendorPatterns) {
    const match = fullText.match(pattern);
    if (match) {
      result.vendorName = match[1] || match[0];
      break;
    }
  }

  // Try to find total amount (look for currency patterns)
  const amountPatterns = [
    /Total[:\s]*[£$€]?\s*([\d,]+\.?\d*)/i,
    /Amount Due[:\s]*[£$€]?\s*([\d,]+\.?\d*)/i,
    /Grand Total[:\s]*[£$€]?\s*([\d,]+\.?\d*)/i,
    /[£$€]\s*([\d,]+\.\d{2})\b/g, // Generic currency pattern
  ];

  for (const pattern of amountPatterns) {
    const matches = fullText.matchAll(pattern);
    for (const match of matches) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(amount) && amount > 0) {
        // Take the largest amount as likely the total
        if (!result.totalAmount || amount > result.totalAmount) {
          result.totalAmount = amount;
        }
      }
    }
  }

  // Try to find invoice date
  const datePatterns = [
    /Invoice Date[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    /Date[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})/i,
  ];

  for (const pattern of datePatterns) {
    const match = fullText.match(pattern);
    if (match) {
      result.invoiceDate = match[1];
      break;
    }
  }

  // Try to find invoice number
  const invoiceNumPatterns = [
    /Invoice(?:\s+ID)?[:\s#]*([A-Z0-9\-]+)/i,
    /Invoice Number[:\s]*([A-Z0-9\-]+)/i,
  ];

  for (const pattern of invoiceNumPatterns) {
    const match = fullText.match(pattern);
    if (match) {
      result.invoiceNumber = match[1];
      break;
    }
  }

  console.log(`Text extraction found: vendor=${result.vendorName}, amount=${result.totalAmount}, date=${result.invoiceDate}`);
  return result;
}

/**
 * Extract structured expense data from Textract response
 */
function extractExpenseData(response: any): ExtractedData {
  const result: ExtractedData = {
    lineItems: [],
    confidence: 0,
    rawTextractOutput: response,
  };

  let totalConfidence = 0;
  let confidenceCount = 0;

  // Process expense documents
  for (const doc of response.ExpenseDocuments || []) {
    // Extract summary fields
    for (const field of doc.SummaryFields || []) {
      const type = field.Type?.Text?.toUpperCase();
      const value = field.ValueDetection?.Text;
      const confidence = field.ValueDetection?.Confidence || 0;

      if (confidence > 0) {
        totalConfidence += confidence;
        confidenceCount++;
      }

      switch (type) {
        case 'VENDOR_NAME':
        case 'NAME':
          if (!result.vendorName) result.vendorName = value;
          break;
        case 'INVOICE_RECEIPT_DATE':
        case 'ORDER_DATE':
          if (!result.invoiceDate) result.invoiceDate = value;
          break;
        case 'DUE_DATE':
          if (!result.dueDate) result.dueDate = value;
          break;
        case 'TOTAL':
        case 'AMOUNT_DUE':
        case 'SUBTOTAL':
          if (!result.totalAmount && value) {
            const amount = parseFloat(value.replace(/[^0-9.-]/g, ''));
            if (!isNaN(amount)) result.totalAmount = amount;
          }
          break;
        case 'INVOICE_RECEIPT_ID':
          if (!result.invoiceNumber) result.invoiceNumber = value;
          break;
      }
    }

    // Extract line items
    for (const lineItemGroup of doc.LineItemGroups || []) {
      for (const lineItem of lineItemGroup.LineItems || []) {
        const item: ExtractedData['lineItems'][0] = {};
        
        for (const field of lineItem.LineItemExpenseFields || []) {
          const type = field.Type?.Text?.toUpperCase();
          const value = field.ValueDetection?.Text;
          
          switch (type) {
            case 'ITEM':
            case 'DESCRIPTION':
              item.description = value;
              break;
            case 'QUANTITY':
              item.quantity = parseFloat(value || '0');
              break;
            case 'UNIT_PRICE':
              item.unitPrice = parseFloat((value || '0').replace(/[^0-9.-]/g, ''));
              break;
            case 'PRICE':
            case 'AMOUNT':
              item.amount = parseFloat((value || '0').replace(/[^0-9.-]/g, ''));
              break;
          }
        }
        
        if (Object.keys(item).length > 0) {
          result.lineItems.push(item);
        }
      }
    }
  }

  // Calculate average confidence
  result.confidence = confidenceCount > 0 ? totalConfidence / confidenceCount / 100 : 0;

  return result;
}
