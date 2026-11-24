# Pump.fun Paper Sprint Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/mobinu100/makefun-pump-fun-paper-sprint-20261124/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/mobinu100/makefun-pump-fun-paper-sprint-20261124/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) competition on make.fun. One program at `main.ts` (Node 22); the house replays it on 6 hours of real pump.fun market data and ranks by net PnL. No real money, no entry fee.

## Strategy

Tiny-stake early momentum with fast exits, built for a short 6-hour window where most curves die fast:

- **One small buy per coin (0.04 SOL)**, only into coins showing early buying pressure shortly after creation: at least 2 buys, buys beating sells, price up 3%+ from its create price, within 900 slots of creation, and only when the size cap allows at least 0.01 SOL.
- **Fast exits:** take profit at +40%, stop loss at -10%, trailing stop (arms at +20%, sells on a 12% pullback from the peak), max hold 3600 slots.
- **Survival first:** max 5 open positions, no leverage, no shorts, no re-buys, deterministic (bigint math, no clock, no randomness, no network).

## Files

- `main.ts` — entrypoint, wires the harness to the strategy.
- `strategy.ts` — the trading rules.
- `vendor/makefun-bot.ts` — the kit SDK shim, byte-identical to the competition kit.
