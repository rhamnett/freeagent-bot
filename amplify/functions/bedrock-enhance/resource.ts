/**
 * @file amplify/functions/bedrock-enhance/resource.ts
 * @description Lambda function definition for Bedrock Claude invoice enhancement
 */

import { defineFunction } from '@aws-amplify/backend';

export const bedrockEnhance = defineFunction({
  name: 'bedrock-enhance',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 1024,
  resourceGroupName: 'data', // Assign to data stack to avoid circular dependency
});
