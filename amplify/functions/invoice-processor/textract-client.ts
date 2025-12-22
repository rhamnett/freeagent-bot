/**
 * @file amplify/functions/invoice-processor/textract-client.ts
 * @description AWS Textract client for invoice/expense document analysis
 */

import {
  AnalyzeExpenseCommand,
  type ExpenseDocument,
  TextractClient,
} from '@aws-sdk/client-textract';

interface ExtractedInvoiceData {
  vendorName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  totalAmount?: number;
  currency?: string;
  lineItems?: Array<{
    description: string;
    quantity?: number;
    unitPrice?: number;
    amount: number;
  }>;
  confidence: number;
}

const textractClient = new TextractClient({});

/**
 * Analyze an invoice document using Textract AnalyzeExpense
 */
export async function analyzeExpenseDocument(
  documentBytes: Buffer
): Promise<{ document: ExpenseDocument; raw: ExpenseDocument[] }> {
  const command = new AnalyzeExpenseCommand({
    Document: {
      Bytes: documentBytes,
    },
  });

  const response = await textractClient.send(command);

  if (!response.ExpenseDocuments || response.ExpenseDocuments.length === 0) {
    throw new Error('No expense documents found in image');
  }

  return {
    document: response.ExpenseDocuments[0],
    raw: response.ExpenseDocuments,
  };
}

/**
 * Extract structured data from Textract expense analysis
 */
export function extractInvoiceData(expenseDocument: ExpenseDocument): ExtractedInvoiceData {
  const result: ExtractedInvoiceData = {
    confidence: 0,
  };

  let totalConfidence = 0;
  let fieldCount = 0;

  // Process summary fields
  if (expenseDocument.SummaryFields) {
    for (const field of expenseDocument.SummaryFields) {
      const type = field.Type?.Text?.toUpperCase();
      const value = field.ValueDetection?.Text;
      const confidence = field.ValueDetection?.Confidence ?? 0;

      if (!type || !value) continue;

      totalConfidence += confidence;
      fieldCount++;

      switch (type) {
        case 'VENDOR_NAME':
        case 'SUPPLIER_NAME':
        case 'NAME':
          if (!result.vendorName) {
            result.vendorName = value;
          }
          break;

        case 'INVOICE_RECEIPT_ID':
        case 'INVOICE_NUMBER':
        case 'RECEIPT_NUMBER':
          if (!result.invoiceNumber) {
            result.invoiceNumber = value;
          }
          break;

        case 'INVOICE_RECEIPT_DATE':
        case 'ORDER_DATE':
        case 'DATE':
          if (!result.invoiceDate) {
            result.invoiceDate = parseDate(value);
          }
          break;

        case 'DUE_DATE':
        case 'PAYMENT_DUE_DATE':
          if (!result.dueDate) {
            result.dueDate = parseDate(value);
          }
          break;

        case 'TOTAL':
        case 'AMOUNT_DUE':
        case 'SUBTOTAL':
        case 'GRAND_TOTAL':
          if (!result.totalAmount) {
            const parsed = parseAmount(value);
            if (parsed) {
              result.totalAmount = parsed.amount;
              result.currency = parsed.currency ?? result.currency;
            }
          }
          break;

        case 'AMOUNT_PAID':
          // Skip amount paid, we want total
          break;

        default:
          // Check if it looks like a currency field
          if (type.includes('CURRENCY') && !result.currency) {
            result.currency = value;
          }
      }
    }
  }

  // Process line items
  if (expenseDocument.LineItemGroups) {
    result.lineItems = [];

    for (const group of expenseDocument.LineItemGroups) {
      if (!group.LineItems) continue;

      for (const lineItem of group.LineItems) {
        if (!lineItem.LineItemExpenseFields) continue;

        const item: {
          description: string;
          quantity?: number;
          unitPrice?: number;
          amount: number;
        } = {
          description: '',
          amount: 0,
        };

        for (const field of lineItem.LineItemExpenseFields) {
          const type = field.Type?.Text?.toUpperCase();
          const value = field.ValueDetection?.Text;

          if (!type || !value) continue;

          switch (type) {
            case 'ITEM':
            case 'DESCRIPTION':
            case 'PRODUCT_CODE':
              if (!item.description) {
                item.description = value;
              } else {
                item.description += ` ${value}`;
              }
              break;

            case 'QUANTITY':
              item.quantity = parseFloat(value.replace(/[^0-9.]/g, ''));
              break;

            case 'UNIT_PRICE':
            case 'PRICE': {
              const unitParsed = parseAmount(value);
              if (unitParsed) {
                item.unitPrice = unitParsed.amount;
              }
              break;
            }

            case 'EXPENSE_ROW_AMOUNT':
            case 'AMOUNT': {
              const amountParsed = parseAmount(value);
              if (amountParsed) {
                item.amount = amountParsed.amount;
              }
              break;
            }
          }
        }

        if (item.description || item.amount > 0) {
          result.lineItems.push(item);
        }
      }
    }
  }

  // Calculate average confidence
  result.confidence = fieldCount > 0 ? totalConfidence / fieldCount / 100 : 0;

  return result;
}

/**
 * Parse a date string into YYYY-MM-DD format
 */
function parseDate(dateStr: string): string | undefined {
  // Try various date formats
  const formats = [
    // DD/MM/YYYY or DD-MM-YYYY
    /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/,
    // YYYY-MM-DD
    /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/,
    // Month DD, YYYY
    /(\w+)\s+(\d{1,2}),?\s+(\d{4})/,
  ];

  for (const format of formats) {
    const match = dateStr.match(format);
    if (match) {
      try {
        const date = new Date(dateStr);
        if (!Number.isNaN(date.getTime())) {
          return date.toISOString().split('T')[0];
        }
      } catch {
        // Continue trying other formats
      }
    }
  }

  // Try direct parsing as fallback
  try {
    const date = new Date(dateStr);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Parse an amount string into a number and currency
 */
function parseAmount(amountStr: string): { amount: number; currency?: string } | null {
  // Remove common thousand separators and normalize decimal
  let cleaned = amountStr.replace(/\s/g, '');

  // Detect currency
  let currency: string | undefined;
  const currencyMatch = cleaned.match(/^([£$€¥])|([A-Z]{3})\s*$/);
  if (currencyMatch) {
    const symbol = currencyMatch[1] ?? currencyMatch[2];
    switch (symbol) {
      case '£':
        currency = 'GBP';
        break;
      case '$':
        currency = 'USD';
        break;
      case '€':
        currency = 'EUR';
        break;
      case '¥':
        currency = 'JPY';
        break;
      default:
        currency = symbol;
    }
  }

  // Extract numeric value
  // Handle formats like "1,234.56" or "1.234,56"
  cleaned = cleaned.replace(/[£$€¥A-Z]/gi, '');

  // Determine decimal separator
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  if (lastComma > lastDot) {
    // European format: 1.234,56
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    // US format: 1,234.56
    cleaned = cleaned.replace(/,/g, '');
  }

  const amount = parseFloat(cleaned);
  if (Number.isNaN(amount)) {
    return null;
  }

  return { amount, currency };
}
