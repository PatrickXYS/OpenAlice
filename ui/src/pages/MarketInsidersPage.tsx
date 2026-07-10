import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { marketApi, type InsidersTapeResponse } from '../api/market'
import { BoardMeta } from '../components/market/BoardMeta'
import { PageHeader } from '../components/PageHeader'
import { CenteredLoading } from '../components/StateViews'
import {
  toInsiderViewRow,
  isOpenMarketSide,
  type InsiderSide,
  type InsiderViewRow,
} from '../components/market/insider-utils'
import { fmtInt, fmtMoneyShort, fmtNumber } from '../components/market/format'
import { useWorkspace } from '../tabs/store'
import type { ReferenceMeta } from '../api/reference'

type Filter = 'market' | 'BUY' | 'SELL' | 'all'
type SortKey = 'when' | 'notional'

const LARGE_BUY_USD = 100_000
const NOTABLE_LIMIT = 8

/**
 * Fixed-universe Form 4 board. Data comes from Alice's once-per-day disk
 * cache — opening the page is a file read after the first refresh of the day.
 */
export function MarketInsidersPage() {
  const { t } = useTranslation()
  const openOrFocus = useWorkspace((s) => s.openOrFocus)

  const [data, setData] = useState<InsidersTapeResponse | null>(null)
  const [rows, setRows] = useState<InsiderViewRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('market')
  const [symbolFilter, setSymbolFilter] = useState<string>('all')
  const [sort, setSort] = useState<SortKey>('when')
  const [showUniverse, setShowUniverse] = useState(false)

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const res = await marketApi.insidersTape({ refresh })
      if (res.error) {
        setError(res.error)
        setData(null)
        setRows([])
        return
      }
      setData(res)
      setRows((res.trades ?? []).map((r) => toInsiderViewRow(r)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const buyRows = useMemo(() => rows?.filter((r) => r.side === 'BUY') ?? [], [rows])
  const sellRows = useMemo(() => rows?.filter((r) => r.side === 'SELL') ?? [], [rows])

  const buyNotional = useMemo(
    () => buyRows.reduce((s, r) => s + (r.notional ?? 0), 0),
    [buyRows],
  )
  const sellNotional = useMemo(
    () => sellRows.reduce((s, r) => s + (r.notional ?? 0), 0),
    [sellRows],
  )

  const notableBuys = useMemo(() => {
    return [...buyRows]
      .filter((r) => (r.notional ?? 0) >= LARGE_BUY_USD)
      .sort((a, b) => (b.notional ?? 0) - (a.notional ?? 0))
      .slice(0, NOTABLE_LIMIT)
  }, [buyRows])

  const activeSymbols = useMemo(() => {
    if (!rows) return []
    const counts = new Map<string, number>()
    for (const r of rows) {
      if (!isOpenMarketSide(r.side)) continue
      counts.set(r.symbol, (counts.get(r.symbol) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([symbol, count]) => ({ symbol, count }))
  }, [rows])

  const visible = useMemo(() => {
    if (!rows) return []
    let list = rows
    if (filter === 'market') list = list.filter((r) => isOpenMarketSide(r.side))
    else if (filter === 'BUY' || filter === 'SELL') list = list.filter((r) => r.side === filter)
    if (symbolFilter !== 'all') list = list.filter((r) => r.symbol === symbolFilter)
    list = [...list]
    if (sort === 'notional') {
      list.sort((a, b) => (b.notional ?? 0) - (a.notional ?? 0) || b.when.localeCompare(a.when))
    } else {
      list.sort((a, b) => b.when.localeCompare(a.when) || a.symbol.localeCompare(b.symbol))
    }
    return list
  }, [rows, filter, symbolFilter, sort])

  const nonMarketN = rows?.filter((r) => !isOpenMarketSide(r.side)).length ?? 0

  const openSymbol = (symbol: string) => {
    openOrFocus({ kind: 'market-detail', params: { assetClass: 'equity', symbol } })
  }

  const boardMeta: ReferenceMeta | null = data?.meta
    ? {
        provider: data.meta.provider ?? 'local',
        asOf: data.meta.asOf ?? data.asOf,
        origin: (data.meta.origin as ReferenceMeta['origin']) ?? 'local',
        cachedAt: data.meta.cachedAt ?? data.cachedAt,
        stale: data.meta.stale,
      }
    : null

  const universeLabel = data?.universe ?? 'SOXX + DRAM'
  const symbolCount = data?.symbols?.length ?? 0
  const updatedAt = data?.cachedAt || data?.asOf ? new Date(data.cachedAt ?? data.asOf) : null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title={t('market.insidersTape')}
        description={
          <>
            {t('market.insidersTapeSubtitle', { universe: universeLabel })}
            {boardMeta && <BoardMeta meta={boardMeta} extra={data?.dateKey ? `day ${data.dateKey}` : undefined} />}
          </>
        }
        live={{ lastUpdated: updatedAt }}
        right={
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing || loading}
            className="px-2.5 py-1 rounded-md text-[12px] border border-border/70 text-text-muted hover:text-text hover:bg-bg-tertiary disabled:opacity-50"
          >
            {refreshing ? t('market.insidersRefreshing') : t('market.insidersRefresh')}
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto min-h-0 px-4 md:px-8 py-4 flex flex-col gap-5">
        {loading && !data && <CenteredLoading label={t('common.loading')} />}

        {error && (
          <div className="text-[13px] text-red border border-red/30 rounded-md px-3 py-2 bg-red/5">{error}</div>
        )}

        {data && (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat
                label={t('market.insidersStatBuys')}
                value={`${buyRows.length}`}
                sub={buyNotional > 0 ? fmtMoneyShort(buyNotional) : undefined}
                tone="buy"
              />
              <Stat
                label={t('market.insidersStatSells')}
                value={`${sellRows.length}`}
                sub={sellNotional > 0 ? fmtMoneyShort(sellNotional) : undefined}
                tone="sell"
              />
              <Stat
                label={t('market.insidersStatActive')}
                value={`${activeSymbols.length}`}
                sub={t('market.insidersStatOfUniverse', { count: symbolCount })}
              />
              <Stat
                label={t('market.insidersStatNet')}
                value={fmtMoneyShort(buyNotional - sellNotional)}
                sub={t('market.insidersStatNetHint')}
                tone={buyNotional - sellNotional >= 0 ? 'buy' : 'sell'}
              />
            </div>

            {/* Universe disclosure */}
            <div className="text-[11px] text-text-muted">
              <button
                type="button"
                onClick={() => setShowUniverse((v) => !v)}
                className="hover:text-text transition-colors"
              >
                {t('market.insidersTapeUniverse', { count: symbolCount, universe: universeLabel })}
                <span className="ml-1 opacity-60">{showUniverse ? '▾' : '▸'}</span>
              </button>
              {showUniverse && data.symbols && (
                <p className="mt-1.5 font-mono text-text/75 leading-relaxed">
                  {data.symbols.join(' · ')}
                </p>
              )}
            </div>

            {/* Notable buys */}
            {notableBuys.length > 0 && (
              <section>
                <h2 className="text-[12px] font-semibold text-text mb-2">
                  {t('market.insidersNotableBuys')}
                  <span className="ml-2 font-normal text-text-muted">
                    {t('market.insidersNotableBuysHint', { min: fmtMoneyShort(LARGE_BUY_USD) })}
                  </span>
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  {notableBuys.map((r, i) => (
                    <button
                      key={`${r.symbol}-${r.when}-${r.owner}-${i}`}
                      type="button"
                      onClick={() => openSymbol(r.symbol)}
                      className="text-left rounded-md border border-border/60 bg-bg-secondary/30 hover:bg-bg-tertiary/50 px-3 py-2.5 transition-colors"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono font-semibold text-text">{r.symbol}</span>
                        <span className="font-semibold text-green tabular-nums">
                          {r.notional != null ? fmtMoneyShort(r.notional) : '—'}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted truncate" title={r.owner}>
                        {r.owner}
                      </div>
                      <div className="mt-0.5 text-[10px] text-text-muted/70 flex justify-between gap-2">
                        <span className="truncate">{r.title}</span>
                        <span className="shrink-0">{r.when}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Filters + tape */}
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <FilterChip
                  active={filter === 'market'}
                  onClick={() => setFilter('market')}
                  label={t('market.insidersMarket')}
                />
                <FilterChip
                  active={filter === 'BUY'}
                  onClick={() => setFilter('BUY')}
                  label={`${t('market.insidersBuy')} ${buyRows.length}`}
                />
                <FilterChip
                  active={filter === 'SELL'}
                  onClick={() => setFilter('SELL')}
                  label={`${t('market.insidersSell')} ${sellRows.length}`}
                />
                <FilterChip
                  active={filter === 'all'}
                  onClick={() => setFilter('all')}
                  label={`${t('market.insidersAll')} (${nonMarketN} ${t('market.insidersNonMarket')})`}
                />
                <span className="w-px h-4 bg-border/60 mx-1" />
                <select
                  value={symbolFilter}
                  onChange={(e) => setSymbolFilter(e.target.value)}
                  className="bg-bg border border-border/70 rounded-md text-[12px] px-2 py-1 text-text outline-none focus:border-accent"
                >
                  <option value="all">{t('market.insidersAllSymbols')}</option>
                  {activeSymbols.map(({ symbol, count }) => (
                    <option key={symbol} value={symbol}>
                      {symbol} ({count})
                    </option>
                  ))}
                </select>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="bg-bg border border-border/70 rounded-md text-[12px] px-2 py-1 text-text outline-none focus:border-accent"
                >
                  <option value="when">{t('market.insidersSortWhen')}</option>
                  <option value="notional">{t('market.insidersSortNotional')}</option>
                </select>
              </div>

              {visible.length === 0 ? (
                <p className="py-6 text-[13px] text-text-muted">{t('market.insidersEmpty')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] border-collapse">
                    <thead>
                      <tr className="text-text-muted/70 text-left border-b border-border">
                        <th className="py-1.5 pr-3 font-medium">{t('market.colSymbol')}</th>
                        <th className="py-1.5 px-3 font-medium">{t('market.insidersWhen')}</th>
                        <th className="py-1.5 px-3 font-medium">{t('market.insidersSide')}</th>
                        <th className="py-1.5 px-3 font-medium text-right">{t('market.insidersNotional')}</th>
                        <th className="py-1.5 px-3 font-medium text-right">{t('market.insidersShares')}</th>
                        <th className="py-1.5 px-3 font-medium">{t('market.insidersPerson')}</th>
                        <th className="py-1.5 pl-3 font-medium">{t('market.insidersRole')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r, i) => (
                        <tr
                          key={`${r.symbol}-${r.when}-${r.owner}-${r.side}-${i}`}
                          className="border-b border-border/50 hover:bg-bg-secondary/40 cursor-pointer"
                          onClick={() => openSymbol(r.symbol)}
                        >
                          <td className="py-1.5 pr-3">
                            <span
                              className={`inline-block w-0.5 h-3 mr-2 rounded-full align-middle ${
                                r.side === 'BUY' ? 'bg-green' : r.side === 'SELL' ? 'bg-red-400' : 'bg-border'
                              }`}
                            />
                            <span className="font-mono font-semibold text-text">{r.symbol}</span>
                          </td>
                          <td className="py-1.5 px-3 text-text-muted whitespace-nowrap">{r.when}</td>
                          <td className="py-1.5 px-3">
                            <SideBadge side={r.side} />
                          </td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-text">
                            {r.notional != null ? fmtMoneyShort(r.notional) : '—'}
                          </td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-text-muted whitespace-nowrap">
                            {r.shares != null ? fmtInt(r.shares) : '—'}
                            {r.price != null ? ` @ ${fmtNumber(r.price)}` : ''}
                          </td>
                          <td className="py-1.5 px-3 text-text truncate max-w-[160px]" title={r.owner}>
                            {r.owner}
                          </td>
                          <td className="py-1.5 pl-3 text-text-muted truncate max-w-[180px]" title={r.title}>
                            {r.title}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {data.errors && data.errors.length > 0 && (
              <p className="text-[11px] text-text-muted/80">
                {t('market.insidersTapePartialErrors', {
                  symbols: data.errors.map((e) => e.symbol).join(', '),
                })}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'buy' | 'sell'
}) {
  const valueClass =
    tone === 'buy' ? 'text-green' : tone === 'sell' ? 'text-red-400' : 'text-text'
  return (
    <div className="rounded-md border border-border/50 bg-bg-secondary/20 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-text-muted/80">{label}</div>
      <div className={`mt-0.5 text-[18px] font-semibold tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-text-muted">{sub}</div>}
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
        active
          ? 'bg-bg-tertiary text-text'
          : 'text-text-muted hover:text-text hover:bg-bg-secondary'
      }`}
    >
      {label}
    </button>
  )
}

function SideBadge({ side }: { side: InsiderSide }) {
  if (side === 'BUY') {
    return <span className="font-semibold text-green">BUY</span>
  }
  if (side === 'SELL') {
    return <span className="font-semibold text-red-400">SELL</span>
  }
  if (side === 'AWARD') {
    return <span className="text-text-muted" title="Stock award / grant">AWARD</span>
  }
  if (side === 'GIFT') {
    return <span className="text-text-muted" title="Gift">GIFT</span>
  }
  if (side === 'EXERCISE') {
    return <span className="text-text-muted" title="Option / derivative exercise">EXERCISE</span>
  }
  return <span className="text-text-muted" title="Non-market / unclassified Form 4">OTHER</span>
}
