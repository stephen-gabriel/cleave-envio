import { BigDecimal, indexer, type EvmOnEventContext, type Account, type Pool, type ProtocolStats } from 'envio'
import { walletClassifier } from '../simulation'
import simulated from '../config/sim-wallets.json'
import deployment from '../config/monad-testnet.json'

type Context = EvmOnEventContext
type EventMeta = {
  chainId: number; logIndex: number; srcAddress: string
  block: { number: number; timestamp: number }; transaction: { hash: string }
}
const isSimulated = walletClassifier(simulated.wallets)
const pricePool = deployment.contracts.poolPrice.address.toLowerCase()
const divPool = deployment.contracts.poolDiv.address.toLowerCase()
const idOf = (e: EventMeta) => `${e.chainId}_${e.block.number}_${e.logIndex}`
const zeroStats = (): ProtocolStats => ({
  id: 'global', totalSplit: 0n, totalMerged: 0n, totalRedeemed: 0n, tradeCount: 0,
  volumeUsd: 0n, simulatedVolumeUsd: 0n, organicVolumeUsd: 0n, uniqueAccounts: 0,
  organicAccounts: 0, dividendsDeclared: 0, dividendsDistributed: 0, dividendsPaidUsd: 0n,
})
async function stats(context: Context) { return await context.ProtocolStats.get('global') ?? zeroStats() }
async function actor(context: Context, address: string, timestamp: number) {
  const id = address.toLowerCase()
  const [existing, totals] = await Promise.all([context.Account.get(id), stats(context)])
  const account: Account = existing ?? {
    id, firstSeenAt: timestamp, isSimulated: isSimulated(id), splitVolume: 0n,
    tradeVolumeUsd: 0n, tradeCount: 0, dividendsClaimed: 0n,
  }
  return { account, totals: existing ? totals : {
    ...totals, uniqueAccounts: totals.uniqueAccounts + 1,
    organicAccounts: totals.organicAccounts + (account.isSimulated ? 0 : 1),
  } }
}
async function pool(context: Context, address: string): Promise<Pool> {
  const id = address.toLowerCase()
  if (id !== pricePool && id !== divPool) throw new Error('Unknown Series A pool')
  return await context.Pool.get(id) ?? {
    id, kind: id === pricePool ? 'price' : 'dividend', reserveToken: 0n, reserveQuote: 0n,
    lastPrice: new BigDecimal(0), volumeUsd: 0n, tradeCount: 0,
  }
}
function ratio(quote: bigint, token: bigint) {
  return token === 0n ? new BigDecimal(0) : new BigDecimal(quote.toString()).div(token.toString())
}
function activity(context: Context, event: EventMeta, kind: string, address: string, amount: bigint, details: { pool?: string; quoteAmount?: bigint; isSimulated?: boolean } = {}) {
  context.Activity.set({
    id: idOf(event), kind, account: address.toLowerCase(), amount, pool: details.pool,
    quoteAmount: details.quoteAmount, timestamp: event.block.timestamp, blockNumber: event.block.number,
    logIndex: event.logIndex, txHash: event.transaction.hash, isSimulated: details.isSimulated ?? isSimulated(address),
  })
}

for (const kind of ['Split', 'Merge', 'Redeem'] as const) {
  indexer.onEvent({ contract: 'Splitter', event: kind }, async ({ event, context }) => {
    if (await context.Activity.get(idOf(event))) return
    const { account, totals } = await actor(context, event.params.user, event.block.timestamp)
    context.Account.set({ ...account, splitVolume: account.splitVolume + (kind === 'Split' ? event.params.amount : 0n) })
    context.ProtocolStats.set({
      ...totals, totalSplit: totals.totalSplit + (kind === 'Split' ? event.params.amount : 0n),
      totalMerged: totals.totalMerged + (kind === 'Merge' ? event.params.amount : 0n),
      totalRedeemed: totals.totalRedeemed + (kind === 'Redeem' ? event.params.amount : 0n),
    })
    context.SplitEvent.set({
      id: idOf(event), user: account.id, amount: event.params.amount, kind,
      isMerge: kind === 'Merge', timestamp: event.block.timestamp,
      isSimulated: account.isSimulated, txHash: event.transaction.hash,
    })
    activity(context, event, kind, account.id, event.params.amount, { isSimulated: account.isSimulated })
  })
}

indexer.onEvent({ contract: 'Pool', event: 'Swap' }, async ({ event, context }) => {
  if (await context.Activity.get(idOf(event))) return
  const p = event.params
  const [{ account, totals }, previous] = await Promise.all([
    actor(context, p.trader, event.block.timestamp), pool(context, event.srcAddress),
  ])
  const price = ratio(p.reserveQuote, p.reserveToken)
  const hour = Math.floor(event.block.timestamp / 3600)
  const hourId = `${previous.id}_${hour}`
  const candle = await context.PoolHourly.get(hourId)
  context.Account.set({ ...account, tradeCount: account.tradeCount + 1, tradeVolumeUsd: account.tradeVolumeUsd + p.amountQuote })
  context.Pool.set({ ...previous, reserveToken: p.reserveToken, reserveQuote: p.reserveQuote, lastPrice: price,
    tradeCount: previous.tradeCount + 1, volumeUsd: previous.volumeUsd + p.amountQuote })
  context.Swap.set({ id: idOf(event), pool_id: previous.id, trader: account.id, isBuy: p.isBuy,
    amountToken: p.amountToken, amountQuote: p.amountQuote, price, timestamp: event.block.timestamp,
    isSimulated: account.isSimulated, txHash: event.transaction.hash })
  context.PoolHourly.set({ id: hourId, pool_id: previous.id, hour,
    open: candle?.open ?? price, high: candle ? BigDecimal.maximum(candle.high, price) : price,
    low: candle ? BigDecimal.minimum(candle.low, price) : price, close: price,
    volumeUsd: (candle?.volumeUsd ?? 0n) + p.amountQuote, trades: (candle?.trades ?? 0) + 1 })
  context.ProtocolStats.set({ ...totals, tradeCount: totals.tradeCount + 1, volumeUsd: totals.volumeUsd + p.amountQuote,
    simulatedVolumeUsd: totals.simulatedVolumeUsd + (account.isSimulated ? p.amountQuote : 0n),
    organicVolumeUsd: totals.organicVolumeUsd + (account.isSimulated ? 0n : p.amountQuote) })
  activity(context, event, p.isBuy ? 'Buy' : 'Sell', account.id, p.amountToken, { pool: previous.id, quoteAmount: p.amountQuote, isSimulated: account.isSimulated })
})

indexer.onEvent({ contract: 'Pool', event: 'LiquidityChanged' }, async ({ event, context }) => {
  if (await context.Activity.get(idOf(event))) return
  const p = event.params
  const [{ account, totals }, previous] = await Promise.all([
    actor(context, p.provider, event.block.timestamp), pool(context, event.srcAddress),
  ])
  context.Account.set(account)
  context.ProtocolStats.set(totals)
  context.Pool.set({ ...previous, reserveToken: p.reserveToken, reserveQuote: p.reserveQuote,
    lastPrice: ratio(p.reserveQuote, p.reserveToken) })
  context.LiquidityEvent.set({ id: idOf(event), pool_id: previous.id, provider: account.id,
    added: p.added, tokenAmt: p.tokenAmt, quoteAmt: p.quoteAmt,
    timestamp: event.block.timestamp, txHash: event.transaction.hash })
  activity(context, event, p.added ? 'AddLiquidity' : 'RemoveLiquidity', account.id, p.tokenAmt, { pool: previous.id, quoteAmount: p.quoteAmt, isSimulated: account.isSimulated })
})

indexer.onEvent({ contract: 'DividendOracle', event: 'DividendDeclared' }, async ({ event, context }) => {
  if (await context.Activity.get(idOf(event))) return
  const p = event.params
  const totals = await stats(context)
  context.DividendDeclaration.set({ id: p.id.toString(), seq: p.seq, amountPerShare: p.amountPerShare,
    refPrice: p.refPrice, exAt: Number(p.exAt), declaredAt: event.block.timestamp,
    source: Number(p.source) === 0 ? 'CRE' : 'Demo', txHash: event.transaction.hash,
    distributed: false, distributedAt: undefined, totalPaid: undefined, supplyAtDistribution: undefined })
  context.ProtocolStats.set({ ...totals, dividendsDeclared: totals.dividendsDeclared + 1 })
  activity(context, event, 'Declare', event.transaction.from ?? event.srcAddress, p.amountPerShare)
})

indexer.onEvent({ contract: 'Splitter', event: 'DividendDistributed' }, async ({ event, context }) => {
  if (await context.Activity.get(idOf(event))) return
  const p = event.params
  const [declaration, { account, totals }] = await Promise.all([
    context.DividendDeclaration.get(p.id.toString()), actor(context, p.caller, event.block.timestamp),
  ])
  // A missing declaration means the configured history is incomplete. Fail rather than fabricate data.
  if (!declaration) throw new Error(`Missing declaration ${p.id}; check oracle start_block`)
  context.DividendDeclaration.set({ ...declaration, distributed: true, distributedAt: event.block.timestamp,
    totalPaid: p.total, supplyAtDistribution: p.supply })
  context.Account.set(account)
  context.ProtocolStats.set({ ...totals, dividendsDistributed: totals.dividendsDistributed + 1,
    dividendsPaidUsd: totals.dividendsPaidUsd + p.total })
  activity(context, event, 'Distribute', account.id, p.total, { isSimulated: account.isSimulated })
})

indexer.onEvent({ contract: 'SplitToken', event: 'Claimed' }, async ({ event, context }) => {
  if (await context.Activity.get(idOf(event))) return
  const p = event.params
  const { account, totals } = await actor(context, p.account, event.block.timestamp)
  context.Account.set({ ...account, dividendsClaimed: account.dividendsClaimed + p.amount })
  context.ProtocolStats.set(totals)
  context.DividendClaim.set({ id: idOf(event), account: account.id, amount: p.amount,
    timestamp: event.block.timestamp, txHash: event.transaction.hash })
  activity(context, event, 'Claim', account.id, p.amount, { isSimulated: account.isSimulated })
})
