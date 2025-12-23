import { defineFunction } from '@aws-amplify/backend';

export const freeagentCategories = defineFunction({
  name: 'freeagent-categories',
  entry: './handler.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
  environment: {
    NODE_ENV: 'production',
  },
  resourceGroupName: 'data',
});
