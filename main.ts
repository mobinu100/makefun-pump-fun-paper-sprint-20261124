// Pump.fun Paper Sprint bot: one program at main.ts (Node 22), paper-trades
// pump.fun on the house 6-hour replay. See strategy.ts for the rules.
import { runBot } from './vendor/makefun-bot.ts';
import { decide } from './strategy.ts';

await runBot({
  onBatch(state, batch) {
    return decide(state, batch);
  },
});
