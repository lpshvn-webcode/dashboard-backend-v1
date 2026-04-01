import axios from 'axios';
import { supabase } from '../lib/supabase';

/**
 * Fetches current exchange rate for a given currency pair from exchangerate-api.com (free, no key).
 * Returns the rate as a number, or null on failure.
 */
async function fetchCurrentRate(toCurrency: string, fromCurrency = 'USD'): Promise<number | null> {
  // Primary: exchangerate-api.com (free tier, updated daily)
  try {
    const res = await axios.get(`https://api.exchangerate-api.com/v4/latest/${fromCurrency.toUpperCase()}`, {
      timeout: 10000,
    });
    const rate = res.data?.rates?.[toCurrency.toUpperCase()];
    if (rate) {
      console.log(`[ExchangeRate] Got ${fromCurrency}/${toCurrency} = ${rate} from exchangerate-api.com`);
      return Number(rate);
    }
  } catch (err) {
    console.warn('[ExchangeRate] exchangerate-api.com failed:', (err as any)?.message);
  }

  // Fallback: open.er-api.com
  try {
    const res = await axios.get(`https://open.er-api.com/v6/latest/${fromCurrency.toUpperCase()}`, {
      timeout: 10000,
    });
    const rate = res.data?.rates?.[toCurrency.toUpperCase()];
    if (rate) {
      console.log(`[ExchangeRate] Got ${fromCurrency}/${toCurrency} = ${rate} from open.er-api.com`);
      return Number(rate);
    }
  } catch (err) {
    console.warn('[ExchangeRate] open.er-api.com failed:', (err as any)?.message);
  }

  return null;
}

/**
 * Syncs exchange rates for a currency pair over a date range.
 * Skips dates that already have a rate stored.
 * Uses NBK API for KZT; for other currencies a warning is logged.
 *
 * @returns number of new rates stored
 */
export async function syncExchangeRates(
  toCurrency: string,
  dateFrom: string,
  dateTo: string,
  fromCurrency = 'USD',
): Promise<number> {
  if (toCurrency.toUpperCase() === 'USD' && fromCurrency.toUpperCase() === 'USD') {
    return 0; // trivial
  }

  // Load existing rates for the range to skip already-stored dates
  const { data: existing } = await supabase
    .from('exchange_rates')
    .select('date')
    .eq('from_currency', fromCurrency.toUpperCase())
    .eq('to_currency', toCurrency.toUpperCase())
    .gte('date', dateFrom)
    .lte('date', dateTo);

  const existingDates = new Set((existing || []).map((r: any) => r.date));

  // Build list of dates to fetch
  const datesToFetch: string[] = [];
  const current = new Date(dateFrom);
  const end = new Date(dateTo);
  while (current <= end) {
    const d = current.toISOString().substring(0, 10);
    if (!existingDates.has(d)) datesToFetch.push(d);
    current.setDate(current.getDate() + 1);
  }

  if (datesToFetch.length === 0) {
    console.log(`[ExchangeRate] All ${dateFrom}..${dateTo} rates already stored`);
    return 0;
  }

  console.log(`[ExchangeRate] Fetching current rate for ${datesToFetch.length} dates (${fromCurrency}/${toCurrency})`);

  // Fetch current rate once and apply to all missing dates (free APIs don't provide history)
  const currentRate = await fetchCurrentRate(toCurrency, fromCurrency);
  const rows: Array<{ date: string; from_currency: string; to_currency: string; rate: number; source: string }> = [];

  if (currentRate !== null) {
    for (const date of datesToFetch) {
      rows.push({
        date,
        from_currency: fromCurrency.toUpperCase(),
        to_currency: toCurrency.toUpperCase(),
        rate: currentRate,
        source: 'exchangerate-api',
      });
    }
  }

  if (rows.length > 0) {
    const { error } = await supabase.from('exchange_rates').upsert(rows, {
      onConflict: 'date,from_currency,to_currency',
    });
    if (error) console.error('[ExchangeRate] Upsert error:', error.message);
  }

  console.log(`[ExchangeRate] Stored ${rows.length} rates for ${fromCurrency}/${toCurrency}`);
  return rows.length;
}

/**
 * Syncs yesterday's rate for all unique currency pairs used by clients.
 * Called daily by cron.
 */
export async function syncTodayRateForAllClients(): Promise<void> {
  // Get distinct currencies from client settings
  const { data: clients } = await supabase.from('clients').select('settings');
  const currencies = new Set<string>();
  for (const client of clients || []) {
    const currency = (client.settings as any)?.currency;
    if (currency && currency !== 'USD') currencies.add(currency.toUpperCase());
  }
  if (currencies.size === 0) currencies.add('KZT'); // default

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().substring(0, 10);

  for (const currency of currencies) {
    await syncExchangeRates(currency, dateStr, dateStr);
  }
}

/**
 * Loads exchange rates for a date range from the DB.
 * Returns a map: date → rate.
 * For missing dates, falls back to the nearest preceding rate.
 */
export async function loadExchangeRates(
  dateFrom: string,
  dateTo: string,
  toCurrency: string,
  fromCurrency = 'USD',
  fallbackRate = 490,
): Promise<Map<string, number>> {
  const { data } = await supabase
    .from('exchange_rates')
    .select('date, rate')
    .eq('from_currency', fromCurrency.toUpperCase())
    .eq('to_currency', toCurrency.toUpperCase())
    .gte('date', dateFrom)
    .lte('date', dateTo)
    .order('date', { ascending: true });

  const stored = new Map<string, number>();
  for (const row of data || []) {
    stored.set(row.date, Number(row.rate));
  }

  // Fill in the full date range with carry-forward for missing dates
  const result = new Map<string, number>();
  let last = fallbackRate;
  const cur = new Date(dateFrom);
  const end = new Date(dateTo);
  while (cur <= end) {
    const d = cur.toISOString().substring(0, 10);
    if (stored.has(d)) last = stored.get(d)!;
    result.set(d, last);
    cur.setDate(cur.getDate() + 1);
  }

  return result;
}
