/**
 * @file amplify/functions/textract-retrieve/resource.ts
 * @description Lambda function definition for handling Textract SNS callbacks
 */

import { defineFunction } from '@aws-amplify/backend';

export const textractRetrieve = defineFunction({
  name: 'textract-retrieve',
  entry: './handler.ts',
  timeoutSeconds: 120, // Longer timeout for fetching paginated results
  memoryMB: 512,
  resourceGroupName: 'data', // Assign to data stack to avoid circular dependency
});
