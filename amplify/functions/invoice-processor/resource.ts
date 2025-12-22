/**
 * @file amplify/functions/invoice-processor/resource.ts
 * @description Lambda function definition for invoice processing (Textract + Bedrock)
 */

import { defineFunction } from '@aws-amplify/backend';

export const invoiceProcessor = defineFunction({
  name: 'invoice-processor',
  entry: './handler.ts',
  timeoutSeconds: 180, // OCR can take time
  memoryMB: 1024,
  environment: {
    NODE_ENV: 'production',
  },
  resourceGroupName: 'data',
});
