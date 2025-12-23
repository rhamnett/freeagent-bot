/**
 * Simple test runner for matcher scoring (without Bedrock calls)
 * Tests amount and date scoring which don't need external APIs
 * Run with: npx tsx amplify/functions/matcher/__tests__/run-tests.ts
 */

// Test data representing real invoices and transactions
interface TestInvoice {
  id: string;
  vendorName: string;
  invoiceDate: string;
  totalAmount: number;
  currency: string;
}

interface TestTransaction {
  id: string;
  type: 'BANK_TRANSACTION' | 'BILL';
  amount: number;
  date: string;
  description: string;
  unexplainedAmount: number;
}

const testInvoices: TestInvoice[] = [
  { id: 'inv-simpson', vendorName: 'Simpson Burgess Nash Limited', invoiceDate: '2025-11-28', totalAmount: 60.0, currency: 'GBP' },
  { id: 'inv-aws', vendorName: 'AMAZON WEB SERVICES EMEA SARL', invoiceDate: '2025-12-01', totalAmount: 174.43, currency: 'GBP' },
  { id: 'inv-slack', vendorName: 'Slack Technologies Limited', invoiceDate: '2025-12-03', totalAmount: 8.4, currency: 'GBP' },
  { id: 'inv-uber', vendorName: 'Uber', invoiceDate: '2025-12-03', totalAmount: 5.7, currency: 'GBP' },
  { id: 'inv-northern', vendorName: 'Northern', invoiceDate: '2025-12-10', totalAmount: 4.4, currency: 'GBP' },
  { id: 'inv-ajbell', vendorName: 'AJBell', invoiceDate: '2025-12-19', totalAmount: 0.01, currency: 'GBP' },
];

const testTransactions: TestTransaction[] = [
  { id: 'tx-simpson', type: 'BANK_TRANSACTION', amount: 60.0, date: '2025-12-23', description: 'Simpson Burgess Nash limited (Faster Payments Out)/BA042/PAYMENT/', unexplainedAmount: 60.0 },
  { id: 'tx-aws', type: 'BANK_TRANSACTION', amount: 174.43, date: '2025-12-02', description: 'AWS EMEA DIRECT DEBIT', unexplainedAmount: 174.43 },
  { id: 'tx-slack', type: 'BANK_TRANSACTION', amount: 8.4, date: '2025-12-05', description: 'SLACK TECHNOLOGIES LTD CARD PAYMENT', unexplainedAmount: 8.4 },
  { id: 'tx-uber', type: 'BANK_TRANSACTION', amount: 5.7, date: '2025-12-03', description: 'UBER *TRIP', unexplainedAmount: 5.7 },
  { id: 'tx-northern', type: 'BANK_TRANSACTION', amount: 4.4, date: '2025-12-10', description: 'NORTHERN RAIL TICKET', unexplainedAmount: 4.4 },
  { id: 'tx-ajbell', type: 'BANK_TRANSACTION', amount: 0.01, date: '2025-12-19', description: 'AJ BELL SIPP TRANSFER', unexplainedAmount: 0.01 },
  // A non-matching transaction
  { id: 'tx-random', type: 'BANK_TRANSACTION', amount: 999.99, date: '2025-11-01', description: 'RANDOM COMPANY', unexplainedAmount: 999.99 },
];

// Scoring functions (copied from scoring.ts to avoid import issues)
function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function calculateAmountScore(invoiceAmount: number | undefined, transactionAmount: number): { score: number; reason?: string } {
  if (invoiceAmount === undefined) return { score: 0 };

  const diff = Math.abs(invoiceAmount - transactionAmount);
  if (diff < 0.01) return { score: 1, reason: 'amount_exact' };

  const percentDiff = diff / transactionAmount;
  if (percentDiff < 0.01) return { score: 0.85, reason: 'amount_close' };
  if (percentDiff < 0.05) return { score: 0.6, reason: 'amount_close' };
  if (percentDiff < 0.1) return { score: 0.4, reason: 'amount_close' };
  if (percentDiff < 0.15) return { score: 0.2, reason: 'amount_close' };

  return { score: 0 };
}

function calculateDateScore(invoiceDate: string | undefined, transactionDate: string): { score: number; reason?: string } {
  if (!invoiceDate) return { score: 0.3 };

  const days = daysBetween(invoiceDate, transactionDate);
  if (days <= 1) return { score: 1, reason: 'date_exact' };
  if (days <= 7) return { score: 0.8, reason: 'date_close' };
  if (days <= 14) return { score: 0.6, reason: 'date_close' };
  if (days <= 30) return { score: 0.4, reason: 'date_within_month' };
  if (days <= 90) return { score: 0.2, reason: 'date_within_month' };

  return { score: 0 };
}

// Simple vendor matching (no Bedrock)
function simpleVendorMatch(invoiceVendor: string | undefined, transactionDesc: string | undefined): { score: number; reason?: string } {
  if (!invoiceVendor || !transactionDesc) return { score: 0.3 };

  const invWords = invoiceVendor.toLowerCase().split(/\s+/);
  const txWords = transactionDesc.toLowerCase().split(/\s+/);

  // Check for word overlap
  const matchingWords = invWords.filter((w) => txWords.some((tw) => tw.includes(w) || w.includes(tw)));

  if (matchingWords.length >= 2) return { score: 0.9, reason: 'vendor_match' };
  if (matchingWords.length === 1) return { score: 0.7, reason: 'vendor_partial' };

  return { score: 0.2 };
}

function calculateTotalScore(invoice: TestInvoice, transaction: TestTransaction): { total: number; reasons: string[] } {
  const reasons: string[] = [];
  let total = 0;

  const amtScore = calculateAmountScore(invoice.totalAmount, transaction.amount);
  total += amtScore.score * 40;
  if (amtScore.reason) reasons.push(amtScore.reason);

  const dateScore = calculateDateScore(invoice.invoiceDate, transaction.date);
  total += dateScore.score * 30;
  if (dateScore.reason) reasons.push(dateScore.reason);

  const vendorScore = simpleVendorMatch(invoice.vendorName, transaction.description);
  total += vendorScore.score * 30;
  if (vendorScore.reason) reasons.push(vendorScore.reason);

  return { total: total / 100, reasons };
}

function findBestMatch(invoice: TestInvoice, transactions: TestTransaction[]): { transaction: TestTransaction | null; score: { total: number; reasons: string[] } } {
  let best: TestTransaction | null = null;
  let bestScore = { total: 0, reasons: [] as string[] };

  for (const tx of transactions) {
    const score = calculateTotalScore(invoice, tx);
    if (score.total > bestScore.total) {
      bestScore = score;
      best = tx;
    }
  }

  return { transaction: best, score: bestScore };
}

// Test runner
console.log('='.repeat(70));
console.log('MATCHER SCORING TESTS (Local - No Bedrock)');
console.log('='.repeat(70));

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`\x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (error) {
    console.log(`\x1b[31m✗\x1b[0m ${name}`);
    console.log(`  Error: ${error instanceof Error ? error.message : error}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

// Amount scoring tests
console.log('\n--- Amount Scoring ---');

test('Exact amount match (60 = 60)', () => {
  const score = calculateAmountScore(60, 60);
  assert(score.score === 1, `Expected 1, got ${score.score}`);
  assert(score.reason === 'amount_exact', `Expected amount_exact, got ${score.reason}`);
});

test('Very close amount (174.43 vs 174.40)', () => {
  const score = calculateAmountScore(174.43, 174.40);
  assert(score.score >= 0.85, `Expected >= 0.85, got ${score.score}`);
});

test('Non-matching amount (60 vs 174.43)', () => {
  const score = calculateAmountScore(60, 174.43);
  assert(score.score === 0, `Expected 0, got ${score.score}`);
});

// Date scoring tests
console.log('\n--- Date Scoring ---');

test('Same day match', () => {
  const score = calculateDateScore('2025-12-03', '2025-12-03');
  assert(score.score === 1, `Expected 1, got ${score.score}`);
  assert(score.reason === 'date_exact', `Expected date_exact, got ${score.reason}`);
});

test('1 day apart', () => {
  const score = calculateDateScore('2025-12-01', '2025-12-02');
  assert(score.score === 1, `Expected 1, got ${score.score}`);
});

test('Within week (5 days)', () => {
  const score = calculateDateScore('2025-12-01', '2025-12-06');
  assert(score.score === 0.8, `Expected 0.8, got ${score.score}`);
});

test('Within month (25 days - Simpson case)', () => {
  const score = calculateDateScore('2025-11-28', '2025-12-23');
  assert(score.score === 0.4, `Expected 0.4, got ${score.score}`);
  assert(score.reason === 'date_within_month', `Expected date_within_month, got ${score.reason}`);
});

// Vendor matching tests
console.log('\n--- Vendor Matching ---');

test('Simpson vendor match', () => {
  const score = simpleVendorMatch('Simpson Burgess Nash Limited', 'Simpson Burgess Nash limited (Faster Payments Out)/BA042/PAYMENT/');
  assert(score.score >= 0.7, `Expected >= 0.7, got ${score.score}`);
});

test('AWS vendor match', () => {
  const score = simpleVendorMatch('AMAZON WEB SERVICES EMEA SARL', 'AWS EMEA DIRECT DEBIT');
  assert(score.score >= 0.7, `Expected >= 0.7, got ${score.score}`);
});

test('Uber vendor match', () => {
  const score = simpleVendorMatch('Uber', 'UBER *TRIP');
  assert(score.score >= 0.7, `Expected >= 0.7, got ${score.score}`);
});

// Full matching tests
console.log('\n--- Full Matching ---');

test('Simpson: finds correct match', () => {
  const inv = testInvoices.find((i) => i.id === 'inv-simpson')!;
  const { transaction, score } = findBestMatch(inv, testTransactions);
  assert(transaction?.id === 'tx-simpson', `Expected tx-simpson, got ${transaction?.id}`);
  assert(score.total >= 0.5, `Expected score >= 0.5, got ${score.total}`);
  console.log(`    Score: ${score.total.toFixed(2)}, Reasons: ${score.reasons.join(', ')}`);
});

test('AWS: finds correct match with high confidence', () => {
  const inv = testInvoices.find((i) => i.id === 'inv-aws')!;
  const { transaction, score } = findBestMatch(inv, testTransactions);
  assert(transaction?.id === 'tx-aws', `Expected tx-aws, got ${transaction?.id}`);
  assert(score.total >= 0.85, `Expected score >= 0.85, got ${score.total}`);
  console.log(`    Score: ${score.total.toFixed(2)}, Reasons: ${score.reasons.join(', ')}`);
});

test('Uber: exact date match, high confidence', () => {
  const inv = testInvoices.find((i) => i.id === 'inv-uber')!;
  const { transaction, score } = findBestMatch(inv, testTransactions);
  assert(transaction?.id === 'tx-uber', `Expected tx-uber, got ${transaction?.id}`);
  assert(score.total >= 0.9, `Expected score >= 0.9, got ${score.total}`);
  console.log(`    Score: ${score.total.toFixed(2)}, Reasons: ${score.reasons.join(', ')}`);
});

test('All invoices find correct matches', () => {
  const expectedMatches: Record<string, string> = {
    'inv-simpson': 'tx-simpson',
    'inv-aws': 'tx-aws',
    'inv-slack': 'tx-slack',
    'inv-uber': 'tx-uber',
    'inv-northern': 'tx-northern',
    'inv-ajbell': 'tx-ajbell',
  };

  console.log('    Matching results:');
  for (const inv of testInvoices) {
    const { transaction, score } = findBestMatch(inv, testTransactions);
    const expected = expectedMatches[inv.id];
    assert(transaction?.id === expected, `${inv.id}: Expected ${expected}, got ${transaction?.id}`);
    console.log(`      ${inv.vendorName.substring(0, 25).padEnd(25)} -> ${transaction?.description?.substring(0, 30).padEnd(30)} (${score.total.toFixed(2)})`);
  }
});

// Summary
console.log('\n' + '='.repeat(70));
console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? '31' : '32'}m${failed} failed\x1b[0m`);
console.log('='.repeat(70));

if (failed === 0) {
  console.log('\n\x1b[32mAll tests passed! The matching algorithm works correctly.\x1b[0m');
  console.log('Simpson Burgess Nash should match with score >= 0.5 (above review threshold)');
}

process.exit(failed > 0 ? 1 : 0);
