'use server';

import { generateServerClientUsingCookies } from '@aws-amplify/adapter-nextjs/data';
import { cookies } from 'next/headers';
import type { Schema } from '@/amplify/data/resource';
import outputs from '@/amplify_outputs.json';
import { runWithAmplifyServerContext } from '@/utils/amplifyServerUtils';

interface ApproveMatchResult {
  success: boolean;
  matchId?: string;
  attachmentUploaded?: boolean;
  error?: string;
}

interface CategoryItem {
  url: string;
  description: string;
  nominalCode: string;
  categoryGroup: string | null;
}

interface FetchCategoriesResult {
  success: boolean;
  categories?: CategoryItem[];
  error?: string;
}

export async function approveMatchWithAttachment(
  matchId: string,
  userId: string,
  categoryUrl?: string
): Promise<ApproveMatchResult> {
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async () => {
      const client = generateServerClientUsingCookies<Schema>({
        config: outputs,
        cookies,
      });

      const result = await client.mutations.approveMatchWithAttachment({
        matchId,
        userId,
        categoryUrl,
      });

      if (result.errors) {
        console.error('approveMatchWithAttachment errors:', result.errors);
        return {
          success: false,
          error: result.errors[0]?.message ?? 'Unknown error',
        };
      }

      return {
        success: result.data?.success ?? false,
        matchId: result.data?.matchId ?? undefined,
        attachmentUploaded: result.data?.attachmentUploaded ?? undefined,
        error: result.data?.error ?? undefined,
      };
    },
  });
}

export async function fetchFreeAgentCategories(
  userId: string
): Promise<FetchCategoriesResult> {
  return runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: async () => {
      const client = generateServerClientUsingCookies<Schema>({
        config: outputs,
        cookies,
      });

      const result = await client.mutations.fetchFreeAgentCategories({
        userId,
      });

      if (result.errors) {
        console.error('fetchFreeAgentCategories errors:', result.errors);
        return {
          success: false,
          error: result.errors[0]?.message ?? 'Unknown error',
        };
      }

      return {
        success: result.data?.success ?? false,
        categories: result.data?.categories?.map((cat) => ({
          url: cat?.url ?? '',
          description: cat?.description ?? '',
          nominalCode: cat?.nominalCode ?? '',
          categoryGroup: cat?.categoryGroup ?? null,
        })),
        error: result.data?.error ?? undefined,
      };
    },
  });
}
