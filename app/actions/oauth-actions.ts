'use server';

import { generateServerClientUsingCookies } from '@aws-amplify/adapter-nextjs/data';
import { cookies } from 'next/headers';
import type { Schema } from '@/amplify/data/resource';
import outputs from '@/amplify_outputs.json';
import { runWithAmplifyServerContext } from '@/utils/amplifyServerUtils';

interface OAuthResult {
  success: boolean;
  secretArn?: string;
  email?: string;
  expiresAt?: string;
  error?: string;
}

export async function exchangeGmailToken(
  code: string,
  redirectUri: string,
  userId: string
): Promise<OAuthResult> {
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async () => {
      const client = generateServerClientUsingCookies<Schema>({
        config: outputs,
        cookies,
      });

      const result = await client.mutations.exchangeGmailToken({
        code,
        redirectUri,
        userId,
        provider: 'GMAIL',
      });

      if (result.errors) {
        console.error('exchangeGmailToken errors:', result.errors);
        return {
          success: false,
          error: result.errors[0]?.message ?? 'Unknown error',
        };
      }

      return {
        success: result.data?.success ?? false,
        secretArn: result.data?.secretArn ?? undefined,
        email: result.data?.email ?? undefined,
        expiresAt: result.data?.expiresAt ?? undefined,
        error: result.data?.error ?? undefined,
      };
    },
  });
}

export async function exchangeFreeAgentToken(
  code: string,
  redirectUri: string,
  userId: string
): Promise<OAuthResult> {
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async () => {
      const client = generateServerClientUsingCookies<Schema>({
        config: outputs,
        cookies,
      });

      const result = await client.mutations.exchangeFreeAgentToken({
        code,
        redirectUri,
        userId,
        provider: 'FREEAGENT',
      });

      if (result.errors) {
        console.error('exchangeFreeAgentToken errors:', result.errors);
        return {
          success: false,
          error: result.errors[0]?.message ?? 'Unknown error',
        };
      }

      return {
        success: result.data?.success ?? false,
        secretArn: result.data?.secretArn ?? undefined,
        email: result.data?.email ?? undefined,
        expiresAt: result.data?.expiresAt ?? undefined,
        error: result.data?.error ?? undefined,
      };
    },
  });
}

export async function saveOAuthConnection(
  userId: string,
  provider: 'GMAIL' | 'FREEAGENT',
  secretArn: string,
  expiresAt: string,
  email?: string
): Promise<{ success: boolean; error?: string }> {
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async () => {
      const client = generateServerClientUsingCookies<Schema>({
        config: outputs,
        cookies,
      });

      const result = await client.models.OAuthConnection.create({
        id: `${userId}#${provider}`,
        userId,
        provider,
        secretArn,
        expiresAt,
        email,
        lastRefreshedAt: new Date().toISOString(),
      });

      if (result.errors) {
        console.error('saveOAuthConnection errors:', result.errors);
        return {
          success: false,
          error: result.errors[0]?.message ?? 'Failed to save connection',
        };
      }

      return { success: true };
    },
  });
}
