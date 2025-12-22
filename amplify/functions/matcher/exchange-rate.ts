/**
 * @file amplify/functions/matcher/exchange-rate.ts
 * @description Exchange rate service for currency conversion in invoice matching
 *
 * Uses the free exchangerate.host API for historical exchange rates.
 * Rates are cached in memory to avoid redundant API calls within the same Lambda invocation.
 */

interface ExchangeRateResponse {
  success: boolean;
  historical: boolean;
  date: string;
  base: string;
  rates: Record<string, number>;
}

interface CachedRate {
  rate: number;
  fetchedAt: number;
}

// In-memory cache for exchange rates (persists within Lambda execution)
const rateCache = new Map<string, CachedRate>();

// Cache TTL: 1 hour (rates don't change frequently for historical dates)
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Get the exchange rate from one currency to another for a specific date.
 *
 * @param fromCurrency - Source currency code (e.g., 'USD')
 * @param toCurrency - Target currency code (e.g., 'GBP')
 * @param date - Date for the exchange rate (YYYY-MM-DD format)
 * @returns Exchange rate (multiply fromCurrency amount by this to get toCurrency amount)
 */
export async function getExchangeRate(
  fromCurrency: string,
  toCurrency: string,
  date: string
): Promise<number> {
  // Normalize currency codes
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  // Same currency, no conversion needed
  if (from === to) {
    return 1;
  }

  // Check cache first
  const cacheKey = `${from}-${to}-${date}`;
  const cached = rateCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    console.log(`Using cached exchange rate for ${cacheKey}: ${cached.rate}`);
    return cached.rate;
  }

  try {
    // Use exchangerate.host API (free, no API key required)
    const url = `https://api.exchangerate.host/${date}?base=${from}&symbols=${to}`;

    console.log(`Fetching exchange rate: ${from} -> ${to} for ${date}`);

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`Exchange rate API returned ${response.status}, using fallback`);
      return getFallbackRate(from, to);
    }

    const data = (await response.json()) as ExchangeRateResponse;

    if (!data.success || !data.rates[to]) {
      console.warn(`Exchange rate not found in response, using fallback`);
      return getFallbackRate(from, to);
    }

    const rate = data.rates[to];
    console.log(`Exchange rate ${from} -> ${to} on ${date}: ${rate}`);

    // Cache the rate
    rateCache.set(cacheKey, {
      rate,
      fetchedAt: Date.now(),
    });

    return rate;
  } catch (error) {
    console.error('Failed to fetch exchange rate:', error);
    return getFallbackRate(from, to);
  }
}

/**
 * Fallback exchange rates for common currency pairs.
 * These are approximate rates and should only be used when the API fails.
 */
function getFallbackRate(from: string, to: string): number {
  // Common approximate rates (as of late 2024)
  const fallbackRates: Record<string, Record<string, number>> = {
    USD: {
      GBP: 0.79,
      EUR: 0.92,
    },
    EUR: {
      GBP: 0.86,
      USD: 1.09,
    },
    GBP: {
      USD: 1.27,
      EUR: 1.16,
    },
  };

  const rate = fallbackRates[from]?.[to];

  if (rate) {
    console.log(`Using fallback exchange rate ${from} -> ${to}: ${rate}`);
    return rate;
  }

  // If we don't have a fallback, return 1 (no conversion)
  console.warn(`No fallback rate for ${from} -> ${to}, returning 1`);
  return 1;
}

/**
 * Convert an amount from one currency to another using historical rate.
 *
 * @param amount - Amount in source currency
 * @param fromCurrency - Source currency code
 * @param toCurrency - Target currency code
 * @param date - Date for the exchange rate
 * @returns Converted amount in target currency
 */
export async function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  date: string
): Promise<{ convertedAmount: number; rate: number }> {
  const rate = await getExchangeRate(fromCurrency, toCurrency, date);
  const convertedAmount = Math.round(amount * rate * 100) / 100; // Round to 2 decimal places

  console.log(
    `Converted ${fromCurrency} ${amount} -> ${toCurrency} ${convertedAmount} (rate: ${rate})`
  );

  return { convertedAmount, rate };
}

/**
 * Check if a currency conversion is needed for matching.
 *
 * @param invoiceCurrency - Currency of the invoice
 * @param transactionCurrency - Currency of the transaction (typically GBP for UK bank)
 * @returns Whether conversion is needed
 */
export function needsCurrencyConversion(
  invoiceCurrency: string | undefined,
  transactionCurrency: string = 'GBP'
): boolean {
  if (!invoiceCurrency) {
    return false;
  }

  return invoiceCurrency.toUpperCase() !== transactionCurrency.toUpperCase();
}
