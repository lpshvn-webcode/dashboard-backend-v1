import axios from 'axios';
import { supabase } from '../lib/supabase';

/**
 * Fetches USD→KZT exchange rate from the National Bank of Kazakhstan (NBK).
 * NBK RSS endpoint: https://nationalbank.kz/rss/get_rates.cfm?fdate=DD.MM.YYYY
 * Returns the rate as a number, or null if not available (e.g. weekends/holidays).
 */
async function fetchNbkRate(date: string): Promise<number | null> {
  const [year, month, day] = date.split('-');
  const fdate = `${day}.${month}.${year}`;
  try {
    const res = await axios.get(`https://nationalbank.kz/rss/get_rates.cfm?fdate=${fdate}`, {
      timeout: 15000,
      responseType: 'text',   // ensure raw string, not auto-parsed object
      headers: {
        'Accept': 'text/xml, application/xml, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; dashboard-sync/1.0)',
      },
    });
    const xml = String(res.data || '');
    if (!xml) return null;

    // Split by <item> blocks and search for USD entry
    const itemBlocks = xml.split(/<item[\s>]/i).slice(1);
    for (const block of itemBlocks) {
      if (/US Dollar|USD/i.test(block)) {
        // Handle plain value or CDATA: <description>449.77</description>
        const match = block.match(/<description[^>]*>(?:<!\[CDATA\[)?\s*([\d.,]+)\s*(?:\]\]>)?<\/description>/i);
        if (match) {
          const rate = parseFloat(match[1].replace(',', '.'));
          if (!isNaN(rate) && rate > 0) return rate;
        }
      }
    }

    console.warn(`[ExchangeRate] USD not found in NBK XML for ${date}. Response length: ${xml.length}`);
    return null;
  } catch (err) {
    console.warn(`[ExchangeRate] Failed to fetch NBK rate for ${date}:`, (err as any)?.message);
    return null;
  }
}

/**
 * Fallback: fetch current USD→KZT rate from open.er-api.com (no API key required).
 * Used when NBK doesn't return data for a date (e.g. fresh dates or connectivity issues).
 */
async function fetchFallbackRate(): Promise<number | null> {
  try {
    const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 10000 });
    const rate = res.data?.rates?.KZT;
    return rate ? Number(rate) : null;
  } catch (err) {
    console.warn('[ExchangeRate] Fallback API failed:', (err as any)?.message);
    return null;
  }
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

  console.log(`[ExchangeRate] Fetching ${datesToFetch.length} dates for ${fromCurrency}/${toCurrency}`);

  // Fetch in parallel batches of 5 to avoid overloading NBK
  const BATCH = 5;
  const rows: Array<{ date: string; from_currency: string; to_currency: string; rate: number; source: string }> = [];
  let lastKnownRate: number | null = null;

  for (let i = 0; i < datesToFetch.length; i += BATCH) {
    const batch = datesToFetch.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(d => fetchNbkRate(d).then(r => ({ date: d, rate: r }))));

    for (const { date, rate } of results) {
      if (rate !== null) {
        lastKnownRate = rate;
        rows.push({ date, from_currency: fromCurrency.toUpperCase(), to_currency: toCurrency.toUpperCase(), rate, source: 'nbk' });
      } else if (lastKnownRate !== null) {
        // Weekend / holiday — use last known rate
        rows.push({ date, from_currency: fromCurrency.toUpperCase(), to_currency: toCurrency.toUpperCase(), rate: lastKnownRate, source: 'nbk_carry' });
      }
      // else: no rate and no previous rate yet — skip (very start of history)
    }
  }

  // If NBK returned nothing at all (connectivity or parsing issue), try fallback for today's rate
  // and carry forward for all requested dates
  if (rows.length === 0) {
    console.warn('[ExchangeRate] NBK returned 0 rates — trying fallback API');
    const fallbackRate = await fetchFallbackRate();
    if (fallbackRate !== null) {
      console.log(`[ExchangeRate] Fallback rate: ${fromCurrency}/${toCurrency} = ${fallbackRate}`);
      for (const date of datesToFetch) {
        rows.push({
          date,
          from_currency: fromCurrency.toUpperCase(),
          to_currency: toCurrency.toUpperCase(),
          rate: fallbackRate,
          source: 'fallback',
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
