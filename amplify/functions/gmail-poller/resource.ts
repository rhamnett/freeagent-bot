/**
 * @file amplify/functions/gmail-poller/resource.ts
 * @description Lambda function definition for Gmail polling
 */

import { defineFunction } from '@aws-amplify/backend';

export const gmailPoller = defineFunction({
  name: 'gmail-poller',
  entry: './handler.ts',
  timeoutSeconds: 300, // 5 minutes to handle large batches with throttling delays
  memoryMB: 512,
  environment: {
    NODE_ENV: 'production',
  },
  resourceGroupName: 'data',
});
