/**
 * @file amplify/functions/freeagent-sync/resource.ts
 * @description Lambda function definition for FreeAgent data sync
 */

import { defineFunction } from '@aws-amplify/backend';

export const freeagentSync = defineFunction({
  name: 'freeagent-sync',
  entry: './handler.ts',
  timeoutSeconds: 120,
  memoryMB: 512,
  environment: {
    NODE_ENV: 'production',
  },
  resourceGroupName: 'data',
});
