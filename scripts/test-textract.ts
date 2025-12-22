/**
 * Test script to run async Textract on the AWS invoice and see raw output
 * Run with: npx tsx scripts/test-textract.ts
 */

import {
  TextractClient,
  StartExpenseAnalysisCommand,
  GetExpenseAnalysisCommand,
} from '@aws-sdk/client-textract';

const BUCKET = 'amplify-awsamplifygen2-ri-freeagentinvoicesbucket6-blopp9ot7xkl';
const KEY = 'invoices/e25544d4-40f1-70fe-19d7-4b293384d977/1766435925678-EUINGB25-6306742.pdf';

const textractClient = new TextractClient({ region: 'eu-west-1' });

async function main() {
  console.log('Starting async Textract analysis...');
  console.log(`Bucket: ${BUCKET}`);
  console.log(`Key: ${KEY}`);
  
  // Start the async job
  const startResponse = await textractClient.send(
    new StartExpenseAnalysisCommand({
      DocumentLocation: {
        S3Object: {
          Bucket: BUCKET,
          Name: KEY,
        },
      },
    })
  );

  const jobId = startResponse.JobId;
  console.log(`\nJob started: ${jobId}`);
  console.log('Waiting for job to complete...');

  // Poll for completion
  let status = 'IN_PROGRESS';
  let result: any;
  
  while (status === 'IN_PROGRESS') {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    result = await textractClient.send(
      new GetExpenseAnalysisCommand({
        JobId: jobId,
      })
    );
    
    status = result.JobStatus || 'UNKNOWN';
    process.stdout.write('.');
  }
  
  console.log(`\n\nJob completed with status: ${status}`);
  
  if (status !== 'SUCCEEDED') {
    console.error('Job failed!');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Print Summary Fields
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY FIELDS (what we use for extraction):');
  console.log('='.repeat(80));
  
  for (const doc of result.ExpenseDocuments || []) {
    console.log(`\nExpense Document ${doc.ExpenseIndex}:`);
    console.log('-'.repeat(40));
    
    for (const field of doc.SummaryFields || []) {
      const type = field.Type?.Text || 'UNKNOWN';
      const label = field.LabelDetection?.Text || '';
      const value = field.ValueDetection?.Text || '';
      const confidence = field.ValueDetection?.Confidence?.toFixed(1) || '0';
      
      console.log(`${type.padEnd(30)} ${label.padEnd(20)} = ${value.padEnd(40)} (${confidence}%)`);
    }
  }

  // Print line items
  console.log('\n' + '='.repeat(80));
  console.log('LINE ITEMS:');
  console.log('='.repeat(80));
  
  for (const doc of result.ExpenseDocuments || []) {
    for (const group of doc.LineItemGroups || []) {
      for (const item of group.LineItems || []) {
        console.log('\nLine Item:');
        for (const field of item.LineItemExpenseFields || []) {
          const type = field.Type?.Text || 'UNKNOWN';
          const value = field.ValueDetection?.Text || '';
          console.log(`  ${type}: ${value}`);
        }
      }
    }
  }

  // Look specifically for vendor-related fields
  console.log('\n' + '='.repeat(80));
  console.log('VENDOR-RELATED FIELDS (searching for AWS/Amazon):');
  console.log('='.repeat(80));
  
  const vendorTypes = ['VENDOR_NAME', 'NAME', 'VENDOR', 'RECEIVER_NAME', 'SUPPLIER_NAME'];
  
  for (const doc of result.ExpenseDocuments || []) {
    for (const field of doc.SummaryFields || []) {
      const type = field.Type?.Text?.toUpperCase() || '';
      const value = field.ValueDetection?.Text || '';
      
      if (vendorTypes.includes(type) || value.toLowerCase().includes('amazon') || value.toLowerCase().includes('aws')) {
        console.log(`${type}: "${value}"`);
      }
    }
  }

  // Save full output for inspection
  const fs = await import('fs');
  fs.writeFileSync('/tmp/textract-full-output.json', JSON.stringify(result, null, 2));
  console.log('\n\nFull output saved to /tmp/textract-full-output.json');
}

main().catch(console.error);

