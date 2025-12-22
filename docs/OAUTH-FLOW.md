# OAuth Authentication Flow

## Overview

The system uses OAuth 2.0 to access:
1. **Gmail API** - Read email attachments containing invoices
2. **FreeAgent API** - Access bank transactions and bills

Tokens are stored securely in AWS Secrets Manager (not DynamoDB).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         OAuth Flow                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │ Settings │    │  OAuth   │    │ Token    │    │ Secrets  │  │
│  │   Page   │───▶│ Provider │───▶│  Store   │───▶│ Manager  │  │
│  │          │    │ (Google/ │    │  Lambda  │    │          │  │
│  │          │    │ FreeAgent│    │          │    │          │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘  │
│       │                │                              │         │
│       │                │                              │         │
│       ▼                ▼                              ▼         │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────────┐  │
│  │ Redirect │    │ Callback │    │    OAuthConnection       │  │
│  │ to OAuth │    │ with     │    │    (DynamoDB)            │  │
│  │          │    │   code   │    │    - secretArn           │  │
│  └──────────┘    └──────────┘    │    - email               │  │
│                                  │    - expiresAt           │  │
│                                  └──────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Gmail OAuth Setup

### 1. Google Cloud Console Configuration

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project or select existing
3. Enable Gmail API
4. Create OAuth 2.0 credentials:
   - Application type: Web application
   - Authorized redirect URIs: `https://your-app.com/auth/gmail/callback`

### 2. Required Scopes

```
https://www.googleapis.com/auth/gmail.readonly   # Read emails
https://www.googleapis.com/auth/gmail.modify     # Mark as read
https://www.googleapis.com/auth/userinfo.email   # Get user email
```

### 3. Authorization URL

```typescript
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
authUrl.searchParams.set('redirect_uri', `${APP_URL}/auth/gmail/callback`);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify');
authUrl.searchParams.set('access_type', 'offline');  // Get refresh token
authUrl.searchParams.set('prompt', 'consent');       // Force consent screen
```

### 4. Token Exchange

```typescript
// In oauth-token-store Lambda
const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }),
});

const tokens = await tokenResponse.json();
// tokens: { access_token, refresh_token, expires_in, token_type }
```

## FreeAgent OAuth Setup

### 1. FreeAgent Developer Portal

1. Go to [FreeAgent Developer](https://dev.freeagent.com)
2. Create an application
3. Configure OAuth settings:
   - Callback URL: `https://your-app.com/auth/freeagent/callback`

### 2. Sandbox vs Production

```typescript
// Sandbox (for development)
const tokenUrl = 'https://api.sandbox.freeagent.com/v2/token_endpoint';
const apiBase = 'https://api.sandbox.freeagent.com/v2';

// Production
const tokenUrl = 'https://api.freeagent.com/v2/token_endpoint';
const apiBase = 'https://api.freeagent.com/v2';

// Controlled by FREEAGENT_USE_SANDBOX secret
const useSandbox = env.FREEAGENT_USE_SANDBOX === 'true';
```

### 3. Authorization URL

```typescript
const authUrl = new URL('https://api.freeagent.com/v2/approve_app');
// Or for sandbox: 'https://api.sandbox.freeagent.com/v2/approve_app'

authUrl.searchParams.set('client_id', FREEAGENT_CLIENT_ID);
authUrl.searchParams.set('redirect_uri', `${APP_URL}/auth/freeagent/callback`);
authUrl.searchParams.set('response_type', 'code');
```

### 4. Token Exchange

FreeAgent uses HTTP Basic Auth for token exchange:

```typescript
const credentials = Buffer.from(
  `${env.FREEAGENT_CLIENT_ID}:${env.FREEAGENT_CLIENT_SECRET}`
).toString('base64');

const tokenResponse = await fetch(tokenUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Basic ${credentials}`,
  },
  body: new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }),
});
```

## Token Storage

### Secrets Manager Structure

```
Secret Name: freeagent-bot/{userId}/gmail
Secret Name: freeagent-bot/{userId}/freeagent

Secret Value (JSON):
{
  "accessToken": "ya29.xxxxx",
  "refreshToken": "1//xxxxx",
  "expiresAt": "2024-01-15T10:30:00.000Z"
}
```

### DynamoDB OAuthConnection

```typescript
// Stores metadata only (not tokens)
{
  id: "{userId}#GMAIL",           // Composite key
  userId: "user-123",
  provider: "GMAIL",
  secretArn: "arn:aws:secretsmanager:...",
  email: "user@example.com",
  expiresAt: "2024-01-15T10:30:00.000Z",
  lastRefreshedAt: "2024-01-14T10:30:00.000Z",
  owner: "user-123",
}
```

### Why Secrets Manager?

- **Encryption at rest**: AWS-managed KMS encryption
- **Automatic rotation**: Can be configured for auto-rotation
- **Audit trail**: CloudTrail logging for access
- **IAM integration**: Fine-grained access control
- **No DynamoDB exposure**: Tokens never in application database

## Token Refresh

### Gmail Token Refresh

```typescript
// In GmailClient
async function refreshAccessToken(): Promise<string> {
  const secret = await getSecret(secretArn);

  if (new Date(secret.expiresAt) > new Date()) {
    return secret.accessToken;  // Still valid
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: secret.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const tokens = await response.json();

  // Update secret with new access token
  await updateSecret(secretArn, {
    accessToken: tokens.access_token,
    refreshToken: secret.refreshToken,  // Keep existing refresh token
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  });

  return tokens.access_token;
}
```

### FreeAgent Token Refresh

```typescript
// In FreeAgentClient
async function refreshAccessToken(): Promise<string> {
  const credentials = Buffer.from(
    `${FREEAGENT_CLIENT_ID}:${FREEAGENT_CLIENT_SECRET}`
  ).toString('base64');

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      refresh_token: secret.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const tokens = await response.json();

  // FreeAgent may return a new refresh token
  await updateSecret(secretArn, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? secret.refreshToken,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  });

  return tokens.access_token;
}
```

## Callback Pages

### Gmail Callback (`/app/auth/gmail/callback/page.tsx`)

```typescript
export default async function GmailCallback({ searchParams }) {
  const { code, error } = searchParams;

  if (error) {
    return <ErrorDisplay message={error} />;
  }

  // Get current user
  const session = await fetchAuthSession();
  const userId = session.userSub;

  // Exchange code for tokens via GraphQL mutation
  const result = await client.mutations.exchangeGmailToken({
    code,
    redirectUri: `${APP_URL}/auth/gmail/callback`,
    userId,
    provider: 'GMAIL',
  });

  if (!result.success) {
    return <ErrorDisplay message={result.error} />;
  }

  // Save OAuth connection record
  await client.models.OAuthConnection.create({
    id: `${userId}#GMAIL`,
    userId,
    provider: 'GMAIL',
    secretArn: result.secretArn,
    email: result.email,
    expiresAt: result.expiresAt,
  });

  return <SuccessDisplay email={result.email} />;
}
```

## Security Considerations

### 1. PKCE (Recommended)

For additional security, implement PKCE:

```typescript
// Generate code verifier
const codeVerifier = generateRandomString(64);
const codeChallenge = base64UrlEncode(sha256(codeVerifier));

// Add to auth URL
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');

// Include in token exchange
body.set('code_verifier', codeVerifier);
```

### 2. State Parameter

Prevent CSRF attacks:

```typescript
// Generate state
const state = generateRandomString(32);
sessionStorage.setItem('oauth_state', state);

authUrl.searchParams.set('state', state);

// Verify on callback
if (searchParams.state !== sessionStorage.getItem('oauth_state')) {
  throw new Error('Invalid state parameter');
}
```

### 3. Token Scope Validation

Verify requested scopes match granted scopes:

```typescript
// Parse token response scope
const grantedScopes = tokens.scope.split(' ');
const requiredScopes = ['gmail.readonly', 'gmail.modify'];

if (!requiredScopes.every(s => grantedScopes.includes(s))) {
  throw new Error('Insufficient permissions granted');
}
```

## Troubleshooting

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `invalid_grant` | Code expired or reused | Retry OAuth flow |
| `access_denied` | User denied permission | Explain required permissions |
| `redirect_uri_mismatch` | URL doesn't match app config | Update OAuth app settings |
| `invalid_client` | Wrong client ID/secret | Check Amplify secrets |

### Debugging Token Issues

```typescript
// Check token status
const secret = await getSecret(secretArn);
console.log('Token expires at:', secret.expiresAt);
console.log('Is expired:', new Date(secret.expiresAt) < new Date());

// Check refresh token exists
console.log('Has refresh token:', !!secret.refreshToken);
```

### Re-authentication

If refresh token is revoked:
1. Delete OAuthConnection record
2. Delete secret from Secrets Manager
3. Prompt user to reconnect

```typescript
// In settings page
async function handleDisconnect(provider: string) {
  const connection = await client.models.OAuthConnection.get({
    id: `${userId}#${provider}`,
  });

  if (connection.secretArn) {
    await deleteSecret(connection.secretArn);
  }

  await client.models.OAuthConnection.delete({
    id: `${userId}#${provider}`,
  });
}
```
