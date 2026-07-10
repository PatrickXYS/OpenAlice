/**
 * Market data aggregation routes.
 *
 * `/api/market/*` is Alice's own namespace for cross-asset-class behaviour
 * that doesn't map 1:1 to an opentypebb fetcher — currently just the
 * heuristic symbol search. Quote / historical / fundamentals remain on the
 * raw opentypebb passthrough at `/api/market-data-v1/*`.
 */

import { Hono } from 'hono'
import type { EngineContext } from '../../core/types.js'
import { aggregateSymbolSearch } from '../../domain/market-data/aggregate-search.js'
import { fetchSectorRotation, type SectorRotationResult } from '../../domain/analysis/sector-rotation.js'
import { createHubFetcher } from '../../domain/market-data/reference/hub.js'
import type { ReferenceMeta } from '../../domain/market-data/reference/types.js'
import type { EquityClientLike } from '../../domain/market-data/client/types.js'
import { getInsidersTape } from '../../domain/market-data/insider-tape.js'

export function createMarketRoutes(ctx: EngineContext): Hono {
  const app = new Hono()
  const rotationViaHub = createHubFetcher(ctx.config.marketData.hub)

  app.get('/search', async (c) => {
    const query = c.req.query('query') ?? ''
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Math.max(1, Math.min(100, Number(limitRaw) || 20)) : 20
    const results = await aggregateSymbolSearch(ctx.marketSearch, query, limit)
    return c.json({ results, count: results.length })
  })

  // GICS sector rotation map — same compute as the sectorRotation AI tool.
  // Hub-first: the hosted hub computes the same board (meta.origin says so).
  app.get('/sector-rotation', async (c) => {
    const hub = await rotationViaHub<SectorRotationResult & { meta: ReferenceMeta }>('rotation')
    if (hub) return c.json(hub)
    const local = await fetchSectorRotation(ctx.equityClient)
    return c.json({ ...local, meta: { provider: ctx.config.marketData.providers.equity, asOf: local.asOf, origin: 'local' as const } })
  })

  // First-party per-symbol equity endpoints — the detail-page panels'
  // replacement for the legacy /api/market-data-v1 passthrough (divorce
  // step: migrate consumers, then kill the compat layer). Same response
  // envelope ({results, provider}) so the UI swap is URL-only.
  const EQUITY_ENDPOINTS: Record<string, keyof EquityClientLike> = {
    profile: 'getProfile',
    metrics: 'getKeyMetrics',
    ratios: 'getFinancialRatios',
    balance: 'getBalanceSheet',
    income: 'getIncomeStatement',
    cash: 'getCashFlow',
    insiders: 'getInsiderTrading',
  }
  app.get('/equity/:endpoint', async (c) => {
    const endpoint = c.req.param('endpoint')
    const method = EQUITY_ENDPOINTS[endpoint]
    if (!method) {
      return c.json({ error: `Unknown equity endpoint. Available: ${Object.keys(EQUITY_ENDPOINTS).join(', ')}` }, 404)
    }
    const symbol = c.req.query('symbol')
    if (!symbol) return c.json({ error: 'symbol is required' }, 400)
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Math.max(1, Math.min(100, Number(limitRaw) || 20)) : undefined
    try {
      const fn = ctx.equityClient[method] as (p: Record<string, unknown>) => Promise<unknown[]>
      // Insiders: mirror the MCP tool — FMP first (CIKs + filing dates),
      // keyless Yahoo Form-4 rows as fallback so a dead FMP key doesn't
      // blank the detail panel.
      if (endpoint === 'insiders') {
        const params: Record<string, unknown> = { symbol }
        if (limit != null) params.limit = limit
        try {
          const results = await fn.call(ctx.equityClient, { ...params, provider: 'fmp' })
          return c.json({ results, provider: 'fmp' })
        } catch {
          const results = await fn.call(ctx.equityClient, { ...params, provider: 'yfinance' })
          return c.json({ results, provider: 'yfinance' })
        }
      }
      const results = await fn.call(ctx.equityClient, { symbol })
      return c.json({ results, provider: ctx.config.marketData.providers.equity })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  /**
   * Fixed-universe Form 4 tape (SOXX + DRAM), served from a once-per-day
   * disk cache under data/cache/insider/. First hit of the ET day refreshes;
   * later hits are a file read. ?refresh=1 forces a rebuild.
   */
  app.get('/insiders-tape', async (c) => {
    const force = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true'
    const limitRaw = c.req.query('limitPerSymbol')
    const limitPerSymbol = limitRaw ? Math.max(1, Math.min(40, Number(limitRaw) || 12)) : undefined
    try {
      const payload = await getInsidersTape(ctx.equityClient, { force, limitPerSymbol })
      return c.json(payload)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  return app
}
