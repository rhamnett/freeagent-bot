# Amplify Secrets Reference

Quick reference for all secrets required by the FreeAgent Invoice Bot.

## Required Secrets

| Secret Name | Source | Description |
|-------------|--------|-------------|
| `GOOGLE_CLIENT_ID` | Google Cloud Console | OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console | OAuth 2.0 Client Secret |
| `FREEAGENT_CLIENT_ID` | FreeAgent Dev Dashboard | OAuth identifier |
| `FREEAGENT_CLIENT_SECRET` | FreeAgent Dev Dashboard | OAuth secret |
| `FREEAGENT_USE_SANDBOX` | Your choice | `"true"` or `"false"` |

## Setting Secrets

### Sandbox Environment

```bash
# Set a secret
npx ampx sandbox secret set SECRET_NAME

# List all secrets
npx ampx sandbox secret list

# Remove a secret
npx ampx sandbox secret remove SECRET_NAME
```

### Production Environment

```bash
# Set a secret for a branch
npx ampx secret set SECRET_NAME --branch main

# List secrets for a branch
npx ampx secret list --branch main
```

## Quick Setup Commands

Copy and run these commands, entering values when prompted:

```bash
# Google OAuth
npx ampx sandbox secret set GOOGLE_CLIENT_ID
npx ampx sandbox secret set GOOGLE_CLIENT_SECRET

# FreeAgent OAuth
npx ampx sandbox secret set FREEAGENT_CLIENT_ID
npx ampx sandbox secret set FREEAGENT_CLIENT_SECRET

# FreeAgent Environment (enter "false" for production)
npx ampx sandbox secret set FREEAGENT_USE_SANDBOX
```

## Where to Find Values

### Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project
3. Go to "APIs & Services" → "Credentials"
4. Click on your OAuth 2.0 Client ID
5. Copy "Client ID" and "Client secret"

### FreeAgent OAuth Credentials

1. Go to [FreeAgent Developer Dashboard](https://dev.freeagent.com/)
2. Click on your app
3. Copy "OAuth identifier" and "OAuth secret"

## FREEAGENT_USE_SANDBOX Values

| Value | API Endpoint | Use Case |
|-------|--------------|----------|
| `"true"` | `api.sandbox.freeagent.com` | Testing with sandbox FreeAgent account |
| `"false"` | `api.freeagent.com` | Real FreeAgent production account |

**Important**: Your FreeAgent OAuth credentials must match the environment:
- Sandbox app credentials → `FREEAGENT_USE_SANDBOX=true`
- Production app credentials → `FREEAGENT_USE_SANDBOX=false`

## Verifying Secrets Are Set

```bash
npx ampx sandbox secret list
```

Expected output:
```
┌─────────────────────────┬────────┐
│ Secret Name             │ Status │
├─────────────────────────┼────────┤
│ GOOGLE_CLIENT_ID        │ Set    │
│ GOOGLE_CLIENT_SECRET    │ Set    │
│ FREEAGENT_CLIENT_ID     │ Set    │
│ FREEAGENT_CLIENT_SECRET │ Set    │
│ FREEAGENT_USE_SANDBOX   │ Set    │
└─────────────────────────┴────────┘
```

## Troubleshooting

### "Secret not found" errors in Lambda logs

1. Verify the secret is set: `npx ampx sandbox secret list`
2. Redeploy the sandbox: `npx ampx sandbox`
3. Check CloudWatch logs for the specific Lambda

### "Invalid OAuth credentials" 

1. Re-copy the credentials from the source (Google/FreeAgent)
2. Update the secret: `npx ampx sandbox secret set SECRET_NAME`
3. Restart the sandbox

### Secrets not updating in Lambda

Secrets are loaded at Lambda cold start. Either:
1. Wait for Lambda to scale down (5-15 minutes of inactivity)
2. Redeploy: `npx ampx sandbox`
3. Manually trigger a new Lambda version in AWS Console

