# Invoice-Transaction Matching Algorithm

## Overview

The matching algorithm calculates a confidence score (0-1) for each invoice-transaction pair based on three weighted factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| Amount | 40% | How closely the amounts match |
| Date | 30% | Proximity between invoice date and transaction date |
| Vendor | 30% | Similarity of vendor/contact names |

## Match Status Determination

Based on the confidence score and user-configurable thresholds:

```
                           User Settings
                    ┌──────────────────────────┐
                    │ autoApproveThreshold: 0.85
                    │ reviewThreshold: 0.50     │
                    └──────────────────────────┘

         Score >= 0.85                Score >= 0.50              Score < 0.50
              │                            │                          │
              ▼                            ▼                          ▼
       ┌─────────────┐              ┌─────────────┐             ┌─────────────┐
       │ AUTO_APPROVED│              │   PENDING   │             │  No Match   │
       │ (no review)  │              │ (needs review)            │  Created    │
       └─────────────┘              └─────────────┘             └─────────────┘
```

## Amount Scoring

The amount score considers the difference between invoice total and transaction amount:

```typescript
function calculateAmountScore(invoiceAmount: number, transactionAmount: number): number {
  const diff = Math.abs(invoiceAmount - transactionAmount);
  const percentDiff = diff / transactionAmount;

  if (diff < 0.01)        return 1.0;   // Exact match (within £0.01)
  if (percentDiff < 0.01) return 0.85;  // Very close (<1%)
  if (percentDiff < 0.05) return 0.60;  // Close (<5%)
  if (percentDiff < 0.10) return 0.40;  // Reasonable (<10%)
  if (percentDiff < 0.15) return 0.20;  // Loose (<15%)
  return 0;                             // No match
}
```

### Bank Transactions vs Bills

For bank transactions, we compare against `unexplainedAmount` (the portion not yet allocated):

```typescript
const compareAmount = transaction.type === 'BANK_TRANSACTION'
  ? (transaction.unexplainedAmount ?? transaction.amount)
  : transaction.amount;
```

### Why Allow Tolerance?

- **Currency conversion**: Exchange rate differences between invoice and bank charge
- **Bank fees**: Small processing fees not shown on invoice
- **Tax rounding**: VAT calculation differences
- **Partial payments**: Split payments across multiple transactions

## Currency Conversion

When an invoice arrives in a foreign currency (e.g., USD) but the bank transaction is in GBP, the system automatically converts the invoice amount using historical exchange rates.

### How It Works

```
Invoice: USD $123.45, dated 2024-01-15
Bank Transaction: GBP £97.53

1. Detect currency mismatch (USD ≠ GBP)
2. Fetch exchange rate for invoice date (2024-01-15)
3. Convert: $123.45 × 0.79 = £97.53
4. Compare converted amount to bank transaction
5. If match found, add 'amount_converted' to reasons
```

### Exchange Rate Service

The system uses the exchangerate.host API for historical exchange rates:

```typescript
// Get rate for specific date
const rate = await getExchangeRate('USD', 'GBP', '2024-01-15');

// Convert amount
const { convertedAmount, rate } = await convertCurrency(
  123.45,  // Original USD amount
  'USD',   // From currency
  'GBP',   // To currency
  '2024-01-15'  // Date for historical rate
);
```

### Fallback Rates

If the API is unavailable, hardcoded fallback rates are used:

| From | To | Approximate Rate |
|------|-----|-----------------|
| USD | GBP | 0.79 |
| USD | EUR | 0.92 |
| EUR | GBP | 0.86 |

### Match Reasons

When currency conversion is used and results in a good match:

```typescript
reasons: ['amount_exact', 'amount_converted', 'vendor_match']
//                        ^^^^^^^^^^^^^^^^^ indicates conversion was used
```

This helps during manual review to understand why the amounts matched despite being in different currencies on the original documents.

## Date Scoring

Measures the proximity between invoice date and transaction date:

```typescript
function calculateDateScore(invoiceDate: string, transactionDate: string): number {
  const days = daysBetween(invoiceDate, transactionDate);

  if (days <= 1)  return 1.0;   // Same day or next day
  if (days <= 7)  return 0.8;   // Within a week
  if (days <= 14) return 0.6;   // Within two weeks
  if (days <= 30) return 0.4;   // Within a month
  if (days <= 90) return 0.2;   // Within 3 months
  return 0;                     // Too far apart
}
```

### Why Allow Date Drift?

- **Payment terms**: Net 30/60/90 payment cycles
- **Processing delays**: Time between payment and bank posting
- **Invoice date vs payment date**: Invoice may be dated differently than actual payment
- **Batch payments**: Monthly aggregated payments

## Vendor Scoring

The most complex factor, using both rule-based and AI approaches:

```
┌─────────────────────────────────────────────────────────────┐
│                    Vendor Scoring                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Step 1: Quick Checks (no AI cost)                         │
│    ├── Exact match (case-insensitive) → 1.0                │
│    └── Substring match → 0.8                               │
│                                                             │
│  Step 2: AI Fuzzy Matching (if no quick match)             │
│    └── Bedrock Haiku comparison → 0.0 - 1.0               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Rule-Based Checks

```typescript
const normalizedInvoice = invoiceVendor.toLowerCase().trim();
const normalizedTransaction = transactionVendor.toLowerCase().trim();

// Exact match
if (normalizedInvoice === normalizedTransaction) {
  return { score: 1.0, reason: 'vendor_match' };
}

// Substring match (one contains the other)
if (normalizedInvoice.includes(normalizedTransaction) ||
    normalizedTransaction.includes(normalizedInvoice)) {
  return { score: 0.8, reason: 'vendor_partial' };
}
```

### AI-Powered Fuzzy Matching

When rule-based checks fail, we use Claude Haiku for intelligent comparison:

```typescript
const similarity = await compareVendorNames(invoiceVendor, transactionVendor);

// Haiku considers:
// - Abbreviations: "AMZN" ↔ "Amazon"
// - Legal names: "McDonald's Corporation" ↔ "MCDONALDS"
// - Parent companies: "AWS" ↔ "Amazon Web Services"
// - Trading names: "Tesco Stores Ltd" ↔ "TESCO"
```

### Common Vendor Variations

| Invoice Name | Bank Statement | Should Match? |
|--------------|----------------|---------------|
| Amazon Web Services EMEA SARL | AWS EMEA | ✅ Yes |
| Google Cloud Platform | GOOGLE*CLOUD | ✅ Yes |
| Slack Technologies | SLACK.COM | ✅ Yes |
| Microsoft Corporation | MSFT*AZURE | ✅ Yes |
| Uber Technologies Inc | UBER BV | ✅ Yes |

## Match Reasons

Each match includes reasons explaining why it was considered a match:

```typescript
type MatchReason =
  | 'amount_exact'      // Amount within £0.01
  | 'amount_close'      // Amount within tolerance
  | 'amount_converted'  // Amount matched after currency conversion
  | 'date_exact'        // Same day or next day
  | 'date_close'        // Within 2 weeks
  | 'date_within_month' // Within 30 days
  | 'vendor_match'      // Exact or AI-confirmed match
  | 'vendor_partial';   // Substring or partial match
```

These reasons are stored in the Match record and displayed in the review UI.

## Configuration

Users can customize thresholds via UserSettings:

```typescript
interface MatchingConfig {
  autoApproveThreshold: number;  // Default: 0.85
  reviewThreshold: number;       // Default: 0.50
  amountWeight: number;          // Default: 40
  dateWeight: number;            // Default: 30
  vendorWeight: number;          // Default: 30
}
```

### Adjusting Thresholds

| Use Case | autoApprove | review | Notes |
|----------|-------------|--------|-------|
| Conservative | 0.95 | 0.60 | More manual review, fewer auto-approvals |
| Default | 0.85 | 0.50 | Balanced approach |
| Aggressive | 0.75 | 0.40 | More auto-approvals, risk of false positives |

## Algorithm Implementation

### Main Flow

```typescript
export async function findBestMatch(
  invoice: Invoice,
  transactions: Transaction[],
  config: MatchingConfig
): Promise<{ transaction: Transaction | null; score: MatchScore }> {
  let bestMatch: Transaction | null = null;
  let bestScore: MatchScore = { total: 0, reasons: [] };

  for (const transaction of transactions) {
    const score = await calculateMatchScore(invoice, transaction, config);

    if (score.total > bestScore.total) {
      bestScore = score;
      bestMatch = transaction;
    }
  }

  return { transaction: bestMatch, score: bestScore };
}
```

### Score Calculation

```typescript
export async function calculateMatchScore(
  invoice: Invoice,
  transaction: Transaction,
  config: MatchingConfig
): Promise<MatchScore> {
  const reasons: MatchReason[] = [];
  let totalScore = 0;

  // Amount (40%)
  const amountScore = calculateAmountScore(invoice.totalAmount, transaction.amount);
  totalScore += amountScore.score * config.amountWeight;
  if (amountScore.reason) reasons.push(amountScore.reason);

  // Date (30%)
  const dateScore = calculateDateScore(invoice.invoiceDate, transaction.date);
  totalScore += dateScore.score * config.dateWeight;
  if (dateScore.reason) reasons.push(dateScore.reason);

  // Vendor (30%)
  const vendorScore = await calculateVendorScore(invoice.vendorName, transaction.contactName);
  totalScore += vendorScore.score * config.vendorWeight;
  if (vendorScore.reason) reasons.push(vendorScore.reason);

  // Normalize to 0-1
  const maxScore = config.amountWeight + config.dateWeight + config.vendorWeight;
  const normalizedScore = totalScore / maxScore;

  return {
    total: Math.round(normalizedScore * 100) / 100,
    reasons,
  };
}
```

## Edge Cases

### Missing Invoice Data

```typescript
// No invoice amount → amount score is 0
if (invoiceAmount === undefined) {
  return { score: 0 };
}

// No invoice date → slight penalty, not complete failure
if (!invoiceDate) {
  return { score: 0.3 };
}

// No vendor name → neutral score
if (!invoiceVendor || !transactionVendor) {
  return { score: 0.3 };
}
```

### Multiple Transactions Same Score

If multiple transactions have identical scores, the algorithm returns the first one found. In practice, this is rare because:
- Amounts are usually different
- Dates create differentiation
- Vendor names add granularity

### No Match Found

If no transaction scores above `reviewThreshold`:
- No Match record is created
- Invoice stays in `EXTRACTED` status
- User can manually match from the Queue page

## Performance Considerations

### AI Call Optimization

```typescript
// Quick checks first (no AI cost)
if (normalizedInvoice === normalizedTransaction) {
  return { score: 1.0 };
}

// Only call AI if quick checks fail
const similarity = await compareVendorNames(invoiceVendor, transactionVendor);
```

### Batch Processing

For many transactions, consider:
1. Pre-filter by date range (±90 days)
2. Pre-filter by amount range (±15%)
3. Only run detailed scoring on filtered candidates

## Testing Scenarios

### High Confidence Match (Should Auto-Approve)
```
Invoice: Amazon Web Services, £97.53, 2024-01-15
Transaction: AWS EMEA, £97.53, 2024-01-16
Expected Score: ~0.95 (exact amount, next day, AI vendor match)
```

### Medium Confidence (Should Queue for Review)
```
Invoice: Unknown Vendor Ltd, £500.00, 2024-01-01
Transaction: VENDOR LTD, £495.00, 2024-01-15
Expected Score: ~0.60 (close amount, 2 weeks apart, partial vendor)
```

### Low Confidence (Should Not Create Match)
```
Invoice: Acme Corp, £1000.00, 2024-01-01
Transaction: Zenith Inc, £250.00, 2024-06-15
Expected Score: ~0.15 (no amount match, 6 months apart, no vendor match)
```
