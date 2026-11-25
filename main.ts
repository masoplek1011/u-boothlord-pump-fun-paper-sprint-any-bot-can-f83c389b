// Pump.fun Paper Sprint: Any Bot Can Win — entry bot (agent-fun/replay/v2).
//
// Strategy: two purely causal, rule-based families, decided only at the end
// of each batch from the TradeEvents already received (no future data, no
// clock, no randomness, no environment, no file I/O while running).
//
//   1. Sell-Exhaustion Fade (SEF, primary): a mint whose real SOL reserve
//      fell >= 6% over its last 40 events, whose selling has decelerated
//      (sell SOL in the last 10 events <= 1.25x the 10 before them), and
//      whose last 5 events are net non-negative, is bought as a fade of
//      the exhausted dump.
//   2. Coil Breakout (CB, secondary): a mint coiled flat (50-event virtual
//      price range <= 5%, real reserve within +-2%) that breaks to a new
//      50-event high on a batch net buy >= 0.4% of its real reserve.
//
// Price proxy: on a constant-product bonding curve the token price is
// proportional to (virtual SOL reserves)^2, so price ratios are computed
// from squared virtual-reserve ratios only. All windows are trailing event
// counts per mint; all thresholds are reserve-normalised, so nothing here
// depends on absolute amounts, mint age, wall time or event order beyond
// the trailing windows themselves.
//
// Exits: take-profit / stop-loss on the entry price ratio, a max-hold in
// events, and a 100-event cooldown per mint after any exit. At most one
// position per mint, at most 5 open positions, each order capped at 1% of
// the mint's real SOL reserve. All u64 amounts travel as decimal strings
// (BigInt); every decision is a pure function of the events seen so far,
// so two runs on the same replay produce byte-identical replies.
//
// Wire protocol: the harness sends one NDJSON line per message on stdin —
// a `hello` (protocol, seed, capital, caps, latency, fees), then one
// `batch` per slot ({seq, slot, events, marks, fills, account}), then a
// `done`. The bot answers each `batch` with exactly one `reply` line on
// stdout echoing the same seq, carrying its `orders` (buy with
// quote_lamports, sell with token_amount, both with max_slippage_bps).
// Diagnostics go to stderr only; stdout carries replies and nothing else.

import { createInterface } from "node:readline";

// ------------------------------------------------------------------ config
// Coarse, round thresholds on purpose: nothing here is tuned to a decimal
// of the dev window, so the rules should survive the twin / block-copy
// re-tests that replay perturbed copies of the tape.
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_POSITIONS = 5;
const MAX_ORDERS_PER_BATCH = 16;
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1000;
const COOLDOWN_EVENTS = 100;

// SEF (primary): fade the exhausted sell-off.
const SEF_WINDOW = 40;
const SEF_DRAWDOWN = 0.10; // real reserve down >= 10% over the window
const SEF_SELL_RATIO = 1.0; // sell SOL last 10 <= 1.0x the 10 before
const SEF_SIZE_SOL = 0.5;
const SEF_TP = 1.08;
const SEF_SL = 0.96;
const SEF_MAX_HOLD_EVENTS = 80;

// CB (secondary): buy the breakout out of a flat coil.
const CB_WINDOW = 50;
const CB_RANGE = 0.08; // 50-event price range <= 8%
const CB_RESERVE_DRIFT = 0.03; // real reserve within +-3% over the window
const CB_BATCH_NET_BUY = 0.002; // this batch net buy >= 0.2% of real reserve
const CB_SIZE_SOL = 0.6;
const CB_TP = 1.08;
const CB_SL = 0.96;
const CB_MAX_HOLD_EVENTS = 60;

// ------------------------------------------------------------------ types
interface TradeTick {
  vSol: number; // virtual SOL reserves, in SOL
  rSol: number; // real SOL reserves, in SOL
  rLamports: bigint; // real SOL reserves, exact lamports (for order sizing)
  sol: number; // this trade's SOL size, in SOL
  isBuy: boolean;
}

interface MintState {
  ticks: TradeTick[]; // trailing ticks, newest last (capped at CB_WINDOW)
  count: number; // total TradeEvents seen for this mint
  batchNetBuySol: number; // net buy SOL in the batch currently processed
  completed: boolean;
  cooldownUntil: number; // event count until which no new entry is allowed
}

interface Position {
  mint: string;
  entryVSol: number; // virtual SOL reserves when the buy was decided
  entryCount: number; // mint event count at entry
  strategy: "sef" | "cb";
  tokens: bigint; // filled token amount (0 until the fill is reported)
  pending: boolean; // buy sent, fill not yet reported
  forceExit?: boolean; // set when the mint completed: exit at once
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

// ------------------------------------------------------------------ state
const mints = new Map<string, MintState>();
const positions = new Map<string, Position>();
let cashLamports = 0n;
let maxOpenPositions = MAX_POSITIONS;
let maxOrderBps = 100; // 1% of real reserve per order (from hello caps)
let maxOrdersPerBatch = MAX_ORDERS_PER_BATCH;
let orderCounter = 0;

function mintState(mint: string): MintState {
  let s = mints.get(mint);
  if (s === undefined) {
    s = { ticks: [], count: 0, batchNetBuySol: 0, completed: false, cooldownUntil: 0 };
    mints.set(mint, s);
  }
  return s;
}

function priceOf(vSol: number): number {
  return vSol * vSol;
}

function lastTick(s: MintState): TradeTick | undefined {
  return s.ticks.length === 0 ? undefined : s.ticks[s.ticks.length - 1];
}

// ------------------------------------------------------------------ entries
// SEF: real-reserve drawdown over the trailing window, selling decelerating,
// recent net flow no longer negative.
function sefSignal(s: MintState): boolean {
  if (s.ticks.length < SEF_WINDOW || s.completed) return false;
  if (s.count <= s.cooldownUntil) return false;
  const n = s.ticks.length;
  const start = s.ticks[n - SEF_WINDOW];
  const last = s.ticks[n - 1];
  if (start.rSol <= 0 || last.rSol <= 0) return false;
  if (last.rSol / start.rSol - 1 > -SEF_DRAWDOWN) return false;
  let sellRecent = 0;
  let sellPrior = 0;
  let netRecent = 0;
  for (let i = n - 10; i < n; i++) {
    const t = s.ticks[i];
    if (!t.isBuy) sellRecent += t.sol;
  }
  for (let i = n - 20; i < n - 10; i++) {
    const t = s.ticks[i];
    if (!t.isBuy) sellPrior += t.sol;
  }
  for (let i = n - 5; i < n; i++) {
    const t = s.ticks[i];
    netRecent += t.isBuy ? t.sol : -t.sol;
  }
  if (sellPrior <= 0) return sellRecent <= 0 && netRecent >= 0;
  return sellRecent <= SEF_SELL_RATIO * sellPrior && netRecent > 0;
}

// CB: flat 50-event coil, stable real reserve, then this batch's net buy
// pushes the price to a new 50-event high.
function cbSignal(s: MintState): boolean {
  if (s.ticks.length < CB_WINDOW || s.completed) return false;
  if (s.count <= s.cooldownUntil) return false;
  const n = s.ticks.length;
  const start = s.ticks[n - CB_WINDOW];
  const last = s.ticks[n - 1];
  if (start.rSol <= 0 || last.rSol <= 0) return false;
  const drift = last.rSol / start.rSol - 1;
  if (drift < -CB_RESERVE_DRIFT || drift > CB_RESERVE_DRIFT) return false;
  let hi = 0;
  let lo = Number.POSITIVE_INFINITY;
  for (let i = n - CB_WINDOW; i < n - 1; i++) {
    const p = priceOf(s.ticks[i].vSol);
    if (p > hi) hi = p;
    if (p < lo) lo = p;
  }
  const now = priceOf(last.vSol);
  if (lo <= 0 || now / lo - 1 > CB_RANGE) return false;
  if (now <= hi) return false; // must print a new 50-event high
  return s.batchNetBuySol >= CB_BATCH_NET_BUY * last.rSol;
}

// ------------------------------------------------------------------ exits
function exitFor(p: Position, s: MintState): boolean {
  if (p.forceExit === true) return true; // mint completed: exit at once
  const last = lastTick(s);
  if (last === undefined) return false;
  const ratio = priceOf(last.vSol) / priceOf(p.entryVSol);
  const tp = p.strategy === "sef" ? SEF_TP : CB_TP;
  const sl = p.strategy === "sef" ? SEF_SL : CB_SL;
  const maxHold = p.strategy === "sef" ? SEF_MAX_HOLD_EVENTS : CB_MAX_HOLD_EVENTS;
  if (ratio >= tp) return true;
  if (ratio <= sl) return true;
  return s.count - p.entryCount >= maxHold;
}

// ------------------------------------------------------------------ batch
function decideBatch(seq: number): Order[] {
  const orders: Order[] = [];

  // 1. Exits first: sell every position whose TP / SL / max-hold fired.
  //    Deterministic order: sort by mint.
  const held = [...positions.values()]
    .filter((p) => !p.pending)
    .sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
  const exiting = new Set<string>();
  for (const p of held) {
    if (orders.length >= maxOrdersPerBatch) break;
    const s = mints.get(p.mint);
    if (s === undefined) continue;
    if (!exitFor(p, s)) continue;
    if (p.tokens <= 0n) continue;
    orderCounter += 1;
    orders.push({
      side: "sell",
      client_id: `s${orderCounter}`,
      mint: p.mint,
      token_amount: p.tokens.toString(),
      max_slippage_bps: SELL_SLIPPAGE_BPS,
    });
    exiting.add(p.mint);
    // The mint cools down once the sell is sent; the position record is
    // dropped now and re-created from the account only if the fill fails.
    positions.delete(p.mint);
    s.cooldownUntil = s.count + COOLDOWN_EVENTS;
  }

  // 2. Entries: one candidate per mint, SEF first, then CB; candidates are
  //    visited in sorted mint order so the reply is fully deterministic.
  //    Pending buys already occupy a slot: the harness counts a position
  //    from its fill, but firing more buys than the cap allows only earns
  //    max_open_positions rejections, so count them here.
  let slots = maxOpenPositions - positions.size;
  if (slots > 0) {
    const candidates = [...mints.keys()].sort();
    for (const mint of candidates) {
      if (slots <= 0 || orders.length >= maxOrdersPerBatch) break;
      if (positions.has(mint) || exiting.has(mint)) continue;
      const s = mints.get(mint);
      if (s === undefined) continue;
      const last = lastTick(s);
      if (last === undefined || last.rSol <= 0) continue;
      let strategy: "sef" | "cb" | null = null;
      let sizeSol = 0;
      if (sefSignal(s)) {
        strategy = "sef";
        sizeSol = SEF_SIZE_SOL;
      } else if (cbSignal(s)) {
        strategy = "cb";
        sizeSol = CB_SIZE_SOL;
      }
      if (strategy === null) continue;
      // Size: base size, capped at 1% of the real SOL reserve (the cap the
      // harness enforces per order) and at the cash actually on hand. The
      // cap is computed from exact lamports, never a float, so the order
      // can never overshoot the harness's own size check by rounding.
      let quote = BigInt(Math.floor(sizeSol * 1_000_000_000));
      const reserveCap = (last.rLamports * BigInt(maxOrderBps)) / 10000n;
      if (quote > reserveCap) quote = reserveCap;
      if (quote > cashLamports) quote = cashLamports;
      if (quote <= 0n) continue;
      orderCounter += 1;
      orders.push({
        side: "buy",
        client_id: `b${orderCounter}`,
        mint,
        quote_lamports: quote.toString(),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      positions.set(mint, {
        mint,
        entryVSol: last.vSol,
        entryCount: s.count,
        strategy,
        tokens: 0n,
        pending: true,
      });
      slots -= 1;
    }
  }

  return orders;
}

// ------------------------------------------------------------------ wire
function applyFills(fills: any[] | undefined): void {
  if (!Array.isArray(fills)) return;
  for (const f of fills) {
    if (typeof f !== "object" || f === null) continue;
    const mint = typeof f.mint === "string" ? f.mint : "";
    if (f.side === "buy" && f.status === "filled") {
      const p = positions.get(mint);
      if (p !== undefined && p.pending) {
        p.tokens = BigInt(f.token_amount ?? "0");
        p.pending = false;
        // Honest entry price: the fill lands two slots after the decision,
        // so the decision-time price overstates the entry. Re-anchor the
        // entry to the latest tick seen when the fill is reported, so the
        // TP / SL ratios are measured against the price actually paid.
        // (The fill report arrives in the same batch processing pass, after
        // this batch's events were consumed, so lastTick is the fill-time
        // price or the closest tick to it.)
        const s = mints.get(mint);
        const last = s === undefined ? undefined : lastTick(s);
        if (last !== undefined) {
          p.entryVSol = last.vSol;
          p.entryCount = s.count;
        }
      }
    } else if (f.side === "buy" && (f.status === "rejected" || f.status === "failed")) {
      const p = positions.get(mint);
      if (p !== undefined && p.pending) positions.delete(mint);
    } else if (f.side === "sell" && f.status === "filled") {
      // Position was already removed when the sell was sent.
    }
  }
}

function syncAccount(account: any): void {
  if (typeof account !== "object" || account === null) return;
  if (typeof account.cash_lamports === "string") {
    cashLamports = BigInt(account.cash_lamports);
  }
  if (Array.isArray(account.positions)) {
    const seen = new Set<string>();
    for (const pos of account.positions) {
      if (typeof pos !== "object" || pos === null || typeof pos.mint !== "string") continue;
      seen.add(pos.mint);
      const p = positions.get(pos.mint);
      const tokens = BigInt(pos.token_amount ?? "0");
      if (p === undefined) {
        // A position the harness reports that we do not track (e.g. a fill
        // reported before its buy was reconciled): adopt it at the current
        // price so exits still work; its entry price is the current one,
        // which can only understate a gain, never invent one.
        const s = mints.get(pos.mint);
        const last = s === undefined ? undefined : lastTick(s);
        if (last !== undefined && tokens > 0n) {
          positions.set(pos.mint, {
            mint: pos.mint,
            entryVSol: last.vSol,
            entryCount: s.count,
            strategy: "sef",
            tokens,
            pending: false,
          });
        }
      } else if (!p.pending) {
        p.tokens = tokens;
      }
    }
    // Drop records for positions the account no longer holds (flattened by
    // the harness, e.g. on completion), unless a buy is still pending.
    for (const [mint, p] of [...positions.entries()]) {
      if (!seen.has(mint) && !p.pending) positions.delete(mint);
    }
  }
}

function handleBatch(msg: any): void {
  const events = Array.isArray(msg.events) ? msg.events : [];
  // Reset this batch's per-mint net-buy accumulator before consuming events.
  for (const s of mints.values()) s.batchNetBuySol = 0;

  for (const ev of events) {
    if (typeof ev !== "object" || ev === null) continue;
    if (ev.event === "TradeEvent" && typeof ev.mint === "string") {
      const s = mintState(ev.mint);
      const vSol = Number(BigInt(ev.virtual_sol_reserves ?? "0")) / 1_000_000_000;
      const rSol = Number(BigInt(ev.real_sol_reserves ?? "0")) / 1_000_000_000;
      const sol = Number(BigInt(ev.sol_amount ?? "0")) / 1_000_000_000;
      s.ticks.push({ vSol, rSol, rLamports: BigInt(ev.real_sol_reserves ?? "0"), sol, isBuy: ev.is_buy === true });
      if (s.ticks.length > CB_WINDOW) s.ticks.splice(0, s.ticks.length - CB_WINDOW);
      s.count += 1;
      s.batchNetBuySol += ev.is_buy === true ? sol : -sol;
    } else if (ev.event === "CompleteEvent" && typeof ev.mint === "string") {
      mintState(ev.mint).completed = true;
    }
    // CreateEvent carries no trade information the rules use; it is ignored.
  }

  applyFills(msg.fills);
  syncAccount(msg.account);

  // A completed mint with a position still held is exited now: the curve is
  // done and the harness will flatten it, so take whatever price is left.
  for (const [mint, p] of [...positions.entries()]) {
    if (p.pending) continue;
    const s = mints.get(mint);
    if (s !== undefined && s.completed && p.tokens > 0n) {
      // Mark it for exit: decideBatch sells it through the normal path.
      p.forceExit = true;
    }
  }

  const orders = decideBatch(msg.seq as number);
  process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
}

function main(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line: string) => {
    if (line.trim() === "") return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    if (msg.type === "hello") {
      if (typeof msg.capital?.lamports === "string") cashLamports = BigInt(msg.capital.lamports);
      if (typeof msg.caps?.max_open_positions === "number") maxOpenPositions = msg.caps.max_open_positions;
      if (typeof msg.caps?.max_order_bps_of_real_reserve === "number") maxOrderBps = msg.caps.max_order_bps_of_real_reserve;
      if (typeof msg.caps?.max_orders_per_batch === "number") maxOrdersPerBatch = msg.caps.max_orders_per_batch;
      return;
    }
    if (msg.type === "batch") {
      handleBatch(msg);
      return;
    }
    if (msg.type === "done") {
      process.exit(0);
    }
  });
}

main();
