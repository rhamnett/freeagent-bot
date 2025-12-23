/**
 * @file amplify/functions/freeagent-categories/handler.ts
 * @description Lambda handler for fetching FreeAgent expense categories
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Handler } from 'aws-lambda';
import { FreeAgentClient } from '../freeagent-sync/freeagent-client';

interface FetchCategoriesEvent {
  userId?: string;
  arguments?: {
    userId: string;
  };
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

interface OAuthConnection {
  userId: string;
  provider: string;
  secretArn: string;
}

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const OAUTH_TABLE = process.env.OAUTH_TABLE ?? '';
const FREEAGENT_CLIENT_ID = process.env.FREEAGENT_CLIENT_ID ?? '';
const FREEAGENT_CLIENT_SECRET = process.env.FREEAGENT_CLIENT_SECRET ?? '';
const USE_SANDBOX = process.env.FREEAGENT_USE_SANDBOX === 'true';

export const handler: Handler<FetchCategoriesEvent, FetchCategoriesResult> = async (event) => {
  const userId = event.arguments?.userId ?? event.userId;

  if (!userId) {
    return { success: false, error: 'userId is required' };
  }

  console.log(`Fetching FreeAgent categories for user: ${userId}`);

  try {
    // Get OAuth connection
    const oauthResponse = await ddbClient.send(
      new GetCommand({
        TableName: OAUTH_TABLE,
        Key: { id: `${userId}#FREEAGENT` },
      })
    );

    const oauth = oauthResponse.Item as OAuthConnection | undefined;
    if (!oauth) {
      return { success: false, error: 'No FreeAgent connection' };
    }

    // Initialize FreeAgent client
    const freeagentClient = new FreeAgentClient(
      oauth.secretArn,
      FREEAGENT_CLIENT_ID,
      FREEAGENT_CLIENT_SECRET,
      USE_SANDBOX
    );

    // Fetch categories
    const categories = await freeagentClient.getCategories();

    console.log(`Found ${categories.length} expense categories`);

    return {
      success: true,
      categories: categories.map((cat) => ({
        url: cat.url,
        description: cat.description,
        nominalCode: cat.nominal_code,
        categoryGroup: cat.category_group ?? null,
      })),
    };
  } catch (error) {
    console.error('Error fetching categories:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};
