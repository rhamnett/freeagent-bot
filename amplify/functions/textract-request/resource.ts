/**
 * @file amplify/functions/textract-request/resource.ts
 * @description Lambda function for synchronous Textract expense analysis
 * Downloads file from S3 and sends bytes directly to Textract (avoids bucket policy issues)
 */

import { defineFunction } from '@aws-amplify/backend';

export const textractRequest = defineFunction({
  name: 'textract-request',
  entry: './handler.ts',
  timeoutSeconds: 120, // Increased for synchronous Textract processing
  memoryMB: 512, // More memory for processing larger documents
  resourceGroupName: 'data',
});
