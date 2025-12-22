"use client";

import { Authenticator } from "@aws-amplify/ui-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface AmplifyAuthenticatorProps {
  children: (signOut: () => void) => React.ReactNode;
}

/**
 * Custom Authenticator wrapper with shadcn/ui styling
 * Uses Amplify Auth under the hood but presents a cleaner interface
 */
export function AmplifyAuthenticator({ children }: AmplifyAuthenticatorProps) {
  return (
    <Authenticator
      components={{
        Header() {
          return (
            <div className="flex flex-col items-center gap-2 mb-6">
              <h1 className="text-3xl font-bold">FreeAgent Matcher</h1>
              <p className="text-muted-foreground">
                AI-powered invoice matching
              </p>
            </div>
          );
        },
        SignIn: {
          Header() {
            return (
              <CardHeader className="space-y-1">
                <CardTitle className="text-2xl">Sign in</CardTitle>
                <CardDescription>
                  Enter your email and password to access your account
                </CardDescription>
              </CardHeader>
            );
          },
        },
        SignUp: {
          Header() {
            return (
              <CardHeader className="space-y-1">
                <CardTitle className="text-2xl">Create account</CardTitle>
                <CardDescription>
                  Enter your details to create a new account
                </CardDescription>
              </CardHeader>
            );
          },
        },
      }}
    >
      {({ signOut }) => children(signOut || (() => {}))}
    </Authenticator>
  );
}

