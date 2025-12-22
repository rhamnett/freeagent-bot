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
│       ├── gmail-poller/        # Polls Gmail for invoices
│       ├── textract-request/    # Starts async Textract jobs
│       ├── textract-retrieve/   # Retrieves Textract results via SNS
│       ├── bedrock-enhance/     # Claude AI enhancement
│       ├── matcher/             # Confidence scoring algorithm
│       ├── freeagent-sync/      # Syncs FreeAgent transactions
│       └── oauth-token-store/   # OAuth token exchange
├── app/                         # Next.js frontend (App Router)
│   ├── page.tsx                # Dashboard
│   ├── settings/page.tsx       # OAuth connections
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

### Data Models
- Defined in `amplify/data/resource.ts`
- Use Amplify Data schema builder (`a.model()`, `a.string()`, etc.)
- All models use owner-based authorization
- Create secondary indexes for query patterns

## Architecture Patterns

### Async Invoice Processing (Step Functions)
```
Gmail Poller → S3 Upload → Start Step Functions
                              ↓
              ┌───────────────────────────────┐
              │ Textract Request (WAIT_TOKEN) │
              └───────────────────────────────┘
                              ↓ (SNS callback)
              ┌───────────────────────────────┐
              │ Textract Retrieve             │
              │ (SendTaskSuccess)             │
              └───────────────────────────────┘
                              ↓
              ┌───────────────────────────────┐
              │ Bedrock Enhance               │
              │ (Claude AI selection)         │
              └───────────────────────────────┘
                              ↓
              ┌───────────────────────────────┐
              │ Matcher                       │
              │ (Confidence scoring)          │
              └───────────────────────────────┘
```

### OAuth Token Storage
- Tokens stored in **AWS Secrets Manager** (not DynamoDB)
- `OAuthConnection` table stores metadata + `secretArn`
- Auto-refresh on expiration in API clients

### Matching Algorithm (3 factors)
1. **Amount** (40% weight): Exact match → Tolerance bands
   - Automatic currency conversion for foreign invoices (USD→GBP)
   - Uses historical exchange rates from invoice date
2. **Date** (30% weight): Days difference scoring
3. **Vendor** (30% weight): AI-powered fuzzy matching (Bedrock Haiku)

## Common Tasks

### Adding a New Lambda Function
1. Create folder in `amplify/functions/new-function/`
2. Add `handler.ts` with Lambda handler
3. Add `resource.ts` with `defineFunction()` export
4. Import in `amplify/backend.ts`
5. Add environment variables and IAM permissions

### Adding a New DynamoDB Model
1. Add model definition in `amplify/data/resource.ts`
2. Add secondary indexes for query patterns
3. Export type with `export type Schema = ClientSchema<typeof schema>`
4. Access via `client.models.ModelName.list()`

### Modifying Step Functions
1. Edit `amplify/cdk/invoice-processor-sfn.ts`
2. States defined using `sfn.Pass`, `sfn.TaskStateFromInput`, etc.
3. Configure retry policies for rate limiting

## Environment Variables

### Amplify Secrets (set via `npx ampx sandbox secret set`)
- `GOOGLE_CLIENT_ID` - Gmail OAuth app client ID
- `GOOGLE_CLIENT_SECRET` - Gmail OAuth app client secret
- `FREEAGENT_CLIENT_ID` - FreeAgent OAuth app client ID
- `FREEAGENT_CLIENT_SECRET` - FreeAgent OAuth app client secret
- `FREEAGENT_USE_SANDBOX` - "true" for sandbox API

### Auto-configured by CDK
- `OAUTH_TABLE`, `INVOICE_TABLE`, `TRANSACTION_TABLE`, `MATCH_TABLE`, `SETTINGS_TABLE`
- `STORAGE_BUCKET_NAME`
- `INVOICE_STATE_MACHINE_ARN`
- `TEXTRACT_SNS_TOPIC_ARN`, `TEXTRACT_SNS_ROLE_ARN`

## AI Model Usage

### Textract
- Uses **async ExpenseAnalysis API** (optimized for invoices)
- Returns candidate values (amounts, vendors, dates) with confidence
- Triggered via SNS callback pattern (no polling)

### Bedrock Claude
- **Sonnet** (`eu.anthropic.claude-sonnet-4-5-20250929-v1:0`): Invoice enhancement
  - Analyzes invoice image + Textract candidates
  - Intelligently selects correct total amount
- **Haiku** (`eu.anthropic.claude-3-haiku-20240307-v1:0`): Vendor matching
  - Fast fuzzy name comparison
  - Handles abbreviations (AMZN → Amazon)

## Testing Notes

- `FAKE_AWS_AS_UNEXPLAINED=true` fakes AWS transactions as unexplained for testing matching
- EventBridge schedules disabled by default (enable after OAuth setup)
- Use manual sync buttons in Settings page for testing

## Debugging

### Step Functions
- View execution in AWS Console → Step Functions
- Check Lambda CloudWatch logs for each step
- taskToken stored in Invoice record for debugging

### DynamoDB
- Query by `textractJobId` index to find invoice from Textract job
- Query by `gmailMessageId` to find invoice from Gmail

## Documentation

See `docs/` folder for detailed documentation:
- `ARCHITECTURE.md` - System architecture deep-dive
- `AI-INTEGRATION.md` - Textract and Bedrock integration patterns
- `MATCHING-ALGORITHM.md` - Confidence scoring algorithm
- `OAUTH-FLOW.md` - OAuth token exchange and refresh flows
- `DEPLOYMENT.md` - Deployment and configuration guide
