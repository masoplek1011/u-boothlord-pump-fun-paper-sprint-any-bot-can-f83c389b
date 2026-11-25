# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/masoplek1011/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/masoplek1011/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A deterministic, purely rule-based paper-trading bot for make.fun's
"Pump.fun Paper Sprint: Any Bot Can Win" bounty. It replays pump.fun
bonding-curve tape through the `agent-fun/replay/v2` protocol and trades
two causal strategies — no future data, no clock, no randomness, no network.

## Strategy

- **Sell-Exhaustion Fade (primary).** Buy a mint whose real SOL reserve fell
  at least 10% over its last 40 events, whose selling has decelerated (sell
  SOL in the last 10 events at most 1.25x the 10 before them), and whose
  last 5 events are net non-negative. Size 0.50 SOL, take-profit +8%,
  stop-loss −4%, max hold 80 events.
- **Coil Breakout (secondary).** Buy a mint coiled flat (50-event virtual
  price range at most 5%, real reserve within ±2%) that prints a new
  50-event high on a batch net buy of at least 0.4% of its real reserve.
  Size 0.60 SOL, take-profit +8%, stop-loss −4%, max hold 60 events.

Price is proxied by (virtual SOL reserves)², the constant-product curve
price. At most 5 open positions, one per mint, each order capped at 1% of
the mint's real SOL reserve, with a 100-event cooldown per mint after any
exit. All decisions use only events already received in the replay.

## Run it

```sh
node main.ts
```

The bot reads NDJSON `hello` / `batch` / `done` messages on stdin and
writes exactly one `reply` per `batch` on stdout. Node 22, standard library
only, no dependencies, no file I/O while running.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
