"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

interface NavbarProps {
  signOut?: () => void;
}

export function Navbar({ signOut }: NavbarProps) {
  return (
    <nav className="border-b">
      <div className="flex h-16 items-center px-8">
        <Link href="/" className="font-bold text-xl mr-8">
          FreeAgent Matcher
        </Link>
        <div className="flex gap-6 items-center flex-1">
          <Link
            href="/"
            className="text-sm font-medium transition-colors hover:text-primary"
          >
            Dashboard
          </Link>
          <Link
            href="/queue"
            className="text-sm font-medium transition-colors hover:text-primary"
          >
            Queue
          </Link>
          <Link
            href="/settings"
            className="text-sm font-medium transition-colors hover:text-primary"
          >
            Settings
          </Link>
        </div>
        {signOut && (
          <Button variant="outline" onClick={signOut}>
            Sign Out
          </Button>
        )}
      </div>
    </nav>
  );
}

