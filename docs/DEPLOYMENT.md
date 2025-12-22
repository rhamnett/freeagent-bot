# Deployment Guide

## Prerequisites

- Node.js 18+ and npm
- AWS CLI configured with credentials
- Amplify CLI: `npm install -g @aws-amplify/cli`

## Local Development Setup

### 1. Clone and Install

```bash
git clone <repository-url>
cd freeagent-bot
npm install
```

### 2. Configure Amplify Secrets

Set the required OAuth credentials:

```bash
# Gmail OAuth credentials (from Google Cloud Console)
npx ampx sandbox secret set GOOGLE_CLIENT_ID
npx ampx sandbox secret set GOOGLE_CLIENT_SECRET

# FreeAgent OAuth credentials (from FreeAgent Developer Portal)
npx ampx sandbox secret set FREEAGENT_CLIENT_ID
npx ampx sandbox secret set FREEAGENT_CLIENT_SECRET

# Use sandbox for development
npx ampx sandbox secret set FREEAGENT_USE_SANDBOX "true"
```

### 3. Deploy Backend Sandbox

```bash
npx ampx sandbox
```

This deploys:
- Cognito User Pool
- AppSync GraphQL API
- DynamoDB tables
- S3 storage bucket
- Lambda functions
- Step Functions state machine
- SNS topics
- EventBridge rules (disabled by default)

### 4. Start Frontend

```bash
npm run dev
```

Open http://localhost:3000

## Environment Configuration

### OAuth Redirect URLs

Configure in your OAuth apps:

**Gmail (Google Cloud Console):**
- Development: `http://localhost:3000/auth/gmail/callback`
- Production: `https://your-domain.com/auth/gmail/callback`

**FreeAgent (Developer Portal):**
- Development: `http://localhost:3000/auth/freeagent/callback`
- Production: `https://your-domain.com/auth/freeagent/callback`

### Secrets Management

| Secret | Description | Where to Get |
|--------|-------------|--------------|
| `GOOGLE_CLIENT_ID` | Gmail OAuth client ID | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Gmail OAuth client secret | Google Cloud Console |
| `FREEAGENT_CLIENT_ID` | FreeAgent app ID | FreeAgent Developer Portal |
| `FREEAGENT_CLIENT_SECRET` | FreeAgent app secret | FreeAgent Developer Portal |
| `FREEAGENT_USE_SANDBOX` | "true" for sandbox | Set manually |

## Production Deployment

### 1. Using Amplify Hosting

```bash
# Connect to Amplify Hosting
npx ampx generate outputs --app-id <app-id> --branch main

# Deploy via CI/CD
git push origin main
```

Amplify Hosting automatically:
- Detects Next.js
- Builds frontend and backend
- Deploys to CloudFront
- Provisions SSL certificate

### 2. Manual Deployment

```bash
# Build frontend
npm run build

# Deploy backend
npx ampx pipeline-deploy --branch main

# Upload frontend to S3/CloudFront
aws s3 sync .next/static s3://your-bucket/_next/static
```

## Post-Deployment Configuration

### 1. Enable EventBridge Rules

After OAuth is configured and working:

```bash
# Enable Gmail polling (every 15 minutes)
aws events enable-rule --name <gmail-poll-rule-name>

# Enable FreeAgent sync (every 30 minutes)
aws events enable-rule --name <freeagent-sync-rule-name>
```

Find rule names in CloudFormation outputs or AWS Console.

### 2. Update OAuth Redirect URLs

Update your OAuth apps with production URLs:
- `https://your-domain.com/auth/gmail/callback`
- `https://your-domain.com/auth/freeagent/callback`

### 3. Set Production Secrets

```bash
npx ampx generate outputs --branch main
npx ampx sandbox secret set FREEAGENT_USE_SANDBOX "false"
```

## Monitoring

### CloudWatch Logs

Each Lambda has its own log group:
- `/aws/lambda/<stack>-gmailPoller`
- `/aws/lambda/<stack>-textractRequest`
- `/aws/lambda/<stack>-textractRetrieve`
- `/aws/lambda/<stack>-bedrockEnhance`
- `/aws/lambda/<stack>-matcher`
- `/aws/lambda/<stack>-freeagentSync`
- `/aws/lambda/<stack>-oauthTokenStore`

### Step Functions Console

View execution history:
1. Open AWS Console → Step Functions
2. Select `InvoiceProcessorStateMachine`
3. View executions, input/output, and timing

### Debugging Common Issues

| Issue | Check | Solution |
|-------|-------|----------|
| Textract fails | S3 bucket policy | Verify Textract service principal access |
| No invoices found | Gmail API scopes | Re-authorize with correct scopes |
| OAuth fails | Redirect URLs | Match URLs in OAuth app config |
| Matching fails | DynamoDB permissions | Check Lambda IAM role |

## CI/CD with amplify.yml

```yaml
version: 1
backend:
  phases:
    build:
      commands:
        - npm ci
        - npx ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID
frontend:
  phases:
    preBuild:
      commands:
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: .next
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
```

## Scaling Considerations

### DynamoDB
- Tables use on-demand capacity by default
- For high volume, consider provisioned capacity with auto-scaling

### Lambda
- Default memory: 512MB (adjust per function as needed)
- Timeout: 5 minutes (Step Functions handle longer workflows)

### Step Functions
- Standard workflows: Pay per state transition
- For high volume, consider Express workflows

### Cost Optimization

1. **Textract**: Batch similar invoices
2. **Bedrock**: Use Haiku for simple comparisons, Sonnet only for enhancement
3. **Lambda**: Right-size memory allocations
4. **EventBridge**: Adjust polling frequency based on invoice volume

## Rollback

### Rollback Backend

```bash
# List recent deployments
aws amplify list-deployments --app-id <app-id> --branch-name main

# Rollback to specific deployment
aws amplify stop-deployment --app-id <app-id> --branch-name main
# Then redeploy from previous commit
```

### Rollback Data

DynamoDB point-in-time recovery:
```bash
aws dynamodb restore-table-to-point-in-time \
  --source-table-name Invoice \
  --target-table-name Invoice-restored \
  --restore-date-time <timestamp>
```

## Security Checklist

- [ ] OAuth secrets configured (not in code)
- [ ] Cognito User Pool with strong password policy
- [ ] S3 bucket not public
- [ ] Lambda functions have minimal IAM permissions
- [ ] Secrets Manager encryption enabled
- [ ] CloudTrail logging enabled
- [ ] VPC for Lambda (optional, for enhanced security)
