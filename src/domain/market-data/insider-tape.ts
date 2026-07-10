/**
 * Fixed-universe Form 4 tape with a once-per-day disk cache.
 *
 * Universe = SOXX holdings + DRAM-adjacent basket (paper theme).
 * Cache path: data/cache/insider/soxx-dram-latest.json
 * Freshness: America/New_York calendar day — first request of the day
 * refreshes; later requests read the file (fast).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dataPath } from '@/core/paths.js'
import type { EquityClientLike } from './client/types.js'

export const INSIDER_TAPE_UNIVERSE_ID = 'soxx-dram'
export const INSIDER_TAPE_UNIVERSE_LABEL = 'SOXX + DRAM'

/** Keep in sync with paper workspace `soxx-dram-universe.json` → merged. */
export const INSIDER_TAPE_UNIVERSE = [
  'ADI', 'ALAB', 'AMAT', 'AMD', 'ARM', 'ASML', 'ASX', 'AVGO', 'CRDO', 'ENTG',
  'INTC', 'KLAC', 'LRCX', 'MCHP', 'MPWR', 'MRVL', 'MTSI', 'MU', 'NVMI', 'NVDA',
  'NXPI', 'ON', 'QCOM', 'RMBS', 'SNDK', 'STM', 'STX', 'SWKS', 'TER', 'TSM',
  'TXN', 'UMC', 'WDC',
] as const

const CACHE_FILE = dataPath('cache', 'insider', `${INSIDER_TAPE_UNIVERSE_ID}-latest.json`)
const DEFAULT_LIMIT = 12
const CONCURRENCY = 4

export type InsiderTapeTrade = Record<string, unknown> & {
  symbol?: string
  _provider?: string | null
}

export interface InsidersTapePayload {
  dateKey: string
  asOf: string
  cachedAt: string
  universeId: string
  universe: string
  symbols: string[]
  trades: InsiderTapeTrade[]
  errors: Array<{ symbol: string; error: string | null }>
  meta: {
    origin: 'local'
    provider: string
    asOf: string
    cachedAt: string
    stale?: boolean
    limitPerSymbol: number
  }
}

let inflight: Promise<InsidersTapePayload> | null = null

/** America/New_York calendar day as YYYY-MM-DD (Form 4 is a US filing clock). */
export function insiderTapeDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

async function readCache(): Promise<InsidersTapePayload | null> {
  try {
    const raw = await readFile(CACHE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as InsidersTapePayload
    if (!parsed?.dateKey || !Array.isArray(parsed.trades) || !Array.isArray(parsed.symbols)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function writeCache(payload: InsidersTapePayload): Promise<void> {
  await mkdir(dirname(CACHE_FILE), { recursive: true })
  await writeFile(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8')
}

async function fetchUniverse(
  equityClient: EquityClientLike,
  limitPerSymbol: number,
): Promise<Omit<InsidersTapePayload, 'meta'> & { providers: string[] }> {
  const symbols = [...INSIDER_TAPE_UNIVERSE]
  const fn = equityClient.getInsiderTrading.bind(equityClient) as (
    p: Record<string, unknown>,
  ) => Promise<Record<string, unknown>[]>

  async function fetchOne(symbol: string): Promise<{
    symbol: string
    rows: Record<string, unknown>[]
    provider: string | null
    error: string | null
  }> {
    try {
      try {
        const rows = await fn({ symbol, limit: limitPerSymbol, provider: 'fmp' })
        return { symbol, rows: rows ?? [], provider: 'fmp', error: null }
      } catch {
        const rows = await fn({ symbol, limit: limitPerSymbol, provider: 'yfinance' })
        return { symbol, rows: rows ?? [], provider: 'yfinance', error: null }
      }
    } catch (err) {
      return {
        symbol,
        rows: [],
        provider: null,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const results: Awaited<ReturnType<typeof fetchOne>>[] = []
  let i = 0
  async function worker() {
    while (i < symbols.length) {
      const idx = i++
      results[idx] = await fetchOne(symbols[idx]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, () => worker()))

  const providers = [...new Set(results.map((r) => r.provider).filter(Boolean))] as string[]
  const asOf = new Date().toISOString()
  const dateKey = insiderTapeDateKey()

  return {
    dateKey,
    asOf,
    cachedAt: asOf,
    universeId: INSIDER_TAPE_UNIVERSE_ID,
    universe: INSIDER_TAPE_UNIVERSE_LABEL,
    symbols,
    trades: results.flatMap((block) =>
      (block.rows || []).map((row) => ({
        ...row,
        symbol: (row.symbol as string) || block.symbol,
        _provider: block.provider,
      })),
    ),
    errors: results.filter((r) => r.error).map((r) => ({ symbol: r.symbol, error: r.error })),
    providers,
  }
}

function withMeta(
  body: Omit<InsidersTapePayload, 'meta'> & {
    providers?: string[]
    meta?: InsidersTapePayload['meta']
  },
  opts: { stale?: boolean; limitPerSymbol: number },
): InsidersTapePayload {
  const { providers, meta: _prev, ...rest } = body
  const provider = providers?.[0] ?? body.meta?.provider ?? 'mixed'
  return {
    ...rest,
    meta: {
      origin: 'local',
      provider,
      asOf: rest.asOf,
      cachedAt: rest.cachedAt,
      stale: opts.stale,
      limitPerSymbol: opts.limitPerSymbol,
    },
  }
}

/**
 * Read today's tape from disk, or refresh once and persist.
 * Concurrent callers share one in-flight refresh.
 */
export async function getInsidersTape(
  equityClient: EquityClientLike,
  opts: { force?: boolean; limitPerSymbol?: number } = {},
): Promise<InsidersTapePayload> {
  const limitPerSymbol = opts.limitPerSymbol ?? DEFAULT_LIMIT
  const today = insiderTapeDateKey()

  if (!opts.force) {
    const cached = await readCache()
    if (cached && cached.dateKey === today) {
      return withMeta(cached, { limitPerSymbol: cached.meta?.limitPerSymbol ?? limitPerSymbol })
    }
  }

  if (inflight) return inflight

  inflight = (async () => {
    try {
      const fresh = await fetchUniverse(equityClient, limitPerSymbol)
      const payload = withMeta(fresh, { limitPerSymbol })
      await writeCache(payload)
      return payload
    } catch (err) {
      const stale = await readCache()
      if (stale) {
        return withMeta(
          { ...stale, providers: [stale.meta?.provider].filter(Boolean) as string[] },
          { stale: true, limitPerSymbol: stale.meta?.limitPerSymbol ?? limitPerSymbol },
        )
      }
      throw err
    } finally {
      inflight = null
    }
  })()

  return inflight
}
