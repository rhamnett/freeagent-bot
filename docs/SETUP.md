# Detailed Setup Guide

This guide walks you through setting up the FreeAgent Invoice Matching Bot from scratch.

## Prerequisites

- **Node.js 18+** - [Download](https://nodejs.org/)
- **AWS Account** - With permissions for Amplify, Lambda, DynamoDB, S3, Step Functions, Textract, Bedrock
- **AWS CLI** - Configured with credentials (`aws configure`)
- **Google Account** - For Gmail API access
- **FreeAgent Account** - For transaction syncing

## Step 1: Clone and Install

```bash
git clone <repo-url>
cd freeagent-bot
npm install
```

## Step 2: AWS Bedrock Model Access

Before deploying, ensure you have access to Claude models in Amazon Bedrock:

1. Go to [Amazon Bedrock Console](https://console.aws.amazon.com/bedrock)
2. Select region: `eu-west-1` (Ireland)
3. Go to "Model access" in the left sidebar
4. Request access to:
   - **Anthropic Claude 3.5 Sonnet** (`anthropic.claude-3-5-sonnet-20241022-v2:0`)
5. Wait for approval (usually instant for Claude)

## Step 3: Configure Amplify Secrets

Amplify Gen 2 uses secrets stored in AWS Parameter Store. Set them using the CLI:

### Required Secrets

```bash
# Start by listing current secrets (if any)
npx ampx sandbox secret list

# Set Google OAuth secrets
npx ampx sandbox secret set GOOGLE_CLIENT_ID
# When prompted, paste your Google OAuth Client ID

npx ampx sandbox secret set GOOGLE_CLIENT_SECRET
# When prompted, paste your Google OAuth Client Secret

# Set FreeAgent OAuth secrets
npx ampx sandbox secret set FREEAGENT_CLIENT_ID
# When prompted, paste your FreeAgent OAuth identifier

npx ampx sandbox secret set FREEAGENT_CLIENT_SECRET
# When prompted, paste your FreeAgent OAuth secret

# Set FreeAgent environment (IMPORTANT!)
npx ampx sandbox secret set FREEAGENT_USE_SANDBOX
# Enter "false" for production FreeAgent
# Enter "true" for FreeAgent sandbox environment
```

### Verify Secrets

```bash
npx ampx sandbox secret list
```

You should see:
```
GOOGLE_CLIENT_ID      - Set
GOOGLE_CLIENT_SECRET  - Set
FREEAGENT_CLIENT_ID   - Set
FREEAGENT_CLIENT_SECRET - Set
FREEAGENT_USE_SANDBOX - Set
```

## Step 4: Gmail API Setup

### 4.1 Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown → "New Project"
3. Enter project name: `freeagent-invoice-bot`
4. Click "Create"

### 4.2 Enable Gmail API

1. Go to "APIs & Services" → "Library"
2. Search for "Gmail API"
3. Click "Gmail API" → "Enable"

### 4.3 Configure OAuth Consent Screen

1. Go to "APIs & Services" → "OAuth consent screen"
2. Select **External** (unless you have Google Workspace)
3. Click "Create"

Fill in the form:
- **App name**: FreeAgent Invoice Bot
- **User support email**: Your email
- **Developer contact email**: Your email

4. Click "Save and Continue"

5. **Add Scopes**:
   - Click "Add or Remove Scopes"
   - Search for `gmail.readonly`
   - Check `https://www.googleapis.com/auth/gmail.readonly`
   - Click "Update"

6. Click "Save and Continue"

7. **Add Test Users** (required while in "Testing" status):
   - Click "Add Users"
   - Add your Gmail address
   - Click "Save and Continue"

### 4.4 Create OAuth Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. Application type: **Web application**
4. Name: `FreeAgent Bot Web Client`

5. **Authorized redirect URIs** - Add both:
   ```
   http://localhost:3000/auth/gmail/callback
   ```
   For production, also add:
   ```
   https://your-production-domain.com/auth/gmail/callback
   ```

6. Click "Create"

7. **Copy the credentials**:
   - Client ID: `xxx.apps.googleusercontent.com`
   - Client Secret: `GOCSPX-xxx`

8. Set these as Amplify secrets (Step 3 above)

## Step 5: FreeAgent API Setup

### 5.1 Register as Developer

1. Go to [FreeAgent Developer Dashboard](https://dev.freeagent.com/)
2. Sign in with your FreeAgent account (or create one)

### 5.2 Create Application

1. Click "Create New App"
2. Fill in the form:
   - **App name**: Invoice Matching Bot
   - **Description**: Automatic invoice matching
   - **App URL**: `http://localhost:3000` (or your domain)

3. **OAuth redirect URIs** - Add:
   ```
   http://localhost:3000/auth/freeagent/callback
   ```
   For production:
   ```
   https://your-production-domain.com/auth/freeagent/callback
   ```

4. Click "Create App"

### 5.3 Get Credentials

After creating the app:
- **OAuth identifier**: This is your Client ID
- **OAuth secret**: This is your Client Secret

Copy these and set as Amplify secrets (Step 3 above).

### 5.4 Sandbox vs Production

FreeAgent has two environments:

| Environment | API URL | Use Case |
|-------------|---------|----------|
| **Sandbox** | `api.sandbox.freeagent.com` | Testing with fake data |
| **Production** | `api.freeagent.com` | Real FreeAgent data |

Set `FREEAGENT_USE_SANDBOX`:
- `"true"` - Uses sandbox API (for testing)
- `"false"` - Uses production API (for real data)

**Note**: You need a separate FreeAgent account for sandbox testing.

## Step 6: Deploy Amplify Sandbox

Start the Amplify sandbox (deploys all AWS resources):

```bash
npx ampx sandbox
```

This will:
- Create DynamoDB tables
- Deploy Lambda functions
- Set up Step Functions state machine
- Configure S3 bucket with Textract permissions
- Create SNS topic for Textract callbacks
- Set up Cognito user pool

First deployment takes 5-10 minutes. Subsequent deployments are faster.

## Step 7: Start the Frontend

In a new terminal:

```bash
npm run dev
```

Visit: `http://localhost:3000`

## Step 8: Connect Your Accounts

1. **Sign Up / Sign In** with your email
2. Go to **Settings** page
3. Click **Connect Gmail** → Authorize access
4. Click **Connect FreeAgent** → Authorize access

## Step 9: Test the Pipeline

1. **Sync FreeAgent** - Click "Sync FreeAgent" to import transactions
2. **Sync Gmail** - Click "Sync Gmail" to scan for invoices
3. **Check Queue** - Go to Queue page to see processed invoices
4. **Review Matches** - Approve or reject match suggestions

## Troubleshooting

### "Access blocked: This app's request is invalid"

Your Google OAuth redirect URI doesn't match. Verify:
- The redirect URI in Google Cloud Console matches exactly
- Include the full path: `http://localhost:3000/auth/gmail/callback`
- No trailing slash

### "Invalid client" from FreeAgent

- Verify Client ID and Secret are correct
- Check `FREEAGENT_USE_SANDBOX` matches your account type
- Ensure redirect URI matches exactly in FreeAgent dashboard

### "User is not authorized to perform this action"

The Cognito user doesn't have permission. This usually means:
- You're not signed in
- The `owner` field on the record doesn't match your user ID

### Sandbox deployment fails

```bash
# Check for TypeScript errors
npx tsc --noEmit

# Clear Amplify cache and retry
rm -rf .amplify
npx ampx sandbox
```

### Lambda timeout errors

Some functions have longer timeouts configured:
- `gmail-poller`: 5 minutes (processes many attachments)
- `textract-retrieve`: 60 seconds
- `bedrock-enhance`: 60 seconds

If you're hitting timeouts, check CloudWatch logs for the specific Lambda.

## Architecture Notes

### Why Step Functions?

The invoice processing pipeline uses Step Functions because:
1. **Textract is async** - Jobs can take 30+ seconds for complex PDFs
2. **Retry handling** - Built-in retry with exponential backoff
3. **Visibility** - Easy to see where in the pipeline an invoice failed
4. **Cost** - Lambda only runs when needed, not polling

### Why SNS for Textract?

Textract async jobs publish completion to SNS, which triggers the retrieve Lambda. This is more efficient than polling for job completion.

### Textract Role

The `TextractSnsRole` is passed to Textract in the `NotificationChannel.RoleArn`. Textract assumes this role to:
1. Publish to SNS when the job completes
2. **Read from S3** - This is often missed! The role needs S3 permissions too.

### Multi-Currency Handling

AWS invoices (and others) often show multiple currencies. The pipeline:
1. Textract extracts ALL amounts with currency metadata
2. Bedrock reviews and selects the correct amount (prefers GBP for UK businesses)
3. Matcher has 10% tolerance to handle minor conversion differences

