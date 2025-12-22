import { defineFunction, secret } from '@aws-amplify/backend';

export const oauthTokenStore = defineFunction({
  name: 'oauth-token-store',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
  environment: {
    GOOGLE_CLIENT_ID: secret('GOOGLE_CLIENT_ID'),
    GOOGLE_CLIENT_SECRET: secret('GOOGLE_CLIENT_SECRET'),
    FREEAGENT_CLIENT_ID: secret('FREEAGENT_CLIENT_ID'),
    FREEAGENT_CLIENT_SECRET: secret('FREEAGENT_CLIENT_SECRET'),
    FREEAGENT_USE_SANDBOX: process.env.FREEAGENT_USE_SANDBOX ?? 'false',
  },
});
