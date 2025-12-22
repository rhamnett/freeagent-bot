/**
 * @file amplify/functions/bedrock-enhance/handler.ts
 * @description Use Bedrock Claude to enhance/verify low-confidence Textract extractions
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Handler } from 'aws-lambda';

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

interface BedrockEnhanceEvent {
  invoiceId: string;
  userId: string;
  s3Key: string;
  bucketName: string;
  extractedData: ExtractedInvoiceData;
  confidence: number;
}

interface BedrockEnhanceResult {
  invoiceId: string;
  enhanced: boolean;
  data: ExtractedInvoiceData;
  confidence: number;
}

interface BedrockMessage {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | {
        type: 'image';
        source: {
          type: 'base64';
          media_type: string;
          data: string;
        };
      }
  >;
}

interface BedrockResponse {
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

const s3Client = new S3Client({});
const bedrockClient = new BedrockRuntimeClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INVOICE_TABLE = process.env.INVOICE_TABLE ?? '';

// Claude Sonnet 4.5 via EU inference profile
const CLAUDE_SONNET_MODEL = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';

const ENHANCEMENT_THRESHOLD = 0.7;

const INVOICE_EXTRACTION_PROMPT = `Analyze this invoice/receipt image and extract the following information in JSON format:

{
  "vendorName": "The company or person who issued the invoice",
  "invoiceNumber": "The invoice or receipt number/reference",
  "invoiceDate": "The invoice date in YYYY-MM-DD format",
  "dueDate": "The payment due date in YYYY-MM-DD format (if present)",
  "totalAmount": "The total amount as a number (without currency symbol)",
  "currency": "The currency code (e.g., GBP, USD, EUR)",
  "lineItems": [
    {
      "description": "Item description",
      "quantity": "Quantity as number",
      "unitPrice": "Unit price as number",
      "amount": "Line total as number"
    }
  ]
}

Important:
- Return ONLY the JSON object, no other text
- Use null for any fields you cannot determine with confidence
- For amounts, extract the numeric value only (e.g., 123.45 not "£123.45")
- For dates, use YYYY-MM-DD format
- Focus on the TOTAL amount, not subtotals or deposits
- If this is not an invoice/receipt, return {"error": "Not an invoice"}`;

export const handler: Handler<BedrockEnhanceEvent, BedrockEnhanceResult> = async (event) => {
  const { invoiceId, userId: _userId, s3Key, bucketName, extractedData, confidence } = event;

  console.log(`Bedrock enhance for invoice ${invoiceId}, current confidence: ${confidence}`);

  // Check if enhancement is needed
  if (confidence >= ENHANCEMENT_THRESHOLD && hasRequiredFields(extractedData)) {
    console.log(
      `Invoice ${invoiceId} has sufficient confidence and required fields, skipping enhancement`
    );
    return {
      invoiceId,
      enhanced: false,
      data: extractedData,
      confidence,
    };
  }

  console.log(`Enhancing invoice ${invoiceId} with Bedrock Claude`);

  // Update processing step
  await ddbClient.send(
    new UpdateCommand({
      TableName: INVOICE_TABLE,
      Key: { id: invoiceId },
      UpdateExpression: 'SET processingStep = :step, updatedAt = :now',
      ExpressionAttributeValues: {
        ':step': 'BEDROCK_ENHANCE',
        ':now': new Date().toISOString(),
      },
    })
  );

  // Get image from S3
  const s3Response = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    })
  );

  const imageBytes = await s3Response.Body?.transformToByteArray();
  if (!imageBytes) {
    throw new Error(`Failed to read file from S3: ${s3Key}`);
  }

  const mimeType = getMimeType(s3Key);

  // Call Bedrock for extraction
  const bedrockData = await extractInvoiceWithBedrock(Buffer.from(imageBytes), mimeType);

  console.log(`Bedrock extraction result:`, JSON.stringify(bedrockData));

  // Merge Textract + Bedrock results (prefer Bedrock for missing/low-confidence fields)
  const mergedData = mergeExtractionResults(extractedData, bedrockData);

  // Update invoice with enhanced data
  await ddbClient.send(
    new UpdateCommand({
      TableName: INVOICE_TABLE,
      Key: { id: invoiceId },
      UpdateExpression:
        'SET processingStep = :step, vendorName = :vendor, invoiceNumber = :invNum, ' +
        'invoiceDate = :invDate, dueDate = :dueDate, totalAmount = :amount, currency = :currency, ' +
        'extractionConfidence = :confidence, updatedAt = :now',
      ExpressionAttributeValues: {
        ':step': 'EXTRACTED',
        ':vendor': mergedData.vendorName ?? null,
        ':invNum': mergedData.invoiceNumber ?? null,
        ':invDate': mergedData.invoiceDate ?? null,
        ':dueDate': mergedData.dueDate ?? null,
        ':amount': mergedData.totalAmount ?? null,
        ':currency': mergedData.currency ?? null,
        ':confidence': mergedData.confidence,
        ':now': new Date().toISOString(),
      },
    })
  );

  return {
    invoiceId,
    enhanced: true,
    data: mergedData,
    confidence: mergedData.confidence,
  };
};

/**
 * Check if invoice has required fields
 */
function hasRequiredFields(data: ExtractedInvoiceData): boolean {
  return !!(data.vendorName && data.totalAmount && (data.invoiceDate || data.invoiceNumber));
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Extract invoice data using Bedrock Claude vision
 */
async function extractInvoiceWithBedrock(
  imageBytes: Buffer,
  mimeType: string
): Promise<ExtractedInvoiceData> {
  const base64Image = imageBytes.toString('base64');

  // Map mime type to Bedrock format
  let mediaType: string;
  switch (mimeType.toLowerCase()) {
    case 'application/pdf':
      mediaType = 'application/pdf';
      break;
    case 'image/jpeg':
    case 'image/jpg':
      mediaType = 'image/jpeg';
      break;
    case 'image/png':
      mediaType = 'image/png';
      break;
    case 'image/gif':
      mediaType = 'image/gif';
      break;
    case 'image/webp':
      mediaType = 'image/webp';
      break;
    default:
      mediaType = 'image/jpeg';
  }

  // Use 'document' type for PDFs, 'image' for images
  const contentType = mimeType.toLowerCase() === 'application/pdf' ? 'document' : 'image';
  
  const messages: BedrockMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: contentType,
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Image,
          },
        },
        {
          type: 'text',
          text: INVOICE_EXTRACTION_PROMPT,
        },
      ],
    },
  ];

  const command = new InvokeModelCommand({
    modelId: CLAUDE_SONNET_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      messages,
    }),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body)) as BedrockResponse;

  const textContent = responseBody.content.find((c) => c.type === 'text');
  if (!textContent) {
    throw new Error('No text response from Bedrock');
  }

  // Parse JSON from response
  const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in Bedrock response');
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    error?: string;
    vendorName?: string;
    invoiceNumber?: string;
    invoiceDate?: string;
    dueDate?: string;
    totalAmount?: number | string;
    currency?: string;
    lineItems?: Array<{
      description: string;
      quantity?: number | string;
      unitPrice?: number | string;
      amount: number | string;
    }>;
  };

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  // Convert string numbers to actual numbers
  return {
    vendorName: parsed.vendorName ?? undefined,
    invoiceNumber: parsed.invoiceNumber ?? undefined,
    invoiceDate: parsed.invoiceDate ?? undefined,
    dueDate: parsed.dueDate ?? undefined,
    totalAmount:
      typeof parsed.totalAmount === 'string' ? parseFloat(parsed.totalAmount) : parsed.totalAmount,
    currency: parsed.currency ?? undefined,
    lineItems: parsed.lineItems?.map((item) => ({
      description: item.description,
      quantity: typeof item.quantity === 'string' ? parseFloat(item.quantity) : item.quantity,
      unitPrice: typeof item.unitPrice === 'string' ? parseFloat(item.unitPrice) : item.unitPrice,
      amount: typeof item.amount === 'string' ? parseFloat(item.amount) : item.amount,
    })),
    confidence: 0.9, // Bedrock typically provides high-quality extraction
  };
}

/**
 * Merge Textract and Bedrock extraction results
 * Prefer Bedrock for missing fields, keep Textract where both exist
 */
function mergeExtractionResults(
  textract: ExtractedInvoiceData,
  bedrock: ExtractedInvoiceData
): ExtractedInvoiceData {
  return {
    vendorName: textract.vendorName || bedrock.vendorName,
    invoiceNumber: textract.invoiceNumber || bedrock.invoiceNumber,
    invoiceDate: textract.invoiceDate || bedrock.invoiceDate,
    dueDate: textract.dueDate || bedrock.dueDate,
    totalAmount: textract.totalAmount ?? bedrock.totalAmount,
    currency: textract.currency || bedrock.currency,
    lineItems: textract.lineItems?.length ? textract.lineItems : bedrock.lineItems,
    // Average confidence, weighted toward Bedrock when it was used
    confidence: (textract.confidence + bedrock.confidence) / 2,
  };
}
