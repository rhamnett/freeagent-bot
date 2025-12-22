# AI/ML Integration Guide

## Overview

This system uses two AWS AI services for intelligent invoice processing:

1. **AWS Textract** - OCR and structured data extraction
2. **Amazon Bedrock (Claude)** - Intelligent verification and fuzzy matching

## AWS Textract Integration

### API Choice: ExpenseAnalysis

We use the **async ExpenseAnalysis API** rather than synchronous DocumentAnalysis because:
- Optimized for invoices, receipts, and expense documents
- Returns structured expense-specific fields
- Handles multi-page documents efficiently
- Better extraction of amounts, dates, and vendor info

### Async Processing Pattern

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  textract-      │     │   Textract      │     │  textract-      │
│  request        │────▶│   Service       │────▶│  retrieve       │
│  Lambda         │     │   (async)       │     │  Lambda         │
└────────┬────────┘     └─────────────────┘     └────────┬────────┘
         │                      │                        │
         │ StartExpenseAnalysis │                        │ GetExpenseAnalysis
         │                      │                        │ SendTaskSuccess
         │                      ▼                        │
         │              ┌─────────────────┐              │
         │              │    SNS Topic    │──────────────┘
         │              │  (completion)   │
         │              └─────────────────┘
         │
         ▼
   Step Functions
   (WAIT_FOR_TASK_TOKEN)
```

### Why Async Over Sync?

1. **No Polling Required**: SNS callback eliminates the need for polling loops
2. **Better Scaling**: Step Functions handles wait state natively
3. **Rate Limit Friendly**: Natural backpressure through async processing
4. **Cost Efficient**: No Lambda compute wasted on waiting

### IAM Setup

Textract requires a special IAM configuration:

```typescript
// 1. Textract needs to read from S3 (via assumed role)
const textractSnsRole = new iam.Role(stack, 'TextractSnsRole', {
  assumedBy: new iam.ServicePrincipal('textract.amazonaws.com'),
});

// 2. Grant S3 access to the Textract role
textractSnsRole.addToPolicy(new iam.PolicyStatement({
  actions: ['s3:*'],
  resources: [bucketArn, `${bucketArn}/*`],
}));

// 3. Grant SNS publish permission
textractNotificationTopic.grantPublish(textractSnsRole);

// 4. Lambda needs PassRole permission
textractRequestRole.addToPolicy(new iam.PolicyStatement({
  actions: ['iam:PassRole'],
  resources: [textractSnsRole.roleArn],
}));
```

### Textract Response Processing

Textract returns structured expense data with confidence scores:

```typescript
// ExpenseDocument structure
interface ExpenseDocument {
  SummaryFields: SummaryField[];      // Key-value pairs (vendor, date, total)
  LineItemGroups: LineItemGroup[];    // Table rows (line items)
}

interface SummaryField {
  Type: { Text: string; Confidence: number };   // e.g., "TOTAL", "VENDOR_NAME"
  LabelDetection?: { Text: string };            // Label as shown on document
  ValueDetection?: { Text: string };            // Extracted value
}
```

### Extracting Candidate Values

Rather than taking Textract's "best guess", we extract ALL candidate values:

```typescript
// Extract all candidate amounts for LLM selection
const candidateAmounts: CandidateAmount[] = [];

for (const field of summaryFields) {
  if (field.Type?.Text?.includes('AMOUNT') || field.Type?.Text?.includes('TOTAL')) {
    const value = parseFloat(field.ValueDetection?.Text?.replace(/[^0-9.-]/g, '') || '0');
    candidateAmounts.push({
      value,
      type: field.Type.Text,               // e.g., "TOTAL", "TAX", "SUBTOTAL"
      label: field.LabelDetection?.Text,   // Label shown on invoice
      currency: detectCurrency(field.ValueDetection?.Text),
      confidence: field.Type.Confidence,
    });
  }
}
```

This approach is crucial for **multi-currency invoices** (e.g., AWS invoices showing both USD and GBP).

## Amazon Bedrock Integration

### Models Used

| Model | Use Case | Why |
|-------|----------|-----|
| Claude Sonnet 4.5 | Invoice extraction | Vision capability, high accuracy |
| Claude Haiku 3.0 | Vendor matching | Fast, cost-effective for text comparison |

### Model Configuration

```typescript
// EU inference profile for Claude Sonnet
const CLAUDE_SONNET_MODEL = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';

// Standard Haiku for vendor matching
const CLAUDE_HAIKU_MODEL = 'eu.anthropic.claude-3-haiku-20240307-v1:0';
```

### Bedrock Enhancement Workflow

The `bedrock-enhance` Lambda receives Textract output and the original document:

```
┌─────────────────────────────────────────────────────────────┐
│                    Bedrock Enhance                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  INPUT:                                                     │
│    • Original invoice image (base64)                        │
│    • Textract candidate amounts                             │
│    • Textract candidate vendors                             │
│    • Textract candidate dates                               │
│                                                             │
│  CLAUDE PROMPT:                                             │
│    1. View the actual document                              │
│    2. Review all candidate amounts                          │
│    3. Select the correct GBP total for bank matching        │
│    4. Handle multi-currency conversion (USD→GBP)            │
│    5. Verify vendor name (issuer, not recipient)            │
│                                                             │
│  OUTPUT:                                                    │
│    • Enhanced extraction with high confidence               │
│    • Correct total amount (especially for multi-currency)   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Multi-Currency Handling

The key challenge is AWS invoices that show both USD and GBP:

```
Invoice shows:
  - Total USD: $123.45
  - Currency conversion: $123.45 × 0.79 = £97.53
  - Total GBP: £97.53  ← This is what appears on bank statement

Textract returns BOTH amounts as candidates.
Claude selects the GBP amount based on:
  1. Business context (UK company)
  2. Bank statement matching requirement
  3. Visual analysis of the document structure
```

### Prompt Engineering

```typescript
const INVOICE_EXTRACTION_PROMPT = `
Analyze this invoice and extract:
{
  "vendorName": "...",
  "invoiceNumber": "...",
  "invoiceDate": "YYYY-MM-DD",
  "totalAmount": number,
  "currency": "GBP/USD/EUR"
}

MULTI-CURRENCY HANDLING (CRITICAL):
- This is for a UK business, prefer GBP amounts
- If invoice shows BOTH USD and GBP (like AWS):
  - Extract the GBP TOTAL (what bank will charge)
  - NOT the original USD amount
- Look for "Total in GBP" or converted amount

=== OCR DATA (from Textract) ===
CANDIDATE AMOUNTS:
  - GBP 97.53 (TOTAL: "Total for this invoice in GBP")
  - USD 123.45 (TOTAL: "Total Amount Due")

SELECT the correct GBP total for UK bank matching.
`;
```

### Vision API Usage

```typescript
const messages: BedrockMessage[] = [
  {
    role: 'user',
    content: [
      {
        type: mimeType === 'application/pdf' ? 'document' : 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: base64EncodedContent,
        },
      },
      {
        type: 'text',
        text: promptWithTextractData,
      },
    ],
  },
];

const response = await bedrockClient.send(new InvokeModelCommand({
  modelId: CLAUDE_SONNET_MODEL,
  body: JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    messages,
  }),
}));
```

### Vendor Name Comparison (Haiku)

For fuzzy vendor matching in the scoring algorithm:

```typescript
export async function compareVendorNames(
  invoiceVendor: string,
  transactionVendor: string
): Promise<number> {
  const prompt = `Compare these vendor names and return similarity (0-1):
Invoice: "${invoiceVendor}"
Transaction: "${transactionVendor}"

Consider:
- Abbreviations (AMZN vs Amazon)
- Spelling variations (McDonald's vs MCDONALDS)
- Parent/subsidiary (AWS vs Amazon Web Services)
- Trading names vs legal names

Return ONLY a number between 0 and 1.`;

  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: CLAUDE_HAIKU_MODEL,
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 10,
      messages: [{ role: 'user', content: prompt }],
    }),
  }));

  return parseFloat(responseText);
}
```

## Error Handling

### Textract Errors

```typescript
// Rate limiting - handled by Step Functions retry
if (error.name === 'ThrottlingException') {
  // Step Functions retries: 5 attempts, 45s initial, 2.5x backoff
}

// Document processing error
if (error.name === 'InvalidS3ObjectException') {
  // Check S3 bucket policy, object exists, permissions
}
```

### Bedrock Errors

```typescript
// Model availability
if (error.name === 'ServiceUnavailableException') {
  // Step Functions retries: 3 attempts, 5s initial, 2x backoff
}

// Fallback to Textract-only data
try {
  const bedrockData = await extractInvoiceWithBedrock(...);
} catch (error) {
  console.warn('Bedrock failed, using Textract data only');
  return textractData;
}
```

## Cost Optimization

### Textract
- Use async API (charged per page, not per request)
- Batch multiple pages in single job where possible
- Store raw output for debugging (avoid re-processing)

### Bedrock
- **Sonnet**: Use only for invoice enhancement (high-value extraction)
- **Haiku**: Use for vendor comparison (fast, cheap)
- Cache vendor comparison results when possible
- Keep prompts concise to reduce token usage

## Best Practices

### 1. Always Provide Context to Claude
```typescript
// BAD: Just the image
messages = [{ type: 'image', ... }];

// GOOD: Image + Textract candidates + specific instructions
messages = [
  { type: 'image', ... },
  { type: 'text', text: 'Here are OCR candidates... Select the correct GBP total...' }
];
```

### 2. Structure Prompts for JSON Output
```typescript
// Request JSON format explicitly
const prompt = `Return ONLY a JSON object, no other text:
{
  "vendorName": "...",
  "totalAmount": number  // NOT string
}`;

// Parse with fallback
const jsonMatch = response.match(/\{[\s\S]*\}/);
if (!jsonMatch) throw new Error('No JSON in response');
```

### 3. Handle Multi-Currency Early
```typescript
// In prompt, be explicit about currency preference
`This is for a UK business.
If multiple currencies shown, extract the GBP amount.
That's what will appear on the bank statement.`
```

### 4. Log Candidates for Debugging
```typescript
console.log(`Candidate amounts from Textract: ${candidateAmounts.length}`);
console.log(JSON.stringify(candidateAmounts, null, 2));
// Helps debug when wrong amount is selected
```
