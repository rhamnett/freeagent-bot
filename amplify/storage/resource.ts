/**
 * @file amplify/storage/resource.ts
 * @description S3 storage bucket for invoice attachments
 * NOTE: We use a minimal defineStorage and add Textract permissions in backend.ts
 */

import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'freeagentInvoices',
  // Minimal access - we add Textract permissions via CDK in backend.ts
  access: (allow) => ({
    // User-scoped invoice storage
    'invoices/{entity_id}/*': [allow.entity('identity').to(['read', 'write', 'delete'])],
    // Processing folder
    'processing/*': [allow.guest.to(['read']), allow.authenticated.to(['read', 'write', 'delete'])],
  }),
});
