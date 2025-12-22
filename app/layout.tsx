import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "./providers/auth-provider";
import { ConfigureAmplifyClientSide } from "./providers/configure-amplify";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FreeAgent Invoice Matcher",
  description: "AI-powered invoice matching for FreeAgent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <ConfigureAmplifyClientSide />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
