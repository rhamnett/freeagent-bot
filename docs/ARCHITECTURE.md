# System Architecture

## Overview

The FreeAgent Invoice Matching Bot is a serverless, event-driven system built on AWS Amplify Gen2. It automates the tedious task of matching email invoices to bank transactions in FreeAgent accounting software.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (Next.js 15)                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────────────┐ │
│  │Dashboard │  │ Settings │  │  Queue   │  │      OAuth Callbacks         │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────────┬───────────────┘ │
│       │             │             │                       │                 │
└───────┼─────────────┼─────────────┼───────────────────────┼─────────────────┘
        │             │             │                       │
        ▼             ▼             ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AWS AppSync (GraphQL API)                           │
│              ┌─────────────────────────────────────────────┐                │
│              │  Cognito User Pool Authentication           │                │
│              └─────────────────────────────────────────────┘                │
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐  ┌───────────────────┐  ┌────────────────────┐
│   DynamoDB    │  │  Lambda Resolvers │  │  S3 Storage Bucket │
│   (6 tables)  │  │  (custom mutations)│  │   (invoices/)      │
└───────────────┘  └─────────┬─────────┘  └────────────────────┘
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
           ┌──────────────┐  ┌────────────────┐
           │ Gmail Poller │  │ FreeAgent Sync │
           └──────┬───────┘  └────────────────┘
                  │
                  ▼
         ┌────────────────────────────────────────────────┐
         │         Step Functions State Machine           │
         │  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
         │  │ Textract │→→│ Bedrock  │→→│   Matcher   │  │
         │  │ Request  │  │ Enhance  │  │             │  │
         │  └────┬─────┘  └──────────┘  └─────────────┘  │
         │       │                                        │
         │       │ (async via SNS)                       │
         │       ▼                                        │
         │  ┌────────────┐                               │
         │  │ Textract   │                               │
         │  │ Retrieve   │                               │
         │  └────────────┘                               │
         └────────────────────────────────────────────────┘
```

## Core Components

### 1. Frontend (Next.js 15 App Router)

| Page | Purpose | Key Features |
|------|---------|--------------|
| Dashboard (`/`) | Overview stats | Pending matches, auto-approved count, connection status |
| Settings (`/settings`) | OAuth connections | Connect Gmail/FreeAgent, view token expiry |
| Queue (`/queue`) | Match review | Approve/reject pending matches with confidence scores |
| OAuth Callbacks | Token exchange | Handle OAuth redirects, store tokens |

### 2. Authentication Layer

**Amazon Cognito User Pool**
- Email/password authentication
- JWT tokens for API access
- User ID (`sub` claim) used as owner identifier

**OAuth 2.0 Integrations**
- Gmail API: Access user's inbox for invoice attachments
- FreeAgent API: Access bank transactions and bills
- Tokens stored securely in AWS Secrets Manager

### 3. Data Layer (DynamoDB)

| Table | Purpose | Key Indexes |
|-------|---------|-------------|
| `OAuthConnection` | OAuth token metadata | `byUserId` |
| `Invoice` | Extracted invoice data | `byGmailMessageId`, `byTextractJobId` |
| `Transaction` | Cached FreeAgent transactions | `byFreeagentUrl`, `byUserIdAndType` |
| `Match` | Invoice-transaction matches | `byInvoiceId`, `byTransactionId` |
| `ProcessingJob` | Async job tracking | — |
| `UserSettings` | User preferences | — |

### 4. Storage Layer (S3)

```
invoices/
└── {userId}/
    └── {gmailMessageId}/
        └── {attachmentId}   # PDF/image files
```

**Bucket Policies:**
- Lambda functions have read/write access
- Textract service principal has read access
- All access via IAM roles (no public access)

### 5. Processing Pipeline (Step Functions)

The invoice processing pipeline uses AWS Step Functions with a callback pattern for async Textract processing.

```
                    ┌────────────────────────────┐
                    │      Start Execution       │
                    │   (triggered by Gmail Poller)
                    └─────────────┬──────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    TEXTRACT REQUEST STEP                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ • Receives: invoiceId, s3Key, bucketName, taskToken     │   │
│  │ • Calls: StartExpenseAnalysis (async API)               │   │
│  │ • Stores: taskToken + textractJobId in Invoice record   │   │
│  │ • Uses: WAIT_FOR_TASK_TOKEN integration pattern         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Integration: Lambda with .waitForTaskToken()                   │
│  Timeout: 15 minutes                                            │
│  Retry: 5 attempts, 45s initial, 2.5x backoff                  │
└───────────────────────────────┬─────────────────────────────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
          │   Textract Service  │   (async processing)
          │                     │
          │         ┌───────────┴───────────┐
          │         │      SNS Topic        │
          │         │  (job completion)     │
          │         └───────────┬───────────┘
          │                     │
          │                     ▼
          │    ┌────────────────────────────────────┐
          │    │      TEXTRACT RETRIEVE STEP       │
          │    │  ┌────────────────────────────┐   │
          │    │  │ • Triggered by: SNS event  │   │
          │    │  │ • Calls: GetExpenseAnalysis│   │
          │    │  │ • Extracts: candidates     │   │
          │    │  │ • Calls: SendTaskSuccess   │   │
          │    │  └────────────────────────────┘   │
          │    └────────────────┬───────────────────┘
          │                     │
          └─────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BEDROCK ENHANCE STEP                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ • Receives: Textract candidates (amounts, vendors, etc) │   │
│  │ • Fetches: Original invoice image from S3               │   │
│  │ • Sends: Image + candidates to Claude Sonnet            │   │
│  │ • Claude: Intelligently selects correct values          │   │
│  │ • Updates: Invoice record with enhanced data            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Retry: 3 attempts, 5s initial, 2x backoff                     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       MATCHER STEP                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ • Receives: Enhanced invoice data                       │   │
│  │ • Queries: All unmatched transactions                   │   │
│  │ • Scores: Each transaction (amount, date, vendor)       │   │
│  │ • Uses: Bedrock Haiku for fuzzy vendor matching         │   │
│  │ • Creates: Match record if confidence > threshold       │   │
│  │ • Status: AUTO_APPROVED if > 0.85, PENDING if > 0.50   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Retry: 3 attempts, 5s initial, 2x backoff                     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
                    ┌────────────────────────────┐
                    │    Processing Complete     │
                    └────────────────────────────┘
```

### 6. Lambda Functions

| Function | Trigger | Purpose | Key Integrations |
|----------|---------|---------|------------------|
| `gmail-poller` | EventBridge (15 min) / Manual | Poll Gmail for invoices | Gmail API, S3, Step Functions |
| `textract-request` | Step Functions | Start async Textract job | Textract, DynamoDB |
| `textract-retrieve` | SNS subscription | Get Textract results, unblock Step Functions | Textract, Step Functions |
| `bedrock-enhance` | Step Functions | AI enhancement of extractions | Bedrock Claude Sonnet, S3 |
| `matcher` | Step Functions | Match invoices to transactions | Bedrock Claude Haiku, DynamoDB |
| `freeagent-sync` | EventBridge (30 min) / Manual | Sync FreeAgent transactions | FreeAgent API |
| `oauth-token-store` | GraphQL mutation | Exchange OAuth codes for tokens | Secrets Manager |

## Data Flow Diagrams

### Invoice Discovery Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    Gmail     │     │ Gmail Poller │     │      S3      │
│    Inbox     │────▶│   Lambda     │────▶│    Bucket    │
└──────────────┘     └──────┬───────┘     └──────────────┘
                           │
                           │ Creates Invoice record
                           ▼
                    ┌──────────────┐     ┌──────────────┐
                    │   DynamoDB   │     │Step Functions│
                    │   Invoice    │◀────│   Start      │
                    └──────────────┘     └──────────────┘
```

### Match Review Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    Queue     │     │   AppSync    │     │   DynamoDB   │
│    Page      │────▶│   GraphQL    │────▶│    Match     │
└──────────────┘     └──────────────┘     └──────┬───────┘
       │                                         │
       │ Approve/Reject                          │
       ▼                                         ▼
┌──────────────┐                          ┌──────────────┐
│   Update     │                          │    Match     │
│   Status     │                          │   APPROVED/  │
└──────────────┘                          │   REJECTED   │
                                          └──────────────┘
```

## Security Architecture

### IAM Permissions Model

```
┌─────────────────────────────────────────────────────────────┐
│                    Lambda Execution Roles                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  gmail-poller-role:                                         │
│    ├── DynamoDB: GetItem, PutItem, UpdateItem, Query       │
│    ├── S3: PutObject, GetObject                            │
│    ├── Secrets Manager: GetSecretValue, PutSecretValue     │
│    └── Step Functions: StartExecution                      │
│                                                             │
│  textract-request-role:                                     │
│    ├── DynamoDB: UpdateItem                                │
│    ├── Textract: StartExpenseAnalysis                      │
│    ├── S3: * (read objects)                                │
│    └── IAM: PassRole (to Textract SNS role)               │
│                                                             │
│  textract-retrieve-role:                                    │
│    ├── DynamoDB: UpdateItem, Query (by textractJobId)      │
│    ├── Textract: GetExpenseAnalysis                        │
│    └── Step Functions: SendTaskSuccess, SendTaskFailure    │
│                                                             │
│  bedrock-enhance-role:                                      │
│    ├── DynamoDB: UpdateItem                                │
│    ├── Bedrock: InvokeModel                                │
│    └── S3: GetObject                                       │
│                                                             │
│  matcher-role:                                              │
│    ├── DynamoDB: Query, PutItem                            │
│    └── Bedrock: InvokeModel (Haiku for fuzzy matching)     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Token Security

```
┌─────────────────────────────────────────────────────────────┐
│                    OAuth Token Flow                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. User initiates OAuth → Redirected to provider          │
│  2. Provider redirects back with authorization code         │
│  3. oauth-token-store Lambda exchanges code for tokens      │
│  4. Tokens stored in Secrets Manager (encrypted at rest)    │
│  5. OAuthConnection record stores secretArn (not tokens)    │
│  6. Lambda clients auto-refresh expired tokens              │
│                                                             │
│  Secret naming: freeagent-bot/{userId}#{provider}          │
│  Format: { accessToken, refreshToken, expiresAt }          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Scalability Considerations

### Current Design (Single-Tenant Focus)

The current architecture is optimized for single-user or small-team usage:
- EventBridge rules trigger globally (need user iteration)
- DynamoDB capacity in on-demand mode
- Step Functions standard workflow (limited concurrent executions)

### Multi-Tenant Scaling Path

For scaling to many users:
1. **User-based scheduling**: Store polling schedules per user, use EventBridge Scheduler
2. **DynamoDB partitioning**: Ensure userId is partition key for even distribution
3. **Step Functions Express**: Consider for high-volume, short-duration workflows
4. **SQS queues**: Add message queue between polling and processing for backpressure

## Error Handling

### Retry Strategies

| Component | Retries | Initial Delay | Backoff | Notes |
|-----------|---------|---------------|---------|-------|
| Textract Request | 5 | 45 seconds | 2.5x | Handles rate limits |
| Bedrock Enhance | 3 | 5 seconds | 2x | Model availability |
| Matcher | 3 | 5 seconds | 2x | DynamoDB throttling |
| Gmail API | Built-in | — | — | In GmailClient |
| FreeAgent API | Built-in | — | — | In FreeAgentClient |

### Failure Modes

1. **Textract failure**: Invoice marked FAILED, user can re-trigger
2. **Bedrock failure**: Falls back to raw Textract data
3. **No match found**: Invoice stays in EXTRACTED status
4. **OAuth token expired**: Auto-refresh in API clients

## Monitoring & Observability

### CloudWatch Metrics

- Lambda invocation count and errors
- Step Functions execution status
- DynamoDB consumed capacity
- S3 request metrics

### Debugging Approach

1. **Step Functions console**: View execution graph, identify failed states
2. **CloudWatch Logs**: Each Lambda logs to its own log group
3. **DynamoDB queries**: Use indexes to trace invoice by gmailMessageId or textractJobId
4. **Invoice record**: Contains processingStep and stepFunctionExecutionArn for tracing
