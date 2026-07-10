import { describe, expect, it } from 'vitest'
import { insiderTapeDateKey, INSIDER_TAPE_UNIVERSE } from './insider-tape.js'

describe('insider-tape', () => {
  it('uses a fixed SOXX+DRAM universe', () => {
    expect(INSIDER_TAPE_UNIVERSE).toContain('NVDA')
    expect(INSIDER_TAPE_UNIVERSE).toContain('MU')
    expect(INSIDER_TAPE_UNIVERSE).toContain('SNDK')
    expect(INSIDER_TAPE_UNIVERSE.length).toBeGreaterThan(20)
  })

  it('dateKey is YYYY-MM-DD in America/New_York', () => {
    const key = insiderTapeDateKey(new Date('2026-07-10T18:00:00.000Z'))
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // 18:00 UTC = 14:00 ET in July → still 2026-07-10
    expect(key).toBe('2026-07-10')
  })
})
