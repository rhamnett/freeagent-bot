/**
 * Test matcher scoring using real Bedrock Claude Sonnet 4.5
 * Run with: AWS_PROFILE=freeagent npx tsx amplify/functions/matcher/__tests__/run-tests-bedrock.ts
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

// Use eu-west-1 for Bedrock (same as Lambda)
const bedrockClient = new BedrockRuntimeClient({ region: 'eu-west-1' });
const CLAUDE_SONNET_MODEL = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';

interface BedrockMessage {
  role: 'user' | 'assistant';
  content: Array<{ type: 'text'; text: string }>;
}

interface BedrockResponse {
  content: Array<{ type: 'text'; text: string }>;
}

// Real Bedrock vendor comparison (same as bedrock-client.ts)
async function compareVendorNames(invoiceVendor: string, transactionVendor: string): Promise<number> {
  const prompt = `Compare these two business/vendor names and determine if they refer to the same entity.

Invoice vendor: "${invoiceVendor}"
Transaction vendor: "${transactionVendor}"

Consider:
- Abbreviations (e.g., "Amazon" vs "AMZN", "McDonald's" vs "MCDONALDS")
- Slight variations in spelling or formatting
- Parent/subsidiary relationships
- Common trading names vs legal names

Return ONLY a number between 0 and 1 representing the probability they are the same vendor:
- 1.0 = Definitely the same
- 0.8+ = Very likely the same
- 0.5-0.8 = Possibly the same
- 0.2-0.5 = Unlikely but possible
- 0.0-0.2 = Definitely different

Return only the number, nothing else.`;

  const messages: BedrockMessage[] = [
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ];

  const command = new InvokeModelCommand({
    modelId: CLAUDE_SONNET_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 100,
      messages,
    }),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body)) as BedrockResponse;

  const textContent = responseBody.content.find((c) => c.type === 'text');
  if (!textContent) return 0;

  const score = parseFloat(textContent.text.trim());
  return Number.isNaN(score) ? 0 : Math.max(0, Math.min(1, score));
}

// Test data
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
];

// Scoring functions
function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function calculateAmountScore(invoiceAmount: number, transactionAmount: number): { score: number; reason?: string } {
  const diff = Math.abs(invoiceAmount - transactionAmount);
  if (diff < 0.01) return { score: 1, reason: 'amount_exact' };
  const percentDiff = diff / transactionAmount;
  if (percentDiff < 0.01) return { score: 0.85, reason: 'amount_close' };
  if (percentDiff < 0.05) return { score: 0.6, reason: 'amount_close' };
  if (percentDiff < 0.1) return { score: 0.4, reason: 'amount_close' };
  if (percentDiff < 0.15) return { score: 0.2, reason: 'amount_close' };
  return { score: 0 };
}

function calculateDateScore(invoiceDate: string, transactionDate: string): { score: number; reason?: string } {
  const days = daysBetween(invoiceDate, transactionDate);
  if (days <= 1) return { score: 1, reason: 'date_exact' };
  if (days <= 7) return { score: 0.8, reason: 'date_close' };
  if (days <= 14) return { score: 0.6, reason: 'date_close' };
  if (days <= 30) return { score: 0.4, reason: 'date_within_month' };
  if (days <= 90) return { score: 0.2, reason: 'date_within_month' };
  return { score: 0 };
}

async function calculateTotalScore(invoice: TestInvoice, transaction: TestTransaction): Promise<{ total: number; reasons: string[]; vendorScore: number }> {
  const reasons: string[] = [];
  let total = 0;

  const amtScore = calculateAmountScore(invoice.totalAmount, transaction.amount);
  total += amtScore.score * 40;
  if (amtScore.reason) reasons.push(amtScore.reason);

  const dateScore = calculateDateScore(invoice.invoiceDate, transaction.date);
  total += dateScore.score * 30;
  if (dateScore.reason) reasons.push(dateScore.reason);

  // Use real Bedrock for vendor comparison
  let vendorScore = 0.3; // default
  try {
    vendorScore = await compareVendorNames(invoice.vendorName, transaction.description);
    if (vendorScore >= 0.8) reasons.push('vendor_match');
    else if (vendorScore >= 0.5) reasons.push('vendor_partial');
  } catch (error) {
    console.log(`    [Bedrock error: ${error instanceof Error ? error.message : 'unknown'}]`);
  }
  total += vendorScore * 30;

  return { total: total / 100, reasons, vendorScore };
}

async function findBestMatch(invoice: TestInvoice, transactions: TestTransaction[]): Promise<{ transaction: TestTransaction | null; score: { total: number; reasons: string[]; vendorScore: number } }> {
  let best: TestTransaction | null = null;
  let bestScore = { total: 0, reasons: [] as string[], vendorScore: 0 };

  for (const tx of transactions) {
    const score = await calculateTotalScore(invoice, tx);
    if (score.total > bestScore.total) {
      bestScore = score;
      best = tx;
    }
  }

  return { transaction: best, score: bestScore };
}

// Run tests
async function runTests() {
  console.log('='.repeat(70));
  console.log('MATCHER SCORING TESTS (Using Real Bedrock Claude Sonnet 4.5)');
  console.log('='.repeat(70));

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
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

  // Test vendor comparison with Bedrock
  console.log('\n--- Bedrock Vendor Comparison ---');

  await test('Simpson vendor match (Bedrock)', async () => {
    const score = await compareVendorNames('Simpson Burgess Nash Limited', 'Simpson Burgess Nash limited (Faster Payments Out)/BA042/PAYMENT/');
    console.log(`    Bedrock score: ${score.toFixed(2)}`);
    assert(score >= 0.8, `Expected >= 0.8, got ${score}`);
  });

  await test('AWS vendor match (Bedrock)', async () => {
    const score = await compareVendorNames('AMAZON WEB SERVICES EMEA SARL', 'AWS EMEA DIRECT DEBIT');
    console.log(`    Bedrock score: ${score.toFixed(2)}`);
    assert(score >= 0.7, `Expected >= 0.7, got ${score}`);
  });

  await test('Uber vendor match (Bedrock)', async () => {
    const score = await compareVendorNames('Uber', 'UBER *TRIP');
    console.log(`    Bedrock score: ${score.toFixed(2)}`);
    assert(score >= 0.8, `Expected >= 0.8, got ${score}`);
  });

  await test('Slack vendor match (Bedrock)', async () => {
    const score = await compareVendorNames('Slack Technologies Limited', 'SLACK TECHNOLOGIES LTD CARD PAYMENT');
    console.log(`    Bedrock score: ${score.toFixed(2)}`);
    assert(score >= 0.8, `Expected >= 0.8, got ${score}`);
  });

  await test('Northern vendor match (Bedrock)', async () => {
    const score = await compareVendorNames('Northern', 'NORTHERN RAIL TICKET');
    console.log(`    Bedrock score: ${score.toFixed(2)}`);
    assert(score >= 0.7, `Expected >= 0.7, got ${score}`);
  });

  await test('AJBell vendor match (Bedrock)', async () => {
    const score = await compareVendorNames('AJBell', 'AJ BELL SIPP TRANSFER');
    console.log(`    Bedrock score: ${score.toFixed(2)}`);
    assert(score >= 0.8, `Expected >= 0.8, got ${score}`);
  });

  await test('Non-matching vendors (Bedrock)', async () => {
    const score = await compareVendorNames('Simpson Burgess Nash Limited', 'RANDOM UNRELATED COMPANY');
    console.log(`    Bedrock score: ${score.toFixed(2)}`);
    assert(score < 0.3, `Expected < 0.3, got ${score}`);
  });

  // Full matching tests
  console.log('\n--- Full Matching (with Bedrock) ---');

  await test('Simpson: finds correct match', async () => {
    const inv = testInvoices.find((i) => i.id === 'inv-simpson')!;
    const { transaction, score } = await findBestMatch(inv, testTransactions);
    assert(transaction?.id === 'tx-simpson', `Expected tx-simpson, got ${transaction?.id}`);
    assert(score.total >= 0.5, `Expected score >= 0.5, got ${score.total}`);
    console.log(`    Score: ${score.total.toFixed(2)}, Vendor: ${score.vendorScore.toFixed(2)}, Reasons: ${score.reasons.join(', ')}`);
  });

  await test('All invoices find correct matches', async () => {
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
      const { transaction, score } = await findBestMatch(inv, testTransactions);
      const expected = expectedMatches[inv.id];
      const match = transaction?.id === expected;
      const icon = match ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`      ${icon} ${inv.vendorName.substring(0, 25).padEnd(25)} -> ${transaction?.description?.substring(0, 25).padEnd(25)} (${score.total.toFixed(2)}, vendor: ${score.vendorScore.toFixed(2)})`);
      if (!match) {
        throw new Error(`${inv.id}: Expected ${expected}, got ${transaction?.id}`);
      }
    }
  });

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? '31' : '32'}m${failed} failed\x1b[0m`);
  console.log('='.repeat(70));

  if (failed === 0) {
    console.log('\n\x1b[32mAll tests passed! Bedrock matching works correctly.\x1b[0m');
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
