import type { InsiderTradeRow } from '../../api/market'

export type InsiderSide = 'BUY' | 'SELL' | 'AWARD' | 'GIFT' | 'EXERCISE' | 'OTHER'

export function classifyInsiderSide(row: InsiderTradeRow): InsiderSide {
  const aod = String(row.acquisition_or_disposition || '').toUpperCase()
  const t = String(row.transaction_type || '').toLowerCase()

  // Non-market Form 4 codes first — Yahoo text often embeds "Sale" inside
  // tax-withhold / exercise narratives; keyword order matters.
  if (/\b(award|grant)\b/i.test(t) || /\bstock\s*award/i.test(t)) return 'AWARD'
  if (/\bgift\b/i.test(t)) return 'GIFT'
  if (/\b(conversion|option\s*exercise|exercise of derivative)\b/i.test(t)) return 'EXERCISE'
  if (/\b(tax|withhold|vest)\b/i.test(t)) return 'OTHER'

  if (aod === 'A' || aod === 'ACQUISITION') return 'BUY'
  if (aod === 'D' || aod === 'DISPOSITION') return 'SELL'
  if (/\b(purchase|buy|acquisition)\b/i.test(t)) return 'BUY'
  if (/\b(sale|sell|disposition)\b/i.test(t)) return 'SELL'

  // Empty Yahoo transactionText — usually awards / code-M / tax rows with no
  // open-market price. Keep out of BUY/SELL so the tape stays actionable.
  return 'OTHER'
}

export function isOpenMarketSide(side: InsiderSide): boolean {
  return side === 'BUY' || side === 'SELL'
}

function parsePriceFromType(transactionType: string | null | undefined): number | null {
  const t = String(transactionType || '')
  const range = t.match(/price\s+([\d.]+)\s*-\s*([\d.]+)/i)
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2
  }
  const one = t.match(/price\s+([\d.]+)/i)
  if (one) {
    const p = Number(one[1])
    if (Number.isFinite(p)) return p
  }
  return null
}

export type InsiderViewRow = {
  symbol: string
  side: InsiderSide
  when: string
  owner: string
  title: string
  shares: number | null
  price: number | null
  notional: number | null
  rawType: string
}

export function toInsiderViewRow(row: InsiderTradeRow, fallbackSymbol = ''): InsiderViewRow {
  const shares = typeof row.securities_transacted === 'number' ? row.securities_transacted : null
  let price = typeof row.transaction_price === 'number' ? row.transaction_price : null
  if (!(price != null && price > 0)) price = parsePriceFromType(row.transaction_type)
  // Grants at $0 are not open-market notionals.
  if (price != null && price <= 0) price = null
  const notional =
    shares != null && shares > 0 && price != null && price > 0 ? shares * price : null
  return {
    symbol: String(row.symbol || fallbackSymbol || '').toUpperCase() || '—',
    side: classifyInsiderSide(row),
    when: String(row.filing_date || row.transaction_date || '').slice(0, 10) || '—',
    owner: row.owner_name || '—',
    title: row.owner_title || '—',
    shares,
    price,
    notional,
    rawType: row.transaction_type || '',
  }
}
