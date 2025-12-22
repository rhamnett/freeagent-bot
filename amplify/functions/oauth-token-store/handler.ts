import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { Handler } from 'aws-lambda';
import { env } from '$amplify/env/oauth-token-store';

const secretsClient = new SecretsManagerClient({});

interface OAuthTokenInput {
  code: string;
  redirectUri: string;
  userId: string;
  provider: 'GMAIL' | 'FREEAGENT';
}

interface TokenStoreResult {
  success: boolean;
  secretArn?: string;
  email?: string;
  expiresAt?: string;
  error?: string;
}

interface GraphQLEvent {
  arguments: OAuthTokenInput;
}

export const handler: Handler<GraphQLEvent, TokenStoreResult> = async (event) => {
  console.log('OAuth token store event:', JSON.stringify(event, null, 2));

  try {
    const { code, redirectUri, userId, provider } = event.arguments;

    if (provider === 'GMAIL') {
      return await exchangeGmailToken(code, redirectUri, userId);
    }
    if (provider === 'FREEAGENT') {
      return await exchangeFreeAgentToken(code, redirectUri, userId);
    }

    return { success: false, error: `Unknown provider: ${provider}` };
  } catch (error) {
    console.error('OAuth token store error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

async function exchangeGmailToken(
  code: string,
  redirectUri: string,
  userId: string
): Promise<TokenStoreResult> {
  // Exchange code for tokens with Google
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error('Gmail token exchange failed:', errorText);
    return {
      success: false,
      error: `Token exchange failed: ${tokenResponse.status} - ${errorText}`,
    };
  }

  const tokens = await tokenResponse.json();

  // Get user email
  const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });

  let email = 'unknown';
  if (userInfoResponse.ok) {
    const userInfo = await userInfoResponse.json();
    email = userInfo.email ?? 'unknown';
  }

  // Store tokens in Secrets Manager
  const secretName = `freeagent-bot/${userId}/gmail`;
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  const secretArn = await storeSecret(secretName, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
  });

  return {
    success: true,
    secretArn,
    email,
    expiresAt,
  };
}

async function exchangeFreeAgentToken(
  code: string,
  redirectUri: string,
  userId: string
): Promise<TokenStoreResult> {
  const useSandbox = env.FREEAGENT_USE_SANDBOX === 'true';
  const tokenUrl = useSandbox
    ? 'https://api.sandbox.freeagent.com/v2/token_endpoint'
    : 'https://api.freeagent.com/v2/token_endpoint';

  // FreeAgent uses HTTP Basic Auth for token exchange
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

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error('FreeAgent token exchange failed:', errorText);
    return {
      success: false,
      error: `Token exchange failed: ${tokenResponse.status} - ${errorText}`,
    };
  }

  const tokens = await tokenResponse.json();

  // Get company info
  const apiBase = useSandbox
    ? 'https://api.sandbox.freeagent.com/v2'
    : 'https://api.freeagent.com/v2';

  let companyName = 'FreeAgent Account';
  try {
    const companyResponse = await fetch(`${apiBase}/company`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/json',
      },
    });
    if (companyResponse.ok) {
      const companyData = await companyResponse.json();
      companyName = companyData.company?.name ?? companyName;
    }
  } catch (err) {
    console.warn('Could not fetch company info:', err);
  }

  // Store tokens in Secrets Manager
  const secretName = `freeagent-bot/${userId}/freeagent`;
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  const secretArn = await storeSecret(secretName, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt,
  });

  return {
    success: true,
    secretArn,
    email: companyName,
    expiresAt,
  };
}

async function storeSecret(
  secretName: string,
  secretValue: Record<string, string>
): Promise<string> {
  const secretString = JSON.stringify(secretValue);

  try {
    // Try to get existing secret first
    await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));

    // Secret exists, update it
    const result = await secretsClient.send(
      new PutSecretValueCommand({
        SecretId: secretName,
        SecretString: secretString,
      })
    );
    return result.ARN ?? secretName;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      // Secret doesn't exist, create it
      const result = await secretsClient.send(
        new CreateSecretCommand({
          Name: secretName,
          SecretString: secretString,
        })
      );
      return result.ARN ?? secretName;
    }
    throw error;
  }
}
