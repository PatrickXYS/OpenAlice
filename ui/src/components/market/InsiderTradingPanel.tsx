import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { marketApi } from '../../api/market'
import { Skeleton } from '../StateViews'
import { Card } from './Card'
import { fmtMoneyShort, fmtNumber, fmtInt } from './format'
import {
  toInsiderViewRow,
  isOpenMarketSide,
  type InsiderSide,
  type InsiderViewRow,
} from './insider-utils'

interface Props {
  symbol: string
}

type Filter = 'market' | 'BUY' | 'SELL' | 'all'

/**
 * Form 4 / insider tape for one equity — lives on the Market detail page.
 * Defaults to open-market BUY/SELL; awards / gifts / exercises live under All.
 */
export function InsiderTradingPanel({ symbol }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<InsiderViewRow[] | null>(null)
  const [provider, setProvider] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('market')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setRows(null)
    marketApi.equity
      .insiders(symbol, 40)
      .then((res) => {
        if (cancelled) return
        if (res.error && !res.results?.length) {
          setError(res.error)
          return
        }
        setRows((res.results ?? []).map((r) => toInsiderViewRow(r, symbol)))
        setProvider(res.provider ?? null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [symbol])

  const visible = useMemo(() => {
    if (!rows) return []
    if (filter === 'market') return rows.filter((r) => isOpenMarketSide(r.side))
    if (filter === 'all') return rows
    return rows.filter((r) => r.side === filter)
  }, [rows, filter])

  const buyN = rows?.filter((r) => r.side === 'BUY').length ?? 0
  const sellN = rows?.filter((r) => r.side === 'SELL').length ?? 0

  return (
    <Card
      title={t('market.insidersTitle')}
      info={t('market.insidersInfo')}
      right={
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          {provider && <span className="opacity-70">{provider}</span>}
          <FilterChip active={filter === 'market'} onClick={() => setFilter('market')} label={t('market.insidersMarket')} />
          <FilterChip active={filter === 'BUY'} onClick={() => setFilter('BUY')} label={`${t('market.insidersBuy')} ${buyN}`} />
          <FilterChip active={filter === 'SELL'} onClick={() => setFilter('SELL')} label={`${t('market.insidersSell')} ${sellN}`} />
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label={t('market.insidersAll')} />
        </div>
      }
    >
      {loading && (
        <div className="p-3 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      )}
      {!loading && error && (
        <p className="px-3 py-4 text-[12px] text-text-muted">{error}</p>
      )}
      {!loading && !error && visible.length === 0 && (
        <p className="px-3 py-4 text-[12px] text-text-muted">{t('market.insidersEmpty')}</p>
      )}
      {!loading && !error && visible.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-text-muted border-b border-border/50">
                <th className="px-3 py-1.5 font-medium">{t('market.insidersWhen')}</th>
                <th className="px-3 py-1.5 font-medium">{t('market.insidersSide')}</th>
                <th className="px-3 py-1.5 font-medium text-right">{t('market.insidersNotional')}</th>
                <th className="px-3 py-1.5 font-medium text-right">{t('market.insidersShares')}</th>
                <th className="px-3 py-1.5 font-medium">{t('market.insidersPerson')}</th>
                <th className="px-3 py-1.5 font-medium">{t('market.insidersRole')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={`${r.when}-${r.owner}-${r.side}-${i}`} className="border-b border-border/30 last:border-0">
                  <td className="px-3 py-1.5 text-text-muted whitespace-nowrap">{r.when}</td>
                  <td className="px-3 py-1.5">
                    <SideBadge side={r.side} />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-text">
                    {r.notional != null ? fmtMoneyShort(r.notional) : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-text-muted whitespace-nowrap">
                    {r.shares != null ? fmtInt(r.shares) : '—'}
                    {r.price != null ? ` @ ${fmtNumber(r.price)}` : ''}
                  </td>
                  <td className="px-3 py-1.5 text-text truncate max-w-[140px]" title={r.owner}>
                    {r.owner}
                  </td>
                  <td className="px-3 py-1.5 text-text-muted truncate max-w-[160px]" title={r.title}>
                    {r.title}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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
      className={`px-1.5 py-0.5 rounded border transition-colors ${
        active
          ? 'border-accent/50 text-accent bg-accent/10'
          : 'border-transparent text-text-muted hover:text-text hover:bg-bg-tertiary'
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
    return <span className="text-text-muted">AWARD</span>
  }
  if (side === 'GIFT') {
    return <span className="text-text-muted">GIFT</span>
  }
  if (side === 'EXERCISE') {
    return <span className="text-text-muted">EXERCISE</span>
  }
  return <span className="text-text-muted">OTHER</span>
}
