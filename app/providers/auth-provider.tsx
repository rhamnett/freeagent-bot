"use client";

import { Authenticator } from "@aws-amplify/ui-react";

interface AuthProviderProps {
  children: React.ReactNode;
}

/**
 * Auth Provider component
 * Wraps the app with Amplify Authenticator.Provider
 * Note: Amplify is configured in configure-amplify.tsx, not here
 * The actual UI is handled by the AmplifyAuthenticator component
 */
export function AuthProvider({ children }: AuthProviderProps) {
  return <Authenticator.Provider>{children}</Authenticator.Provider>;
}
