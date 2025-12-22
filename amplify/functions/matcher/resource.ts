/**
 * @file amplify/functions/matcher/resource.ts
 * @description Lambda function definition for invoice-transaction matching
 */

import { defineFunction } from '@aws-amplify/backend';

export const matcher = defineFunction({
  name: 'matcher',
  entry: './handler.ts',
  timeoutSeconds: 60,
  memoryMB: 512,
  environment: {
    NODE_ENV: 'production',
    AUTO_APPROVE_THRESHOLD: '0.85',
    REVIEW_THRESHOLD: '0.50',
  },
  resourceGroupName: 'data',
});
