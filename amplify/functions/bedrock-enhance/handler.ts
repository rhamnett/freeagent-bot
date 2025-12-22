/**
 * @file amplify/functions/bedrock-enhance/handler.ts
 * @description Use Bedrock Claude to enhance/verify low-confidence Textract extractions
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Handler } from 'aws-lambda';

interface CandidateAmount {
  value: number;
  type: string;
  currency?: string;
  label?: string;
  confidence: number;
}

interface CandidateVendor {
  name: string;
  type: string;
  confidence: number;
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
  // New: All candidate amounts from Textract for LLM selection
  candidateAmounts?: CandidateAmount[];
  candidateVendors?: CandidateVendor[];
  candidateDates?: string[];
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
    | {
        type: 'document';
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

// Always run Bedrock for all invoices to ensure accurate extraction
// especially for multi-currency invoices like AWS

const INVOICE_EXTRACTION_PROMPT = `Analyze this invoice/receipt and extract the following information in JSON format:

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

CRITICAL RULES:
- Return ONLY the JSON object, no other text
- Use null for any fields you cannot determine with confidence
- For amounts, extract the numeric value only (e.g., 123.45 not "£123.45")
- For dates, use YYYY-MM-DD format
- If this is not an invoice/receipt, return {"error": "Not an invoice"}

MULTI-CURRENCY HANDLING (VERY IMPORTANT):
- This is for a UK business, so prefer GBP amounts when available
- If the invoice shows BOTH USD and GBP amounts (e.g., AWS invoices with currency conversion):
  - Extract the GBP TOTAL as totalAmount (the amount that would appear on a UK bank statement)
  - Set currency to "GBP"
  - Look for the converted/local currency total, NOT the original USD amount
- For AWS/Amazon invoices specifically: find the "Total for this invoice in GBP" or similar GBP total
- The correct GBP amount is what the bank will charge, after any currency conversion`;

export const handler: Handler<BedrockEnhanceEvent, BedrockEnhanceResult> = async (event) => {
  const { invoiceId, userId: _userId, s3Key, bucketName, extractedData, confidence } = event;

  console.log(`Bedrock enhance for invoice ${invoiceId}, Textract confidence: ${confidence}`);
  console.log(`Candidate amounts from Textract: ${extractedData.candidateAmounts?.length || 0}`);
  console.log(`Candidate vendors from Textract: ${extractedData.candidateVendors?.length || 0}`);

  // Always run Bedrock for accurate extraction, especially multi-currency handling
  console.log(`Processing invoice ${invoiceId} with Bedrock Claude Vision`);

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

  // Call Bedrock for extraction, passing Textract data for context
  const bedrockData = await extractInvoiceWithBedrock(Buffer.from(imageBytes), mimeType, extractedData);

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
  mimeType: string,
  textractData?: ExtractedInvoiceData
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
  
  // Build the prompt with ALL candidate data from Textract for intelligent selection
  let promptText = INVOICE_EXTRACTION_PROMPT;
  
  if (textractData) {
    // Format candidate amounts for clear presentation
    const candidateAmountsText = textractData.candidateAmounts?.length 
      ? textractData.candidateAmounts.map(a => 
          `  - ${a.currency || '?'} ${a.value.toFixed(2)} (${a.type}: "${a.label || a.type}")`
        ).join('\n')
      : '  (none detected)';
    
    // Format candidate vendors
    const candidateVendorsText = textractData.candidateVendors?.length
      ? textractData.candidateVendors.map(v => 
          `  - "${v.name}" (${v.type})`
        ).join('\n')
      : '  (none detected)';
    
    // Format candidate dates
    const candidateDatesText = textractData.candidateDates?.length
      ? textractData.candidateDates.map(d => `  - "${d}"`).join('\n')
      : '  (none detected)';

    promptText += `

=== OCR EXTRACTION DATA (from AWS Textract) ===

CANDIDATE AMOUNTS (choose the correct GBP total for UK bank matching):
${candidateAmountsText}

CANDIDATE VENDORS:
${candidateVendorsText}

CANDIDATE DATES:
${candidateDatesText}

CURRENT BEST GUESSES (may be wrong):
- Vendor: ${textractData.vendorName || 'unknown'}
- Amount: ${textractData.totalAmount || 'unknown'} ${textractData.currency || ''}
- Date: ${textractData.invoiceDate || 'unknown'}

=== YOUR TASK ===

1. Look at the actual document image above
2. Review the candidate amounts and select the CORRECT GBP total that would match a UK bank statement
3. For AWS invoices: The "TOTAL AMOUNT" in GBP (not USD) is what the bank charges
4. Verify the vendor name - prefer the actual issuer (e.g., "AMAZON WEB SERVICES EMEA SARL" not the recipient)
5. Convert dates to YYYY-MM-DD format
6. Return corrected JSON`;
  }
  
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
          text: promptText,
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
 * PREFER BEDROCK for key fields since it makes intelligent selections from candidates
 * Bedrock sees both the document AND the Textract data, so it can correct errors
 */
function mergeExtractionResults(
  textract: ExtractedInvoiceData,
  bedrock: ExtractedInvoiceData
): ExtractedInvoiceData {
  return {
    // Prefer Bedrock's vendor (it can distinguish issuer from recipient)
    vendorName: bedrock.vendorName || textract.vendorName,
    // Prefer Bedrock's invoice number
    invoiceNumber: bedrock.invoiceNumber || textract.invoiceNumber,
    // Prefer Bedrock's date (it converts to ISO format)
    invoiceDate: bedrock.invoiceDate || textract.invoiceDate,
    dueDate: bedrock.dueDate || textract.dueDate,
    // CRITICALLY: Prefer Bedrock's amount (it selects correct GBP from candidates)
    totalAmount: bedrock.totalAmount ?? textract.totalAmount,
    currency: bedrock.currency || textract.currency,
    // Keep Textract line items as they're more detailed
    lineItems: textract.lineItems?.length ? textract.lineItems : bedrock.lineItems,
    // High confidence since Bedrock verified/corrected
    confidence: 0.95,
  };
}
