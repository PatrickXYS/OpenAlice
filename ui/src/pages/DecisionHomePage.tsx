import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight } from 'lucide-react'
import { api, type Position } from '../api'
import type { InboxEntry } from '../api/inbox'
import { PageHeader } from '../components/PageHeader'
import { Skeleton } from '../components/StateViews'
import { fmt, fmtPnl } from '../lib/format'
import { formatRelativeTime } from '../lib/intl'
import { inboxLive } from '../live/inbox'
import { useInboxSelection } from '../live/inbox-selection'
import { useInboxRead, useUnreadInboxCount } from '../live/inbox-read'
import { useWorkspace } from '../tabs/store'
import { useWorkspaces } from '../contexts/workspaces-context'
import { readWorkspaceFile } from '../components/workspace/api'
import { displayProviderForUTA, filterAccountTierUTAs } from '../lib/uta-account-filter'
import { ensureTradingModePolling } from '../live/trading-mode'
import { contractPrimary } from '../lib/contract-display'

interface PendingOrder {
  action?: string
  symbol?: string
  qty?: number | string | null
  planPrice?: number | string | null
  sleeve?: string
  thesis?: string
}

interface PendingPayload {
  status?: string
  asOf?: string
  accountId?: string
  equity?: number
  orders?: PendingOrder[]
  crossEntries?: string[]
  themeEntries?: string[]
  filteredOut?: Array<{ symbol?: string; reasonKind?: string; note?: string }>
  marketHealth?: { label?: string }
  workspaceId?: string
}

function isDigestEntry(e: InboxEntry): boolean {
  const paths = (e.docs ?? []).map((d) => d.path)
  if (paths.some((p) => /(?:^|\/)digest\/daily-|\b每日总结\b/i.test(p) || p.includes('outputs/digest/daily-'))) {
    return true
  }
  const c = e.comments ?? ''
  return /每日总结|Daily digest/i.test(c)
}

function isAlertish(e: InboxEntry): boolean {
  if (isDigestEntry(e)) return false
  const c = (e.comments ?? '').toLowerCase()
  return (
    /form 4|insider|相对大额|崩塌|alert|拟买入|拟平仓|paper plan|paper execute|intraday/i.test(c) ||
    /sell |buy /i.test(c)
  )
}

/**
 * Decision Home — one screen for "do I need to act today?"
 * Aggregates portfolio snapshot, paper pending, latest Chinese digest,
 * and recent alert-ish inbox pushes. Deep-links into existing surfaces.
 */
export function DecisionHomePage() {
  const { t } = useTranslation()
  const openOrFocus = useWorkspace((s) => s.openOrFocus)
  const selectInbox = useInboxSelection((s) => s.select)
  const markRead = useInboxRead((s) => s.markRead)
  const unread = useUnreadInboxCount()
  const entries = inboxLive.useStore((s) => s.entries)
  const inboxLoading = inboxLive.useStore((s) => s.loading)
  const { workspaces } = useWorkspaces()

  const [equityLoading, setEquityLoading] = useState(true)
  const [equity, setEquity] = useState<{
    totalEquity: string
    totalCash: string
    totalUnrealizedPnL: string
  } | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [positionsLabel, setPositionsLabel] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingPayload | null>(null)
  const [pendingLoading, setPendingLoading] = useState(true)

  useEffect(() => {
    ensureTradingModePolling()
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setEquityLoading(true)
      try {
        const [eq, utasRes] = await Promise.all([
          api.trading.equity().catch(() => null),
          api.trading.listUTAs().catch(() => ({ utas: [] })),
        ])
        if (cancelled) return
        if (eq) {
          setEquity({
            totalEquity: eq.totalEquity,
            totalCash: eq.totalCash,
            totalUnrealizedPnL: eq.totalUnrealizedPnL,
          })
        } else {
          setEquity(null)
        }
        const utas = filterAccountTierUTAs(utasRes.utas ?? [])
        const paper =
          utas.find((u) => /alpaca|paper/i.test(`${u.id} ${u.label ?? ''} ${displayProviderForUTA(u)}`)) ??
          utas[0]
        if (paper) {
          const pos = await api.trading.utaPositions(paper.id).catch(() => ({ positions: [] as Position[] }))
          if (cancelled) return
          setPositions(pos.positions ?? [])
          setPositionsLabel(paper.label || paper.id)
        } else {
          setPositions([])
          setPositionsLabel(null)
        }
      } finally {
        if (!cancelled) setEquityLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setPendingLoading(true)
      try {
        const ids = workspaces.map((w) => w.id)
        const results = await Promise.all(
          ids.map(async (id) => {
            const r = await readWorkspaceFile(id, 'outputs/paper/pending.json')
            if (r.kind !== 'ok') return null
            try {
              const parsed = JSON.parse(r.content) as PendingPayload
              return { ...parsed, workspaceId: id }
            } catch {
              return null
            }
          }),
        )
        if (cancelled) return
        const live = results.find(
          (p) => p && p.status === 'pending' && Array.isArray(p.orders) && p.orders.length > 0,
        )
        const any = results.find((p) => p && p.asOf)
        setPending(live ?? any ?? null)
      } finally {
        if (!cancelled) setPendingLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaces])

  const digest = useMemo(
    () => entries.find(isDigestEntry) ?? null,
    [entries],
  )

  const alerts = useMemo(() => {
    const dayAgo = Date.now() - 36 * 60 * 60 * 1000
    return entries
      .filter((e) => e.ts >= dayAgo && isAlertish(e))
      .slice(0, 6)
  }, [entries])

  const topPositions = useMemo(() => {
    return [...positions]
      .sort((a, b) => Math.abs(Number(b.marketValue) || 0) - Math.abs(Number(a.marketValue) || 0))
      .slice(0, 6)
  }, [positions])

  const pendingOrders = pending?.orders ?? []
  const buys = pendingOrders.filter((o) => String(o.action || '').toUpperCase() === 'BUY')
  const closes = pendingOrders.filter((o) => String(o.action || '').toUpperCase() === 'CLOSE')

  const openInboxEntry = (entry: InboxEntry) => {
    selectInbox(entry.id)
    markRead(entry.id)
    openOrFocus({ kind: 'inbox', params: {} })
  }

  const loading = equityLoading || inboxLoading || pendingLoading

  return (
    <div className="h-full flex flex-col min-h-0">
      <PageHeader title={t('nav.item.home')} description={t('home.subtitle')} />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[880px] mx-auto px-4 md:px-8 py-6">
        {loading && !equity && entries.length === 0 ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="space-y-8">
            {/* Act today */}
            <section>
              <SectionTitle>{t('home.actToday')}</SectionTitle>
              <div className="mt-3 rounded-lg border border-border bg-bg-secondary/40 divide-y divide-border/60">
                <ActionRow
                  label={t('home.pendingBuys')}
                  value={
                    buys.length
                      ? buys.map((o) => o.symbol).filter(Boolean).join(', ')
                      : t('home.none')
                  }
                  emphasis={buys.length > 0}
                  onClick={() => {
                    if (pending?.workspaceId) {
                      openOrFocus({
                        kind: 'file-viewer',
                        params: { wsId: pending.workspaceId, path: 'outputs/paper/pending.json' },
                      })
                    } else {
                      openOrFocus({ kind: 'portfolio', params: {} })
                    }
                  }}
                />
                <ActionRow
                  label={t('home.pendingCloses')}
                  value={
                    closes.length
                      ? closes.map((o) => o.symbol).filter(Boolean).join(', ')
                      : t('home.none')
                  }
                  emphasis={closes.length > 0}
                  onClick={() => {
                    if (pending?.workspaceId) {
                      openOrFocus({
                        kind: 'file-viewer',
                        params: { wsId: pending.workspaceId, path: 'outputs/paper/pending.json' },
                      })
                    }
                  }}
                />
                <ActionRow
                  label={t('home.unreadInbox')}
                  value={unread > 0 ? String(unread) : t('home.none')}
                  emphasis={unread > 0}
                  onClick={() => openOrFocus({ kind: 'inbox', params: {} })}
                />
                {pending?.asOf && (
                  <div className="px-4 py-2.5 text-[12px] text-text-muted/70">
                    {t('home.pendingAsOf', {
                      asOf: pending.asOf,
                      health: pending.marketHealth?.label ?? '—',
                    })}
                  </div>
                )}
              </div>
            </section>

            {/* Digest */}
            <section>
              <SectionTitle>{t('home.digest')}</SectionTitle>
              {digest ? (
                <button
                  type="button"
                  onClick={() => openInboxEntry(digest)}
                  className="mt-3 w-full text-left rounded-lg border border-border bg-bg-secondary/40 px-4 py-4 hover:border-accent/40 hover:bg-bg-tertiary/40 transition-colors group"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] text-text leading-relaxed line-clamp-3 whitespace-pre-wrap">
                        {(digest.comments || t('home.digestOpen')).trim()}
                      </div>
                      <div className="mt-2 text-[11px] text-text-muted/60 tabular-nums">
                        {formatRelativeTime(digest.ts)}
                        {digest.workspaceLabel ? ` · ${digest.workspaceLabel}` : ''}
                      </div>
                    </div>
                    <ArrowRight
                      size={16}
                      strokeWidth={1.75}
                      className="shrink-0 mt-0.5 text-text-muted/50 group-hover:text-accent transition-colors"
                    />
                  </div>
                </button>
              ) : (
                <EmptyHint>{t('home.noDigest')}</EmptyHint>
              )}
            </section>

            {/* Portfolio snapshot */}
            <section>
              <div className="flex items-center justify-between gap-3">
                <SectionTitle>{t('home.portfolio')}</SectionTitle>
                <button
                  type="button"
                  onClick={() => openOrFocus({ kind: 'portfolio', params: {} })}
                  className="text-[12px] text-text-muted hover:text-accent transition-colors"
                >
                  {t('home.openPortfolio')}
                </button>
              </div>
              {equity ? (
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <Metric label={t('home.equity')} value={fmt(equity.totalEquity)} />
                  <Metric label={t('home.cash')} value={fmt(equity.totalCash)} />
                  <Metric
                    label={t('home.unrealized')}
                    value={fmtPnl(equity.totalUnrealizedPnL)}
                    signed
                  />
                </div>
              ) : (
                <EmptyHint>{t('home.noPortfolio')}</EmptyHint>
              )}
              {topPositions.length > 0 && (
                <div className="mt-4 rounded-lg border border-border overflow-hidden">
                  <div className="px-3 py-2 text-[11px] text-text-muted/60 uppercase tracking-wider bg-bg-secondary/50">
                    {positionsLabel
                      ? t('home.topPositionsIn', { label: positionsLabel })
                      : t('home.topPositions')}
                  </div>
                  <ul className="divide-y divide-border/60">
                    {topPositions.map((p) => {
                      const name = contractPrimary(p.contract) || p.contract.symbol || '—'
                      const key = p.contract.aliceId || name
                      return (
                        <li key={key} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                          <span className="font-medium text-text w-20 shrink-0 truncate">{name}</span>
                          <span className="text-text-muted/70 tabular-nums flex-1 text-right">
                            {fmt(p.marketValue, p.currency)}
                          </span>
                          <span className={`tabular-nums w-24 text-right ${Number(p.unrealizedPnL) >= 0 ? 'text-green' : 'text-red'}`}>
                            {fmtPnl(p.unrealizedPnL, p.currency)}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </section>

            {/* Recent alerts */}
            <section>
              <div className="flex items-center justify-between gap-3">
                <SectionTitle>{t('home.recentAlerts')}</SectionTitle>
                <button
                  type="button"
                  onClick={() => openOrFocus({ kind: 'inbox', params: {} })}
                  className="text-[12px] text-text-muted hover:text-accent transition-colors"
                >
                  {t('home.openInbox')}
                </button>
              </div>
              {alerts.length === 0 ? (
                <EmptyHint>{t('home.noAlerts')}</EmptyHint>
              ) : (
                <ul className="mt-3 rounded-lg border border-border divide-y divide-border/60 overflow-hidden">
                  {alerts.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => openInboxEntry(e)}
                        className="w-full text-left px-4 py-3 hover:bg-bg-tertiary/50 transition-colors"
                      >
                        <div className="text-[13px] text-text line-clamp-2">
                          {(e.comments || e.docs?.[0]?.path || e.id).trim()}
                        </div>
                        <div className="mt-1 text-[11px] text-text-muted/55 tabular-nums">
                          {formatRelativeTime(e.ts)}
                          {e.workspaceLabel ? ` · ${e.workspaceLabel}` : ''}
                          {!e.readAt ? ` · ${t('home.unreadTag')}` : ''}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[12px] font-semibold uppercase tracking-wider text-text-muted/70">
      {children}
    </h2>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-[13px] text-text-muted/60 italic border border-dashed border-border/70 rounded-lg px-4 py-5">
      {children}
    </p>
  )
}

function Metric({
  label,
  value,
  signed,
}: {
  label: string
  value: string
  signed?: boolean
}) {
  const tone =
    signed && value.startsWith('+')
      ? 'text-green'
      : signed && value.startsWith('-')
        ? 'text-red'
        : 'text-text'
  return (
    <div className="rounded-lg border border-border bg-bg-secondary/40 px-3 py-3">
      <div className="text-[11px] text-text-muted/65">{label}</div>
      <div className={`mt-1 text-[15px] font-medium tabular-nums ${tone}`}>{value}</div>
    </div>
  )
}

function ActionRow({
  label,
  value,
  emphasis,
  onClick,
}: {
  label: string
  value: string
  emphasis?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-tertiary/40 transition-colors group"
    >
      <span className="text-[13px] text-text-muted/80 flex-1">{label}</span>
      <span
        className={`text-[13px] tabular-nums truncate max-w-[55%] ${
          emphasis ? 'text-text font-medium' : 'text-text-muted/60'
        }`}
      >
        {value}
      </span>
      <ArrowRight
        size={14}
        strokeWidth={1.75}
        className="shrink-0 text-text-muted/40 group-hover:text-accent transition-colors"
      />
    </button>
  )
}
