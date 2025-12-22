"use client";

import { fetchAuthSession } from "aws-amplify/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
	exchangeFreeAgentToken,
	saveOAuthConnection,
} from "@/app/actions/oauth-actions";

export default function FreeAgentCallbackPage() {
	const searchParams = useSearchParams();
	const router = useRouter();
	const [status, setStatus] = useState<"loading" | "success" | "error">(
		"loading",
	);
	const [errorMessage, setErrorMessage] = useState<string>("");

	useEffect(() => {
		async function handleCallback() {
			const code = searchParams.get("code");
			const error = searchParams.get("error");

			if (error) {
				setStatus("error");
				setErrorMessage(error);
				return;
			}

			if (!code) {
				setStatus("error");
				setErrorMessage("No authorization code received");
				return;
			}

			try {
				// Get current user ID
				const session = await fetchAuthSession();
				const userId = session.tokens?.idToken?.payload.sub as string;

				if (!userId) {
					throw new Error("User not authenticated");
				}

				// Exchange code for tokens via server action (calls Lambda)
				const redirectUri = `${window.location.origin}/auth/freeagent/callback`;
				const result = await exchangeFreeAgentToken(code, redirectUri, userId);

				if (!result.success) {
					throw new Error(result.error ?? "Token exchange failed");
				}

				// Save OAuth connection to DynamoDB
				const saveResult = await saveOAuthConnection(
					userId,
					"FREEAGENT",
					result.secretArn ?? "",
					result.expiresAt ?? new Date().toISOString(),
					result.email, // This is actually the company name
				);

				if (!saveResult.success) {
					throw new Error(saveResult.error ?? "Failed to save connection");
				}

				setStatus("success");

				// Redirect back to settings after a short delay
				setTimeout(() => {
					router.push("/settings");
				}, 2000);
			} catch (err) {
				console.error("FreeAgent callback error:", err);
				setStatus("error");
				setErrorMessage(err instanceof Error ? err.message : "Unknown error");
			}
		}

		handleCallback();
	}, [searchParams, router]);

	return (
		<div style={{ padding: "2rem", textAlign: "center" }}>
			{status === "loading" && (
				<>
					<h1>Connecting FreeAgent...</h1>
					<p>Please wait while we complete the authorization.</p>
				</>
			)}

			{status === "success" && (
				<>
					<h1 style={{ color: "#22c55e" }}>FreeAgent Connected!</h1>
					<p>Redirecting to settings...</p>
				</>
			)}

			{status === "error" && (
				<>
					<h1 style={{ color: "#ef4444" }}>Connection Failed</h1>
					<p>{errorMessage}</p>
					<button
						type="button"
						onClick={() => router.push("/settings")}
						style={{
							marginTop: "1rem",
							padding: "0.75rem 1.5rem",
							background: "#2563eb",
							color: "white",
							border: "none",
							borderRadius: "6px",
							cursor: "pointer",
						}}
					>
						Return to Settings
					</button>
				</>
			)}
		</div>
	);
}
