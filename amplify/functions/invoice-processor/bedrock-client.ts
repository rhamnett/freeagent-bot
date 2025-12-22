/**
 * @file amplify/functions/invoice-processor/bedrock-client.ts
 * @description AWS Bedrock client for Claude-based invoice analysis
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

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

// Use eu-west-1 for Bedrock as it supports cross-region inference profiles
const bedrockClient = new BedrockRuntimeClient({ region: 'eu-west-1' });

// Claude model IDs - using EU cross-region inference profiles
const CLAUDE_SONNET_MODEL = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';
const CLAUDE_HAIKU_MODEL = 'eu.anthropic.claude-3-haiku-20240307-v1:0';

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

/**
 * Extract invoice data using Claude vision capabilities
 */
export async function extractInvoiceWithBedrock(
  imageBytes: Buffer,
  mimeType: string
): Promise<ExtractedInvoiceData> {
  // Convert buffer to base64
  const base64Image = imageBytes.toString('base64');

  // Map mime type to Bedrock format
  let mediaType: string;
  switch (mimeType.toLowerCase()) {
    case 'application/pdf':
      // For PDFs, we need to convert to image first or use document processing
      // For now, we'll try treating it as an image (works for single-page PDFs)
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

  const messages: BedrockMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'image',
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

  // Extract the text response
  const textContent = responseBody.content.find((c) => c.type === 'text');
  if (!textContent) {
    throw new Error('No text response from Bedrock');
  }

  // Parse the JSON from the response
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
  const result: ExtractedInvoiceData = {
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
    confidence: 0.9, // Claude typically provides high-quality extraction
  };

  return result;
}

/**
 * Compare vendor names using Claude for fuzzy matching
 */
export async function compareVendorNames(
  invoiceVendor: string,
  transactionVendor: string
): Promise<number> {
  const prompt = `Compare these two business/vendor names and determine if they refer to the same entity.

Invoice vendor: "${invoiceVendor}"
Transaction vendor: "${transactionVendor}"

Consider:
- Abbreviations (e.g., "Amazon" vs "AMZN", "McDonald's" vs "MCDONALDS")
- Slight variations in spelling or formatting
- Parent/subsidiary relationships
- Common trading names vs legal names

Return ONLY a number between 0 and 1 representing the probability they are the same vendor:
- 1.0 = Definitely the same
- 0.8+ = Very likely the same
- 0.5-0.8 = Possibly the same
- 0.2-0.5 = Unlikely but possible
- 0.0-0.2 = Definitely different

Return only the number, nothing else.`;

  const messages: BedrockMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
  ];

  const command = new InvokeModelCommand({
    modelId: CLAUDE_HAIKU_MODEL, // Use faster/cheaper model for this
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 100,
      messages,
    }),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body)) as BedrockResponse;

  const textContent = responseBody.content.find((c) => c.type === 'text');
  if (!textContent) {
    return 0;
  }

  const score = parseFloat(textContent.text.trim());
  return Number.isNaN(score) ? 0 : Math.max(0, Math.min(1, score));
}
