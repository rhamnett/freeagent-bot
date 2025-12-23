'use client';

import { Amplify } from 'aws-amplify';
import outputs from '@/amplify_outputs.json';

// Configure Amplify immediately when this module loads
// This ensures configuration happens before any auth components render
if (typeof window !== 'undefined') {
  Amplify.configure(outputs, {
    ssr: true,
  });
}

/**
 * Dummy component to ensure this module gets imported
 * The actual configuration happens at module load time above
 */
export function ConfigureAmplifyClientSide() {
  return null;
}
