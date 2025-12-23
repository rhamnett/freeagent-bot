# FreeAgent Invoice Matching Bot - Claude Code Guidelines

## Project Overview

This is an **AWS Amplify Gen2** AI-powered invoice email matching system for FreeAgent.com. It automatically extracts invoices from Gmail attachments, uses AI (AWS Textract + Amazon Bedrock Claude) to parse invoice data, and intelligently matches them to FreeAgent bank transactions with confidence scoring.

## Tech Stack

- **Frontend**: Next.js 15 (App Router) + React 19 + Tailwind CSS + Shadcn/ui
- **Backend**: AWS Amplify Gen2 + AWS CDK
- **Database**: DynamoDB (via Amplify Data/AppSync GraphQL)
- **Storage**: S3 (via Amplify Storage)
- **Authentication**: Amazon Cognito (Email/Password)
- **AI/ML**: AWS Textract (OCR) + Amazon Bedrock (Claude Sonnet/Haiku)
- **Orchestration**: AWS Step Functions (async invoice processing)
- **APIs**: Gmail API, FreeAgent API v2

## Project Structure

```
freeagent-bot/
├── amplify/                      # Backend infrastructure (IaC)
│   ├── backend.ts               # Main Amplify + CDK definition
│   ├── ai-permissions.ts        # IAM policy helpers
│   ├── auth/resource.ts         # Cognito configuration
│   ├── data/resource.ts         # GraphQL schema + DynamoDB models
│   ├── storage/resource.ts      # S3 bucket configuration
│   ├── cdk/
│   │   └── invoice-processor-sfn.ts  # Step Functions state machine
│   └── functions/               # Lambda functions
│       ├── gmail-poller/        # Polls Gmail for invoice attachments
│       ├── textract-request/    # Starts async Textract OCR jobs
│       ├── textract-retrieve/   # Retrieves Textract results via SNS
│       ├── bedrock-enhance/     # Claude AI enhancement of extracted data
│       ├── matcher/             # Confidence scoring and matching algorithm
│       ├── freeagent-sync/      # Syncs FreeAgent transactions + re-matches
│       ├── freeagent-categories/ # Fetches expense categories
│       ├── approve-match/       # Approves matches in FreeAgent
│       └── oauth-token-store/   # OAuth token exchange and storage
├── app/                         # Next.js frontend (App Router)
│   ├── page.tsx                # Dashboard
│   ├── settings/page.tsx       # OAuth connections + manual sync
│   ├── queue/page.tsx          # Match review queue
│   ├── auth/                   # OAuth callback pages
│   ├── actions/                # Server actions
│   └── providers/              # Auth + Amplify providers
├── components/                  # React components
│   └── ui/                     # Shadcn/ui components
└── lib/                        # Utility functions
```

## Key Commands

```bash
# Development
npm run dev                      # Start Next.js dev server
npx ampx sandbox                 # Deploy backend to sandbox

# Secrets management
npx ampx sandbox secret set GOOGLE_CLIENT_ID
npx ampx sandbox secret set GOOGLE_CLIENT_SECRET
npx ampx sandbox secret set FREEAGENT_CLIENT_ID
npx ampx sandbox secret set FREEAGENT_CLIENT_SECRET
npx ampx sandbox secret set FREEAGENT_USE_SANDBOX "true"

# Code quality
npm run biome:check              # Lint and format check
npm run biome:fix                # Auto-fix linting issues

# Build
npm run build                    # Production build
```

---

## System Architecture

### Complete Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INVOICE PROCESSING FLOW                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Gmail Inbox ──► Gmail Poller ──► S3 Upload ──► Step Functions             │
│                      │                              │                       │
│                      │                              ▼                       │
│              Check duplicates           ┌───────────────────────┐          │
│              (by gmailMessageId)        │  Textract Request     │          │
│                                         │  (async OCR start)    │          │
│                                         └───────────────────────┘          │
│                                                    │                       │
│                                         SNS notification callback          │
│                                                    ▼                       │
│                                         ┌───────────────────────┐          │
│                                         │  Textract Retrieve    │          │
│                                         │  (get OCR results)    │          │
│                                         └───────────────────────┘          │
│                                                    │                       │
│                                                    ▼                       │
│                                         ┌───────────────────────┐          │
│                                         │  Bedrock Enhance      │          │
│                                         │  (Claude AI select)   │          │
│                                         └───────────────────────┘          │
│                                                    │                       │
│                                                    ▼                       │
│                                         ┌───────────────────────┐          │
│                                         │  Matcher              │          │
│                                         │  (confidence scoring) │          │
│                                         └───────────────────────┘          │
│                                                    │                       │
│                                    ┌───────────────┼───────────────┐       │
│                                    ▼               ▼               ▼       │
│                              AUTO_APPROVED     MATCHED        PENDING      │
│                              (score ≥ 85%)   (50-84%)       (< 50%)       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         FREEAGENT SYNC FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  FreeAgent API ──► FreeAgent Sync Lambda                                   │
│                         │                                                   │
│         ┌───────────────┼───────────────┐                                  │
│         ▼               ▼               ▼                                  │
│   "For Approval"   Unexplained     Open Bills                              │
│   Transactions     Transactions                                            │
│         │               │               │                                  │
│         └───────────────┴───────────────┘                                  │
│                         │                                                   │
│                         ▼                                                   │
│              Upsert to Transaction table                                   │
│              (dedupe by freeagentUrl)                                      │
│                         │                                                   │
│                         ▼                                                   │
│         ┌───────────────────────────────┐                                  │
│         │  RE-MATCH PENDING INVOICES    │                                  │
│         │  (last 7 days only)           │                                  │
│         │                               │                                  │
│         │  For each PENDING invoice:    │                                  │
│         │  → Invoke Matcher Lambda      │                                  │
│         │    (async, non-blocking)      │                                  │
│         └───────────────────────────────┘                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Invoice Statuses

| Status | Description |
|--------|-------------|
| `PENDING` | Invoice processed but no matching transaction found (score < 50%) |
| `EXTRACTED` | OCR and AI enhancement complete, ready for matching |
| `MATCHED` | Match found with score 50-84%, awaiting user review |
| `APPROVED` | Match auto-approved (≥85%) or manually approved |
| `FAILED` | Processing failed at some step |

### Processing Steps (Step Functions)

| Step | Description |
|------|-------------|
| `PENDING` | Initial state when invoice created |
| `TEXTRACT_STARTED` | Async Textract job submitted |
| `TEXTRACT_COMPLETE` | OCR results retrieved |
| `BEDROCK_ENHANCE` | AI enhancement in progress |
| `EXTRACTED` | Data extraction complete |
| `MATCHING` | Matching algorithm running |
| `COMPLETE` | All processing finished |
| `FAILED` | Processing failed |

---

## Lambda Functions

### Gmail Poller (`gmail-poller`)
- **Trigger**: Manual sync button or EventBridge schedule (15 min)
- **Purpose**: Poll Gmail for messages with attachments
- **Key behavior**:
  - Scans since `lastGmailPollAt` (or last 30 days if `forceFullScan=true`)
  - Deduplicates by `gmailMessageId` (checks if invoice already exists)
  - Uploads attachments to S3
  - Starts Step Functions execution for each new invoice
  - Updates `lastGmailPollAt` after completion

### FreeAgent Sync (`freeagent-sync`)
- **Trigger**: Manual sync button or EventBridge schedule (30 min)
- **Purpose**: Sync FreeAgent transactions and re-match pending invoices
- **Key behavior**:
  - Always syncs last 30 days of transactions
  - Fetches "For Approval" (marked_for_review) and unexplained transactions
  - Fetches open bills
  - Deduplicates by `freeagentUrl` (upsert logic)
  - **Re-matching**: After sync, queries `PENDING` invoices from last 7 days and triggers matcher for each
  - Updates `lastFreeAgentSyncAt` after completion

### Matcher (`matcher`)
- **Trigger**: Step Functions or FreeAgent sync re-match
- **Purpose**: Find best matching transaction for an invoice
- **Key behavior**:
  - Only processes invoices with `status=EXTRACTED`
  - Requires `vendorName` and `totalAmount` to match
  - Scores against transactions where `needsMatching=true` or `type=BILL`
  - Creates `Match` record with confidence score
  - Updates invoice status based on score thresholds

### Textract Request (`textract-request`)
- **Trigger**: Step Functions
- **Purpose**: Start async Textract ExpenseAnalysis job
- **Key behavior**:
  - Uses `WAIT_FOR_TASK_TOKEN` pattern
  - Stores `taskToken` and `textractJobId` on Invoice record
  - SNS callback triggers textract-retrieve

### Textract Retrieve (`textract-retrieve`)
- **Trigger**: SNS notification from Textract
- **Purpose**: Retrieve OCR results and resume Step Functions
- **Key behavior**:
  - Looks up invoice by `textractJobId` index
  - Calls `SendTaskSuccess` with extracted data
  - Updates invoice `processingStep`

### Bedrock Enhance (`bedrock-enhance`)
- **Trigger**: Step Functions
- **Purpose**: Use Claude AI to select correct values from Textract candidates
- **Key behavior**:
  - Analyzes invoice image + Textract candidate values
  - Selects correct total amount, vendor name, dates
  - Handles multi-page invoices
  - Updates Invoice record with final extracted data

### Approve Match (`approve-match`)
- **Trigger**: GraphQL mutation from UI
- **Purpose**: Approve a match and create FreeAgent explanation
- **Key behavior**:
  - Downloads invoice PDF from S3
  - Uploads as attachment to FreeAgent transaction
  - Creates bank transaction explanation (marks as explained)
  - Updates match and invoice status

---

## Matching Algorithm

### Confidence Scoring (3 factors)

| Factor | Weight | Description |
|--------|--------|-------------|
| **Amount** | 40% | Exact match → tolerance bands (1%, 5%, 10%) |
| **Date** | 30% | Days difference scoring (0-30 days) |
| **Vendor** | 30% | AI-powered fuzzy matching (Bedrock Haiku) |

### Amount Matching
- Exact match: 100%
- Within 1%: 90%
- Within 5%: 70%
- Within 10%: 50%
- **Currency conversion**: Foreign invoices (USD, EUR) auto-converted to GBP using historical exchange rates from invoice date

### Date Matching
- Same day: 100%
- Within 3 days: 90%
- Within 7 days: 70%
- Within 14 days: 50%
- Within 30 days: 30%

### Vendor Matching
- Uses Bedrock Haiku for fuzzy comparison
- Handles abbreviations (AMZN → Amazon)
- Handles variations (Amazon Web Services → AWS)
- Returns similarity score 0-100%

### Thresholds
- **Auto-approve**: ≥85% confidence (configurable per user)
- **Review queue**: 50-84% confidence
- **No match**: <50% confidence → status `PENDING`

---

## Re-matching Feature

### Problem Solved
When an invoice email arrives **before** the corresponding FreeAgent bank transaction:
1. Invoice processed → Matcher runs → No matching transaction → Status = `PENDING`
2. FreeAgent transaction appears later → Synced to database
3. **Without re-matching**: Old invoice would never be matched

### Solution
After FreeAgent sync completes:
1. Query all invoices with `status=PENDING` from last 7 days
2. For each pending invoice, invoke Matcher Lambda asynchronously
3. Matcher re-evaluates against all available transactions (including newly synced ones)

### Why 7 Days?
- Limits LLM costs (Bedrock calls for vendor matching)
- Covers typical bank posting delays (1-3 days)
- Invoices older than 7 days likely need manual attention anyway

---

## Deduplication Logic

### Important DynamoDB Behavior
**Never use `limit` with `filter` on DynamoDB scans!**

DynamoDB applies `limit` BEFORE `filter`, meaning:
- `limit: 1` with `filter: { id: { eq: 'abc' } }` scans 1 item, then filters
- If that 1 item doesn't match, returns 0 results even if matches exist

### Correct Pattern
```typescript
// WRONG - May miss duplicates!
const { data } = await dataClient.models.Invoice.list({
  filter: { gmailMessageId: { eq: messageId } },
  limit: 1,  // DON'T DO THIS
});

// CORRECT - Full scan with filter
const { data } = await dataClient.models.Invoice.list({
  filter: { gmailMessageId: { eq: messageId } },
});
```

### Where Deduplication Occurs
- **Gmail Poller**: Checks `gmailMessageId` before processing
- **FreeAgent Sync**: Checks `freeagentUrl` before creating/updating transactions

---

## Sync Behavior

### Gmail Sync (`triggerGmailSync`)
| Parameter | Default | Behavior |
|-----------|---------|----------|
| `forceFullScan=false` | ✓ | Scans from `lastGmailPollAt` |
| `forceFullScan=true` | | Scans last 30 days |

### FreeAgent Sync (`triggerFreeAgentSync`)
- Always syncs last 30 days of transactions
- No `forceFullScan` parameter needed (transactions are upserted)
- Re-matching only looks at last 7 days of pending invoices

---

## Data Models

### Invoice
```typescript
{
  id: string;              // Auto-generated
  userId: string;          // Owner
  gmailMessageId: string;  // Gmail message ID (dedup key)
  attachmentId: string;
  s3Key: string;           // S3 path to PDF/image
  senderEmail: string;
  receivedAt: datetime;
  // Extracted fields
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: date;
  dueDate: date;
  totalAmount: float;
  currency: string;
  lineItems: json;
  // Processing state
  status: InvoiceStatus;
  processingStep: ProcessingStep;
  taskToken: string;       // Step Functions callback token
  textractJobId: string;   // Textract async job ID
  stepFunctionExecutionArn: string;
}
```

### Transaction
```typescript
{
  id: string;              // Auto-generated
  userId: string;          // Owner
  freeagentUrl: string;    // FreeAgent URL (dedup key)
  type: 'BANK_TRANSACTION' | 'BILL';
  amount: float;
  date: date;
  description: string;
  unexplainedAmount: float;
  contactName: string;     // For bills
  status: string;          // Open, Overdue, Paid
  needsMatching: boolean;  // True for "For Approval" transactions
  lastSyncedAt: datetime;
}
```

### Match
```typescript
{
  id: string;              // "{invoiceId}-{transactionId}"
  userId: string;
  invoiceId: string;
  transactionId: string;
  confidenceScore: float;  // 0-1
  matchReasons: string[];  // Human-readable reasons
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'AUTO_APPROVED';
  reviewedAt: datetime;
}
```

---

## OAuth Token Storage

### Architecture
- Tokens stored in **AWS Secrets Manager** (secure, encrypted)
- `OAuthConnection` DynamoDB table stores metadata only:
  - `secretArn` - Reference to Secrets Manager secret
  - `expiresAt` - Token expiration time
  - `email` - Connected account email

### Auto-refresh
Both Gmail and FreeAgent clients:
1. Check token expiration before API calls
2. If expiring within 5 minutes, refresh using refresh_token
3. Update Secrets Manager with new tokens

---

## Environment Variables

### Amplify Secrets (set via `npx ampx sandbox secret set`)
| Secret | Description |
|--------|-------------|
| `GOOGLE_CLIENT_ID` | Gmail OAuth app client ID |
| `GOOGLE_CLIENT_SECRET` | Gmail OAuth app client secret |
| `FREEAGENT_CLIENT_ID` | FreeAgent OAuth app client ID |
| `FREEAGENT_CLIENT_SECRET` | FreeAgent OAuth app client secret |
| `FREEAGENT_USE_SANDBOX` | "true" for sandbox API |

### Auto-configured by CDK
| Variable | Description |
|----------|-------------|
| `OAUTH_TABLE` | OAuthConnection DynamoDB table name |
| `INVOICE_TABLE` | Invoice DynamoDB table name |
| `TRANSACTION_TABLE` | Transaction DynamoDB table name |
| `MATCH_TABLE` | Match DynamoDB table name |
| `SETTINGS_TABLE` | UserSettings DynamoDB table name |
| `STORAGE_BUCKET_NAME` | S3 bucket for invoice storage |
| `INVOICE_STATE_MACHINE_ARN` | Step Functions state machine ARN |
| `TEXTRACT_SNS_TOPIC_ARN` | SNS topic for Textract callbacks |
| `TEXTRACT_SNS_ROLE_ARN` | IAM role for Textract to publish SNS |
| `MATCHER_FUNCTION_NAME` | Matcher Lambda function name (for re-matching) |

---

## AI Model Usage

### Textract
- Uses **async ExpenseAnalysis API** (optimized for invoices)
- Returns candidate values with confidence scores
- Triggered via SNS callback pattern (no polling)

### Bedrock Claude
| Model | Use Case | Model ID |
|-------|----------|----------|
| **Sonnet** | Invoice enhancement | `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| **Haiku** | Vendor matching | `eu.anthropic.claude-3-haiku-20240307-v1:0` |

---

## Code Style & Conventions

### TypeScript
- **Strict mode enabled** - no implicit `any`
- **Never use `any` type** - create proper interfaces for all types
- Use `type` imports: `import type { Schema } from './resource'`
- Lambda handlers use ES2022 module syntax

### Formatting (Biome)
- **2 spaces** indentation
- **Single quotes** for strings
- **Semicolons required**
- **100 char line width**
- Run `npm run biome:check` after changes

### File Naming
- React components: `PascalCase.tsx`
- Utilities/handlers: `kebab-case.ts`
- Resources: `resource.ts` (Amplify convention)

### Lambda Functions
Each Lambda in `amplify/functions/` follows this structure:
```
function-name/
├── handler.ts     # Main handler with AWS SDK clients
├── resource.ts    # defineFunction() export
└── types.ts       # Type definitions (optional)
```

---

## Testing Notes

- `FAKE_AWS_AS_UNEXPLAINED=true` fakes AWS transactions as unexplained for testing
- EventBridge schedules disabled by default (enable after OAuth setup)
- Use manual sync buttons in Settings page for testing
- Clear All Data button resets poll timestamps for fresh testing

---

## Debugging

### Step Functions
- View execution in AWS Console → Step Functions
- Check Lambda CloudWatch logs for each step
- `taskToken` stored in Invoice record for debugging

### DynamoDB Queries
- Query by `textractJobId` index to find invoice from Textract job
- Query by `gmailMessageId` to find invoice from Gmail
- Query by `freeagentUrl` to find transaction

### CloudWatch Logs
Each Lambda logs:
- Input event parameters
- Processing steps and counts
- Errors with stack traces

---

## Common Issues

### Duplicate Records
**Cause**: Using `limit` with `filter` in DynamoDB queries
**Fix**: Remove `limit` parameter, let filter work on full scan

### Invoices Not Matching
**Cause**: Invoice arrived before bank transaction synced
**Fix**: Re-matching feature triggers after FreeAgent sync

### OAuth Token Expired
**Cause**: Refresh token also expired (rare)
**Fix**: User needs to re-authenticate via Settings page
