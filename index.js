// index.js
// Mohan's Combined Trading Bridge
// Flow: TradingView Pine alert -> webhook -> budget-based trade plan -> Telegram message
//       -> manual tap-to-approve link (default) OR auto-execute (if AUTO_MODE=true)
//       -> Dhan Super Order (entry + trailing target + trailing SL)
//
// SAFETY DEFAULTS: DRY_RUN=true, AUTO_MODE=false
// Change only after you've watched signals for a while and trust them.

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8767819996:AAGeDsP-aOlLra_2yk_ny7fGZEcWWO5YGQU";
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || "642914274";

const DHAN_ACCESS_TOKEN  = process.env.DHAN_ACCESS_TOKEN  || "PASTE_YOUR_DHAN_TOKEN";
const DHAN_CLIENT_ID     = process.env.DHAN_CLIENT_ID     || "PASTE_YOUR_CLIENT_ID";

const DRY_RUN   = process.env.DRY_RUN !== "false";   // default TRUE - no real orders
// AUTO_MODE is now a runtime toggle (not just env var) - flip it anytime via /mode/on or /mode/off
let AUTO_MODE = process.env.AUTO_MODE === "true";  // default FALSE - manual approval required

const TRADE_BUDGET = parseFloat(process.env.TRADE_BUDGET || "5000"); // per-trade budget in Rs
const MIN_CONFIDENCE = parseFloat(process.env.MIN_CONFIDENCE || "70"); // matches Pine Script threshold

const NIFTY_LOT_SIZE = 75;
const BANKNIFTY_LOT_SIZE = 30;

// Pending trades waiting for manual approval, keyed by a short token
const pendingTrades = {};

// ============================================================
// TELEGRAM SEND
// ============================================================
async function sendTelegram(message, extra = {}) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML", ...extra });
  } catch (err) {
    console.error("Telegram send failed:", err.response?.data || err.message);
  }
}

// ============================================================
// BUDGET -> QUANTITY
// ============================================================
function calculateQuantity(budget, premium, lotSize) {
  if (!premium || premium <= 0) return { quantity: 0, lots: 0, estimatedCost: 0 };
  const maxUnits = Math.floor(budget / premium);
  const lots = Math.floor(maxUnits / lotSize);
  const quantity = lots * lotSize;
  return { quantity, lots, estimatedCost: quantity * premium };
}

// ============================================================
// TRADE PLAN (R:R >= 1:1.5, matches your existing rule)
// ============================================================
function buildTradePlan(premium, targetRRMultiplier = 1.5, slPct = 0.20, trailJumpPct = 0.05) {
  const slPrice = +(premium * (1 - slPct)).toFixed(2);
  const riskPerUnit = premium - slPrice;
  const targetPrice = +(premium + riskPerUnit * targetRRMultiplier).toFixed(2);
  const trailingJump = +(premium * trailJumpPct).toFixed(2);
  return { entryPrice: premium, targetPrice, slPrice, trailingJump };
}

// ============================================================
// DHAN SUPER ORDER
// ============================================================
async function placeSuperOrder({ securityId, exchangeSegment, quantity, entryPrice, targetPrice, slPrice, trailingJump }) {
  const payload = {
    dhanClientId: DHAN_CLIENT_ID,
    correlationId: "bridge_" + Date.now(),
    transactionType: "BUY",
    exchangeSegment,
    productType: "INTRADAY",
    orderType: "LIMIT",
    securityId,
    quantity,
    price: entryPrice,
    targetPrice,
    stopLossPrice: slPrice,
    trailingJump
  };

  if (DRY_RUN) {
    console.log("DRY_RUN active - order not sent:", payload);
    return { dryRun: true, payload };
  }

  try {
    const resp = await axios.post("https://api.dhan.co/v2/super/orders", payload, {
      headers: {
        "access-token": DHAN_ACCESS_TOKEN,
        "client-id": DHAN_CLIENT_ID,
        "Content-Type": "application/json"
      }
    });
    return resp.data;
  } catch (err) {
    console.error("Super Order failed:", err.response?.data || err.message);
    return { error: err.response?.data || err.message };
  }
}

// ============================================================
// PREMIUM FETCH - plug your existing ATM strike resolver + LTP fetch here
// ============================================================
async function getOptionPremiumAndSecurityId(symbol, side) {
  // TODO: replace with your existing option-chain resolver from your bridge repo.
  // Must return { securityId, exchangeSegment, premium }
  console.log(`[placeholder] resolving ATM ${side} strike for ${symbol}`);
  return { securityId: "00000", exchangeSegment: "NSE_FNO", premium: 100 };
}

// ============================================================
// CORE: process a signal (from webhook or manual test)
// ============================================================
async function processSignal(signal) {
  const { symbol, side, confidence } = signal; // side: "CE" or "PE"

  if (confidence !== undefined && confidence < MIN_CONFIDENCE) {
    console.log(`Confidence ${confidence}% below threshold ${MIN_CONFIDENCE}% - skipping`);
    return { skipped: true, reason: "low confidence" };
  }

  const { securityId, exchangeSegment, premium } = await getOptionPremiumAndSecurityId(symbol, side);
  const lotSize = symbol === "BANKNIFTY" ? BANKNIFTY_LOT_SIZE : NIFTY_LOT_SIZE;
  const { quantity, lots, estimatedCost } = calculateQuantity(TRADE_BUDGET, premium, lotSize);

  if (quantity === 0) {
    await sendTelegram(`⚠️ Signal came (${symbol} ${side}) but budget ₹${TRADE_BUDGET} is too small for 1 lot at premium ₹${premium}.`);
    return { skipped: true, reason: "budget too small" };
  }

  const plan = buildTradePlan(premium);
  const tradeDetails = { symbol, side, securityId, exchangeSegment, quantity, lots, estimatedCost, ...plan };

  if (AUTO_MODE) {
    const result = await placeSuperOrder(tradeDetails);
    await sendTelegram(
      `🤖 <b>AUTO-EXECUTED</b>\n${symbol} ${side} | Lots: ${lots} | Qty: ${quantity}\n` +
      `Entry: ${plan.entryPrice} | Target: ${plan.targetPrice} | SL: ${plan.slPrice}\n` +
      `Cost: ~₹${estimatedCost}\n${DRY_RUN ? "(DRY RUN - no real order placed)" : "LIVE ORDER PLACED"}`
    );
    return { executed: true, dryRun: DRY_RUN, result };
  } else {
    // Manual mode: store pending trade, send approval link
    const token = "t_" + Date.now();
    pendingTrades[token] = tradeDetails;
    const baseUrl = process.env.PUBLIC_URL || "http://localhost:3000";
    await sendTelegram(
      `📋 <b>Trade Plan Ready</b>\n${symbol} ${side} | Lots: ${lots} | Qty: ${quantity}\n` +
      `Entry: ${plan.entryPrice} | Target: ${plan.targetPrice} | SL: ${plan.slPrice}\n` +
      `Estimated Cost: ~₹${estimatedCost}\n\n` +
      `వీలున్నప్పుడు execute చేయడానికి:\n${baseUrl}/approve/${token}\n\n` +
      `(ఈ link 30 నిమిషాలు valid, market conditions మారితే expire చేసుకో)`
    );
    // auto-expire after 30 min
    setTimeout(() => delete pendingTrades[token], 30 * 60 * 1000);
    return { pending: true, token };
  }
}

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req, res) => res.send(
  "Mohan Trading Bridge running.\n" +
  "Mode: " + (AUTO_MODE ? "AUTO" : "MANUAL") + " | DRY_RUN: " + DRY_RUN + "\n\n" +
  "Toggle: /mode/on (auto) | /mode/off (manual)"
));

// ============================================================
// RUNTIME TOGGLE - tap these URLs anytime, no redeploy needed
// ============================================================
app.get('/mode/on', async (req, res) => {
  AUTO_MODE = true;
  await sendTelegram("🤖 Mode switched to AUTO — signals ఇక direct గా execute అవుతాయి (DRY_RUN=" + DRY_RUN + ").");
  res.send("AUTO mode ON. Signals will now execute automatically" + (DRY_RUN ? " (dry run only)." : "."));
});

app.get('/mode/off', async (req, res) => {
  AUTO_MODE = false;
  await sendTelegram("✋ Mode switched to MANUAL — signals ఇక Telegram కి plan పంపుతాయి, నువ్వు approve చేయాలి.");
  res.send("MANUAL mode ON. You'll get a Telegram plan with an approve link for each signal.");
});

app.get('/mode/status', (req, res) => {
  res.json({ autoMode: AUTO_MODE, dryRun: DRY_RUN, budget: TRADE_BUDGET, minConfidence: MIN_CONFIDENCE });
});

// TradingView Pine Script webhook lands here
app.post('/webhook', async (req, res) => {
  console.log("Webhook received:", req.body);
  const result = await processSignal(req.body);
  res.json(result);
});

// Manual test trigger (no need to wait for TradingView)
app.get('/test-signal', async (req, res) => {
  const symbol = req.query.symbol || "NIFTY";
  const side = req.query.side || "CE";
  const confidence = parseFloat(req.query.confidence || "75");
  const result = await processSignal({ symbol, side, confidence });
  res.json(result);
});

// Tap this link from Telegram to actually execute a pending manual trade
app.get('/approve/:token', async (req, res) => {
  const trade = pendingTrades[req.params.token];
  if (!trade) {
    return res.send("Link expired or already used. Signal ఇక valid కాదు, కొత్త signal కోసం wait చేయు.");
  }
  delete pendingTrades[req.params.token];
  const result = await placeSuperOrder(trade);
  await sendTelegram(
    `✅ <b>MANUALLY EXECUTED</b>\n${trade.symbol} ${trade.side} | Qty: ${trade.quantity}\n` +
    `${DRY_RUN ? "(DRY RUN - no real order placed)" : "LIVE ORDER PLACED"}`
  );
  res.send(`Order ${DRY_RUN ? "(dry run) processed" : "placed"}. Telegram లో confirm చూడు.`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Trading bridge running on port ${PORT}`);
  console.log(`Mode: ${AUTO_MODE ? "AUTO" : "MANUAL (approval required)"} | DRY_RUN: ${DRY_RUN} | Budget: ₹${TRADE_BUDGET}`);
});
