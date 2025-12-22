# FreeAgent Invoice Matching Bot

An intelligent invoice processing system that automatically extracts invoices from Gmail, processes them with AWS Textract + Bedrock AI, and matches them against FreeAgent bank transactions.

## 🎯 What It Does

1. **Polls Gmail** for emails with PDF/image attachments (invoices)
2. **Extracts data** using AWS Textract (OCR) + Claude AI (intelligent enhancement)
3. **Syncs transactions** from your FreeAgent account
4. **Matches invoices** to bank transactions with confidence scoring
5. **Presents matches** for review or auto-approval

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Gmail Poller Lambda                            │
│                                                                         │
│  • Polls Gmail for attachments (PDFs, images)                          │
│  • Uploads to S3                                                        │
│  • Starts Step Functions execution per invoice                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Step Functions State Machine                          │
│                                                                         │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────┐ │
│  │   Textract   │──▶│   Textract   │──▶│   Bedrock    │──▶│ Matcher  │ │
│  │   Request    │   │   Retrieve   │   │   Enhance    │   │          │ │
│  └──────────────┘   └──────────────┘   └──────────────┘   └──────────┘ │
│         │                   ▲                                           │
│         │     SNS Topic     │                                           │
│         └───────────────────┘                                           │
│              (Async callback)                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        FreeAgent Sync Lambda                             │
│                                                                         │
│  • Fetches bank transactions from FreeAgent API                         │
│  • Stores in DynamoDB for matching                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Processing Flow

1. **Textract Request** → Starts async Textract ExpenseAnalysis job
2. **SNS Notification** → Textract publishes completion to SNS topic
3. **Textract Retrieve** → SNS triggers Lambda to fetch results, sends callback to Step Functions
4. **Bedrock Enhance** → Claude AI reviews and corrects extraction (especially multi-currency invoices)
5. **Matcher** → Confidence scoring algorithm matches invoice to transactions

## 🛠️ Tech Stack

- **Frontend**: Next.js 14 (App Router) + Tailwind CSS
- **Backend**: AWS Amplify Gen 2
- **Auth**: Amazon Cognito
- **Database**: DynamoDB (via Amplify Data)
- **Storage**: S3 (via Amplify Storage)
- **AI/ML**: AWS Textract + Amazon Bedrock (Claude 3.5 Sonnet)
- **Orchestration**: AWS Step Functions
- **APIs**: Gmail API, FreeAgent API

## 📋 Prerequisites

- Node.js 18+ 
- AWS Account with Amplify access
- Google Cloud Console project (for Gmail API)
- FreeAgent Developer account

## 🚀 Quick Start

### 1. Clone and Install

```bash
git clone <repo-url>
cd freeagent-bot
npm install
```

### 2. Configure Amplify Secrets

The application requires several secrets to be configured in AWS Amplify. Use the Amplify CLI:

```bash
# Google OAuth (for Gmail)
npx ampx sandbox secret set GOOGLE_CLIENT_ID
npx ampx sandbox secret set GOOGLE_CLIENT_SECRET

# FreeAgent OAuth
npx ampx sandbox secret set FREEAGENT_CLIENT_ID
npx ampx sandbox secret set FREEAGENT_CLIENT_SECRET
npx ampx sandbox secret set FREEAGENT_USE_SANDBOX  # Set to "false" for production
```

### 3. Start Development

```bash
npx ampx sandbox
```

This starts the Amplify sandbox which:
- Deploys all Lambda functions
- Creates DynamoDB tables
- Sets up the Step Functions state machine
- Configures S3 bucket with Textract permissions

### 4. Start the Frontend

```bash
npm run dev
```

Visit `http://localhost:3000`

## 🔐 OAuth Setup

### Gmail OAuth Setup

1. **Create Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing
   - Enable the **Gmail API**

2. **Configure OAuth Consent Screen**
   - Go to APIs & Services → OAuth consent screen
   - Choose "External" user type
   - Fill in app name, user support email
   - Add scopes:
     - `https://www.googleapis.com/auth/gmail.readonly`
   - Add your email as a test user (if in testing mode)

3. **Create OAuth Credentials**
   - Go to APIs & Services → Credentials
   - Click "Create Credentials" → "OAuth client ID"
   - Application type: **Web application**
   - Add Authorized redirect URIs:
     - `http://localhost:3000/auth/gmail/callback` (development)
     - `https://your-domain.com/auth/gmail/callback` (production)
   - Copy the **Client ID** and **Client Secret**

4. **Set Amplify Secrets**
   ```bash
   npx ampx sandbox secret set GOOGLE_CLIENT_ID
   # Paste your Client ID
   
   npx ampx sandbox secret set GOOGLE_CLIENT_SECRET
   # Paste your Client Secret
   ```

### FreeAgent OAuth Setup

1. **Register as FreeAgent Developer**
   - Go to [FreeAgent Developer Dashboard](https://dev.freeagent.com/)
   - Sign up / Sign in

2. **Create an Application**
   - Click "Create New App"
   - Fill in application details
   - Set OAuth redirect URIs:
     - `http://localhost:3000/auth/freeagent/callback` (development)
     - `https://your-domain.com/auth/freeagent/callback` (production)

3. **Get Credentials**
   - Copy the **OAuth identifier** (Client ID)
   - Copy the **OAuth secret** (Client Secret)

4. **Set Amplify Secrets**
   ```bash
   npx ampx sandbox secret set FREEAGENT_CLIENT_ID
   # Paste your OAuth identifier
   
   npx ampx sandbox secret set FREEAGENT_CLIENT_SECRET
   # Paste your OAuth secret
   
   # IMPORTANT: Set to "false" for production FreeAgent, "true" for sandbox
   npx ampx sandbox secret set FREEAGENT_USE_SANDBOX
   # Enter: false
   ```

5. **Sandbox vs Production**
   - FreeAgent has a sandbox environment for testing
   - Set `FREEAGENT_USE_SANDBOX` to `"true"` to use sandbox API
   - Set to `"false"` for real FreeAgent data

## 📁 Project Structure

```
amplify/
├── backend.ts              # Main backend definition, IAM permissions
├── auth/resource.ts        # Cognito configuration
├── data/resource.ts        # GraphQL schema & DynamoDB models
├── storage/resource.ts     # S3 bucket configuration
├── cdk/
│   └── invoice-processor-sfn.ts  # Step Functions state machine
└── functions/
    ├── gmail-poller/       # Polls Gmail, uploads to S3
    ├── textract-request/   # Starts async Textract job
    ├── textract-retrieve/  # Processes Textract results (SNS triggered)
    ├── bedrock-enhance/    # AI enhancement with Claude
    ├── matcher/            # Confidence scoring & matching
    ├── freeagent-sync/     # Syncs FreeAgent transactions
    └── oauth-token-store/  # Handles OAuth token exchange

app/
├── page.tsx               # Dashboard
├── queue/page.tsx         # Invoice queue view
├── settings/page.tsx      # Settings & OAuth connections
└── auth/
    ├── gmail/callback/    # Gmail OAuth callback
    └── freeagent/callback/ # FreeAgent OAuth callback
```

## 🗄️ Data Models

| Model | Purpose |
|-------|---------|
| `Invoice` | Extracted invoices from Gmail |
| `Transaction` | Cached FreeAgent bank transactions |
| `Match` | Invoice-to-transaction match proposals |
| `OAuthConnection` | OAuth connection metadata |
| `UserSettings` | User preferences & sync timestamps |

## ⚙️ Environment Variables

These are automatically set by Amplify Gen 2 for Lambda functions:

| Variable | Description |
|----------|-------------|
| `STORAGE_BUCKET_NAME` | S3 bucket for invoice storage |
| `INVOICE_TABLE` | DynamoDB Invoice table |
| `TRANSACTION_TABLE` | DynamoDB Transaction table |
| `MATCH_TABLE` | DynamoDB Match table |
| `TEXTRACT_SNS_TOPIC_ARN` | SNS topic for Textract callbacks |
| `TEXTRACT_SNS_ROLE_ARN` | IAM role for Textract to publish SNS |

## 🔧 Troubleshooting

### "InvalidS3ObjectException" from Textract

This means Textract can't access the S3 object. The bucket policy is automatically configured by `amplify/backend.ts` to allow the `textract.amazonaws.com` service principal. If you see this error:

1. Verify the file exists in S3
2. Check the region matches (both should be `eu-west-1`)
3. Redeploy: `npx ampx sandbox`

### "ProvisionedThroughputExceededException" 

Textract has rate limits (~2 concurrent calls/second). The Gmail poller automatically spaces out Step Functions executions with 3-second delays.

### Gmail not finding emails

- Check `lastGmailPollAt` in UserSettings - it may be set to a recent date
- Use "Clear Data" in the app to reset, or manually reset in DynamoDB
- First sync goes back 30 days

### FreeAgent transactions not syncing

- Verify `FREEAGENT_USE_SANDBOX` matches your FreeAgent account type
- Check `lastFreeAgentSyncAt` in UserSettings
- FreeAgent API requires bank account filter - the sync fetches all accounts first

### Amount mismatch in matching

Multi-currency invoices (like AWS) may have different totals. The matcher has a 10% tolerance, and Bedrock is instructed to prefer GBP amounts for UK businesses.

## 📊 Confidence Scoring

The matcher uses weighted scoring:

| Factor | Weight | Description |
|--------|--------|-------------|
| Amount | 40% | Exact match = 100%, within 10% = 50% |
| Date | 30% | Same day = 100%, within week = 80%, etc. |
| Vendor | 30% | Exact match = 100%, partial = 70% |

- **Auto-approve threshold**: 85% (configurable)
- **Review threshold**: 50% (below this = no match)

## 🚢 Deployment

### Production Deployment

```bash
# Deploy to AWS
npx ampx pipeline-deploy --branch main
```

### Set Production Secrets

```bash
npx ampx secret set GOOGLE_CLIENT_ID --branch main
npx ampx secret set GOOGLE_CLIENT_SECRET --branch main
npx ampx secret set FREEAGENT_CLIENT_ID --branch main
npx ampx secret set FREEAGENT_CLIENT_SECRET --branch main
npx ampx secret set FREEAGENT_USE_SANDBOX --branch main  # Set to "false"
```

## 📝 License

MIT-0 License. See LICENSE file.
