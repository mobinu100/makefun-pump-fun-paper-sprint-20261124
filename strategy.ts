// Pump.fun Paper Sprint bot — 6-hour window, tiny-stake early momentum, fast exits.
//
// Idea: on a 6h window most curves die fast, so survive first and let a few
// runners pay. One small buy per coin (0.04 SOL), only into coins that already
// show early buying pressure shortly after creation, then exit fast: take
// profit at +40%, cut at -10%, trail winners, never hold past 3600 slots.
// No leverage, no shorts, no re-buys, no clock, no randomness, no network.
// hello: each batch of orders is decided once per slot, from that slot's events only.
import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = 40_000_000n; // 0.04 SOL per coin: clears the 0.01 SOL round-trip bar with room.
const MIN_CAP_LAMPORTS = 10_000_000n; // 0.01 SOL: never buy below the guardrail size.
const ENTRY_WINDOW_SLOTS = 900; // only buy young coins, while the move is early.
const ENTRY_MIN_BUYS = 2; // need at least two buys since creation...
const ENTRY_RISE_BPS = 300; // ...and price up >= 3% from its create price.
const TP_BPS = 4000; // take profit +40%.
const SL_BPS = 1000; // stop loss -10%.
const TRAIL_ARM_BPS = 2000; // trailing stop arms at +20%...
const TRAIL_DROP_BPS = 1200; // ...and sells on a 12% pullback from the peak.
const MAX_HOLD_SLOTS = 3600; // never hold longer than this; the window is only 6h.
const BUY_SLIPPAGE_BPS = 2000; // widened from 1000: v1 grade-local showed 4 rejected + 7 failed fills, each failed order still pays the tx fee, so fewer rejects beats a slightly worse fill price on fast curves.
const SELL_SLIPPAGE_BPS = 10_000;

interface Coin {
  mint: string;
  createdSlot: number;
  createNum: bigint;
  createDen: bigint;
  buys: number;
  sells: number;
  decided: boolean;
  entryNum: bigint;
  entryDen: bigint;
  entrySlot: number;
  peakNum: bigint;
  peakDen: bigint;
}

/** True when price a/b is at least bps above price c/d. */
function upBy(aNum: bigint, aDen: bigint, cNum: bigint, cDen: bigint, bps: number): boolean {
  return aNum * cDen * 10_000n >= cNum * aDen * BigInt(10_000 + bps);
}

/** True when price a/b is at least bps below price c/d. */
function downBy(aNum: bigint, aDen: bigint, cNum: bigint, cDen: bigint, bps: number): boolean {
  return aNum * cDen * 10_000n <= cNum * aDen * BigInt(10_000 - bps);
}

/** True when price a/b is above price c/d. */
function above(aNum: bigint, aDen: bigint, cNum: bigint, cDen: bigint): boolean {
  return aNum * cDen > cNum * aDen;
}

export function decide(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const coins = (decide as unknown as { coins?: Map<string, Coin> }).coins ??
    ((decide as unknown as { coins: Map<string, Coin> }).coins = new Map<string, Coin>());
  const caps = state.hello.caps;
  const tx = state.txFeeLamports();
  let free = state.freeCashLamports();
  let openSlots = caps.max_open_positions - state.committedPositionCount();

  // 1. Track every coin this batch touches.
  for (const e of batch.events) {
    const curve = state.curves.get(e.mint);
    if (curve === undefined) continue;
    if (e.event === 'CreateEvent') {
      if (!coins.has(e.mint)) {
        coins.set(e.mint, {
          mint: e.mint,
          createdSlot: e.slot,
          createNum: curve.virtual_quote_reserves,
          createDen: curve.virtual_token_reserves,
          buys: 0,
          sells: 0,
          decided: false,
          entryNum: 0n,
          entryDen: 1n,
          entrySlot: 0,
          peakNum: 0n,
          peakDen: 1n,
        });
      }
    } else if (e.event === 'TradeEvent') {
      const coin = coins.get(e.mint);
      if (coin === undefined) continue;
      if (e.is_buy) coin.buys += 1;
      else coin.sells += 1;
      // A held coin's peak follows its live price.
      if (state.positions.has(e.mint) && curve.virtual_token_reserves > 0n) {
        if (above(curve.virtual_quote_reserves, curve.virtual_token_reserves, coin.peakNum, coin.peakDen)) {
          coin.peakNum = curve.virtual_quote_reserves;
          coin.peakDen = curve.virtual_token_reserves;
        }
      }
    } else if (e.event === 'CompleteEvent') {
      coins.delete(e.mint);
    }
  }

  // 2. Exits first: every held position is re-checked against TP / SL / trail / max hold.
  for (const [mint, holding] of state.positions) {
    const coin = coins.get(mint);
    const curve = state.curves.get(mint);
    if (coin === undefined || curve === undefined || curve.complete) continue;
    if (curve.virtual_token_reserves <= 0n || coin.entryDen <= 0n) continue;
    const qNum = curve.virtual_quote_reserves;
    const qDen = curve.virtual_token_reserves;
    const heldTooLong = batch.slot - coin.entrySlot >= MAX_HOLD_SLOTS;
    const takeProfit = upBy(qNum, qDen, coin.entryNum, coin.entryDen, TP_BPS);
    const stopLoss = downBy(qNum, qDen, coin.entryNum, coin.entryDen, SL_BPS);
    const trailed =
      upBy(coin.peakNum, coin.peakDen, coin.entryNum, coin.entryDen, TRAIL_ARM_BPS) &&
      downBy(qNum, qDen, coin.peakNum, coin.peakDen, TRAIL_DROP_BPS);
    if (takeProfit || stopLoss || trailed || heldTooLong) {
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      };
      orders.push(sell);
      coins.delete(mint);
    }
  }

  // 3. Entries: young coins with early buying pressure and a rising price.
  if (openSlots > 0) {
    const pendingBuys = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuys.add(p.order.mint);
    }
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch || openSlots <= 0) break;
      const coin = coins.get(e.mint);
      const curve = state.curves.get(e.mint);
      if (coin === undefined || curve === undefined || curve.complete) continue;
      if (coin.decided || state.positions.has(e.mint) || pendingBuys.has(e.mint)) continue;
      if (batch.slot - coin.createdSlot > ENTRY_WINDOW_SLOTS) {
        coin.decided = true;
        continue;
      }
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_CAP_LAMPORTS) continue;
      if (coin.buys < ENTRY_MIN_BUYS || coin.buys <= coin.sells) continue;
      if (curve.virtual_token_reserves <= 0n) continue;
      if (!upBy(curve.virtual_quote_reserves, curve.virtual_token_reserves, coin.createNum, coin.createDen, ENTRY_RISE_BPS)) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      const buy: BuyInput = {
        side: 'buy',
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      };
      orders.push(buy);
      coin.decided = true;
      coin.entryNum = curve.virtual_quote_reserves;
      coin.entryDen = curve.virtual_token_reserves;
      coin.entrySlot = batch.slot;
      coin.peakNum = curve.virtual_quote_reserves;
      coin.peakDen = curve.virtual_token_reserves;
      free -= amount + tx;
      openSlots -= 1;
      pendingBuys.add(e.mint);
    }
  }

  return orders;
}
