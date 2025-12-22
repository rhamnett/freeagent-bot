/**
 * @file lib/types/index.ts
 * @description TypeScript interfaces for the FreeAgent Invoice Matching Agent
 */

// ============================================================================
// Enums
// ============================================================================

export type OAuthProvider = "GMAIL" | "FREEAGENT";

export type InvoiceStatus =
	| "PENDING"
	| "EXTRACTED"
	| "MATCHED"
	| "APPROVED"
	| "FAILED";

export type TransactionType = "BANK_TRANSACTION" | "BILL";

export type MatchStatus = "PENDING" | "APPROVED" | "REJECTED" | "AUTO_APPROVED";

export type ProcessingJobType = "GMAIL_POLL" | "FREEAGENT_SYNC" | "MATCHING";

export type ProcessingJobStatus = "RUNNING" | "COMPLETED" | "FAILED";

// ============================================================================
// OAuth Types
// ============================================================================

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: string; // ISO datetime
}

export interface OAuthConnection {
	userId: string;
	provider: OAuthProvider;
	secretArn: string;
	expiresAt: string;
	email?: string;
	lastRefreshedAt?: string;
}

// ============================================================================
// Invoice Types
// ============================================================================

export interface LineItem {
	description: string;
	quantity?: number;
	unitPrice?: number;
	amount: number;
}

export interface ExtractedInvoiceData {
	vendorName?: string;
	invoiceNumber?: string;
	invoiceDate?: string; // YYYY-MM-DD
	dueDate?: string;
	totalAmount?: number;
	currency?: string;
	lineItems?: LineItem[];
}

export interface Invoice {
	id: string;
	userId: string;
	gmailMessageId: string;
	attachmentId?: string;
	s3Key?: string;
	senderEmail?: string;
	receivedAt?: string;
	// Extracted fields
	vendorName?: string;
	invoiceNumber?: string;
	invoiceDate?: string;
	dueDate?: string;
	totalAmount?: number;
	currency?: string;
	lineItems?: LineItem[];
	// Processing state
	status: InvoiceStatus;
	extractionConfidence?: number;
	rawTextractOutput?: Record<string, unknown>;
	createdAt: string;
	updatedAt?: string;
}

// ============================================================================
// FreeAgent Transaction Types
// ============================================================================

export interface Transaction {
	id: string;
	userId: string;
	freeagentUrl: string;
	type: TransactionType;
	amount: number;
	date: string; // YYYY-MM-DD
	description?: string;
	unexplainedAmount?: number;
	contactName?: string;
	status?: string; // Open, Overdue, Paid, etc.
	lastSyncedAt: string;
}

export interface FreeAgentBankTransaction {
	url: string;
	bank_account: string;
	dated_on: string;
	description: string;
	amount: string;
	unexplained_amount: string;
	created_at: string;
	updated_at: string;
}

export interface FreeAgentBill {
	url: string;
	contact: string;
	reference: string;
	dated_on: string;
	due_on: string;
	total_value: string;
	paid_value: string;
	due_value: string;
	status: string;
	created_at: string;
	updated_at: string;
}

// ============================================================================
// Match Types
// ============================================================================

export type MatchReason =
	| "amount_exact"
	| "amount_close"
	| "date_exact"
	| "date_close"
	| "date_within_month"
	| "vendor_match"
	| "vendor_partial";

export interface MatchScore {
	total: number; // 0-1
	reasons: MatchReason[];
}

export interface Match {
	id: string;
	userId: string;
	invoiceId: string;
	transactionId: string;
	confidenceScore: number;
	matchReasons: MatchReason[];
	status: MatchStatus;
	reviewedAt?: string;
	createdAt: string;
}

// ============================================================================
// Processing Job Types
// ============================================================================

export interface ProcessingError {
	code: string;
	message: string;
	timestamp: string;
	details?: Record<string, unknown>;
}

export interface ProcessingJob {
	id: string;
	userId: string;
	type: ProcessingJobType;
	status: ProcessingJobStatus;
	startedAt: string;
	completedAt?: string;
	itemsProcessed?: number;
	errors?: ProcessingError[];
}

// ============================================================================
// Gmail API Types
// ============================================================================

export interface GmailAttachment {
	attachmentId: string;
	filename: string;
	mimeType: string;
	size: number;
}

export interface GmailMessage {
	id: string;
	threadId: string;
	labelIds: string[];
	snippet: string;
	internalDate: string;
	payload: {
		headers: Array<{ name: string; value: string }>;
		parts?: Array<{
			partId: string;
			mimeType: string;
			filename: string;
			body: {
				attachmentId?: string;
				size: number;
			};
		}>;
	};
}

// ============================================================================
// Textract Types
// ============================================================================

export interface TextractExpenseField {
	type: string;
	valueDetection: {
		text: string;
		confidence: number;
	};
	labelDetection?: {
		text: string;
		confidence: number;
	};
}

export interface TextractExpenseDocument {
	summaryFields: TextractExpenseField[];
	lineItemGroups: Array<{
		lineItems: Array<{
			lineItemExpenseFields: TextractExpenseField[];
		}>;
	}>;
}

// ============================================================================
// Bedrock Types
// ============================================================================

export interface BedrockInvoiceExtractionRequest {
	imageBase64: string;
	mimeType: string;
}

export interface BedrockInvoiceExtractionResponse {
	vendorName?: string;
	invoiceNumber?: string;
	invoiceDate?: string;
	dueDate?: string;
	totalAmount?: number;
	currency?: string;
	lineItems?: LineItem[];
	confidence: number;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
	};
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface MatchingConfig {
	autoApproveThreshold: number; // Default: 0.85
	reviewThreshold: number; // Default: 0.50
	amountWeight: number; // Default: 40
	dateWeight: number; // Default: 30
	vendorWeight: number; // Default: 30
}

export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
	autoApproveThreshold: 0.85,
	reviewThreshold: 0.5,
	amountWeight: 40,
	dateWeight: 30,
	vendorWeight: 30,
};
