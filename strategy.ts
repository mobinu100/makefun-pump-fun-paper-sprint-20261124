// Pump.fun Paper Sprint bot — 6-hour window, tiny-stake early momentum, fast exits.
//
// Idea: on a 6h window most curves die fast, so survive first and let a few
// runners pay. One small buy per coin (0.03 SOL), only into coins that ran up
// hard (>= 80% from creation) and then pulled back >= 30% from their high
// while buyers step back in (latest trade a buy, >= 3 of the last 6 buys).
// Then exit fast: take profit at +60%, cut at -12%, trail winners, never
// hold past 5400 slots.
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

const STAKE_LAMPORTS = 30_000_000n; // 0.03 SOL per coin: clears the 0.01 SOL round-trip bar with room.
const MIN_CAP_LAMPORTS = 10_000_000n; // 0.01 SOL: never buy below the guardrail size.
const ENTRY_WINDOW_SLOTS = 7200; // a dip can come at any age; dead coins are filtered by the tape.
const ENTRY_MIN_BUYS = 6; // need a six-trade tape to judge buyers stepping back in...
const ENTRY_RISE_BPS = 8000; // ...after the coin ran up >= 80% from its create price...
const TP_BPS = 6000; // take profit +60%.
const SL_BPS = 1200; // stop loss -12%.
const TRAIL_ARM_BPS = 2500; // trailing stop arms at +25%...
const TRAIL_DROP_BPS = 1200; // ...and sells on a 12% pullback from the peak.
const MAX_HOLD_SLOTS = 5400; // never hold longer than this; the window is only 6h.
const BUY_SLIPPAGE_BPS = 1000;
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
  highNum: bigint;
  highDen: bigint;
  tape: boolean[];
  lastTradeSlot: number;
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
          highNum: curve.virtual_quote_reserves,
          highDen: curve.virtual_token_reserves,
          tape: [],
          lastTradeSlot: e.slot,
        });
      }
    } else if (e.event === 'TradeEvent') {
      const coin = coins.get(e.mint);
      if (coin === undefined) continue;
      if (e.is_buy) coin.buys += 1;
      else coin.sells += 1;
      coin.lastTradeSlot = e.slot;
      coin.tape.push(e.is_buy);
      if (coin.tape.length > 6) coin.tape.shift();
      if (curve.virtual_token_reserves > 0n &&
          above(curve.virtual_quote_reserves, curve.virtual_token_reserves, coin.highNum, coin.highDen)) {
        coin.highNum = curve.virtual_quote_reserves;
        coin.highDen = curve.virtual_token_reserves;
      }
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
      if (coin.tape.length < ENTRY_MIN_BUYS) continue;
      if (coin.tape[coin.tape.length - 1] !== true) continue; // latest trade must be a buy
      let tapeBuys = 0;
      for (const t of coin.tape) if (t) tapeBuys += 1;
      if (tapeBuys < 3) continue; // buyers stepping back in, not a dead tape
      if (batch.slot - coin.lastTradeSlot > 120) continue; // stale coin: no recent trade
      if (curve.virtual_token_reserves <= 0n) continue;
      // Ran up hard from creation, then pulled back hard from its high: buy the dip.
      if (!upBy(coin.highNum, coin.highDen, coin.createNum, coin.createDen, ENTRY_RISE_BPS)) continue;
      if (!downBy(curve.virtual_quote_reserves, curve.virtual_token_reserves, coin.highNum, coin.highDen, 3000)) continue;
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
