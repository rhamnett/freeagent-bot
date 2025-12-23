/**
 * @file amplify/functions/approve-match/resource.ts
 * @description Lambda function definition for approving matches and attaching invoices to FreeAgent
 */

import { defineFunction } from '@aws-amplify/backend';

export const approveMatch = defineFunction({
  name: 'approve-match',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 512,
  environment: {
    NODE_ENV: 'production',
  },
  resourceGroupName: 'data',
});
