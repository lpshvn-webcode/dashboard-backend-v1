import axios from 'axios';
import { supabase } from '../lib/supabase';

/**
 * Fetches exchange rate for a specific date using fawazahmed0/currency-api (CDN-hosted, free, historical).
 * Falls back to current rate if historical date fails.
 */
async function fetchRateForDate(
  date: string, // YYYY-MM-DD
  toCurrency: string,
  fromCurrency = 'USD',
): Promise<number | null> {
  const from = fromCurrency.toLowerCase();
  const to = toCurrency.toLowerCase();

  // Primary: fawazahmed0 CDN with specific date (supports history!)
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${from}.json`,
    `https://${date}.currency-api.pages.dev/v1/currencies/${from}.json`,
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url, { timeout: 10000 });
      const rate = res.data?.[from]?.[to];
      if (rate) {
        return Number(rate);
      }
    } catch {
      // try next
    }
  }

  // Fallback: get latest rate (no history but at least something)
  const latestUrls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${from}.json`,
    `https://latest.currency-api.pages.dev/v1/currencies/${from}.json`,
    `https://api.exchangerate-api.com/v4/latest/${fromCurrency.toUpperCase()}`,
  ];

  for (const url of latestUrls) {
    try {
      const res = await axios.get(url, { timeout: 10000 });
      // fawazahmed0 format: { usd: { kzt: 490 } }
      // exchangerate-api format: { rates: { KZT: 490 } }
      const rate = res.data?.[from]?.[to] ?? res.data?.rates?.[toCurrency.toUpperCase()];
      if (rate) {
        console.log(`[ExchangeRate] Fallback rate for ${date}: ${fromCurrency}/${toCurrency} = ${rate}`);
        return Number(rate);
      }
    } catch {
      // try next
    }
  }

  return null;
}

/**
 * Syncs exchange rates for a currency pair over a date range.
 * Uses fawazahmed0 CDN API which supports per-date historical rates.
 * Skips dates that already have a rate stored.
 * @returns number of new rates stored
 */
export async function syncExchangeRates(
  toCurrency: string,
  dateFrom: string,
  dateTo: string,
  fromCurrency = 'USD',
): Promise<number> {
  if (toCurrency.toUpperCase() === 'USD' && fromCurrency.toUpperCase() === 'USD') {
    return 0;
  }

  // Load existing rates to skip already-stored dates
  const { data: existing } = await supabase
    .from('exchange_rates')
    .select('date')
    .eq('from_currency', fromCurrency.toUpperCase())
    .eq('to_currency', toCurrency.toUpperCase())
    .gte('date', dateFrom)
    .lte('date', dateTo);

  const existingDates = new Set((existing || []).map((r: any) => r.date));

  // Build list of dates to fetch (skip weekends only if we have carry-forward data)
  const datesToFetch: string[] = [];
  const current = new Date(dateFrom);
  const end = new Date(dateTo);
  while (current <= end) {
    const d = current.toISOString().substring(0, 10);
    if (!existingDates.has(d)) datesToFetch.push(d);
    current.setDate(current.getDate() + 1);
  }

  if (datesToFetch.length === 0) {
    console.log(`[ExchangeRate] All ${dateFrom}..${dateTo} rates already stored for ${fromCurrency}/${toCurrency}`);
    return 0;
  }

  console.log(`[ExchangeRate] Fetching ${datesToFetch.length} dates for ${fromCurrency}/${toCurrency}`);

  const rows: Array<{ date: string; from_currency: string; to_currency: string; rate: number; source: string }> = [];
  let lastRate: number | null = null;

  // Process in batches to avoid overloading CDN
  const BATCH = 10;
  for (let i = 0; i < datesToFetch.length; i += BATCH) {
    const batch = datesToFetch.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchRateForDate(d, toCurrency, fromCurrency)));

    for (let j = 0; j < batch.length; j++) {
      const date = batch[j];
      const rate = results[j];

      if (rate !== null) {
        lastRate = rate;
        rows.push({
          date,
          from_currency: fromCurrency.toUpperCase(),
          to_currency: toCurrency.toUpperCase(),
          rate,
          source: 'fawazahmed0',
        });
      } else if (lastRate !== null) {
        // Carry-forward for weekends/holidays
        rows.push({
          date,
          from_currency: fromCurrency.toUpperCase(),
          to_currency: toCurrency.toUpperCase(),
          rate: lastRate,
          source: 'carry-forward',
        });
      }
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
 * Syncs today's rate for all unique currency pairs used by clients.
 * Called daily by cron.
 */
export async function syncTodayRateForAllClients(): Promise<void> {
  const { data: clients } = await supabase.from('clients').select('settings');
  const currencies = new Set<string>();
  for (const client of clients || []) {
    const currency = (client.settings as any)?.currency;
    if (currency && currency !== 'USD') currencies.add(currency.toUpperCase());
  }
  if (currencies.size === 0) currencies.add('KZT');

  const today = new Date().toISOString().substring(0, 10);

  for (const currency of currencies) {
    await syncExchangeRates(currency, today, today);
  }
}

/**
 * Returns exchange rate history for the last N days.
 * Includes date, rate, and source.
 */
export async function getExchangeRateHistory(
  toCurrency: string,
  days = 90,
  fromCurrency = 'USD',
): Promise<Array<{ date: string; rate: number; source: string }>> {
  const now = new Date();
  const dateTo = now.toISOString().substring(0, 10);
  const dateFrom = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString().substring(0, 10);

  const { data } = await supabase
    .from('exchange_rates')
    .select('date, rate, source')
    .eq('from_currency', fromCurrency.toUpperCase())
    .eq('to_currency', toCurrency.toUpperCase())
    .gte('date', dateFrom)
    .lte('date', dateTo)
    .order('date', { ascending: false });

  return (data || []).map((r: any) => ({
    date: r.date,
    rate: Number(r.rate),
    source: r.source,
  }));
}

/**
 * Loads exchange rates for a date range from the DB.
 * Returns a map: date → rate. Missing dates use carry-forward.
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

  // Fill full range with carry-forward for missing dates
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
