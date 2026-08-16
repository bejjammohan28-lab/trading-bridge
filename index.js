// index.js
// Mohan's Combined Trading Bridge — v2
// Flow: TradingView Pine alert -> webhook -> real ATM strike/premium (Dhan Option Chain)
//       -> budget-based trade plan -> Telegram message
//       -> manual tap-to-approve link (default) OR auto-execute (if AUTO_MODE=true)
//       -> Dhan Super Order (entry + trailing target + trailing SL)
//
// NEW in v2:
//   - Real Dhan Option Chain integration (no more placeholder premium)
//   - Telegram command: send "/budget 15000" to your bot to update budget instantly
//
// SAFETY DEFAULTS: DRY_RUN=true, AUTO_MODE=false

const express = require('express');
const axios = require('axios');
const { authenticator } = require('otplib');

const app = express();
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8767819996:AAGeDsP-aOlLra_2yk_ny7fGZEcWWO5YGQU";
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || "642914274";

// Dhan token expires every 24 hours (Dhan's current policy) - update it daily via Telegram: /token <newtoken>
// OR set up full auto-refresh below using DHAN_PIN + DHAN_TOTP_SECRET (see setupAutoRefresh)
let DHAN_ACCESS_TOKEN  = process.env.DHAN_ACCESS_TOKEN  || "PASTE_YOUR_DHAN_TOKEN";
let DHAN_CLIENT_ID     = process.env.DHAN_CLIENT_ID     || "PASTE_YOUR_CLIENT_ID";

// For fully automatic token refresh (optional). Set these as Railway Variables ONLY -
// never commit them to GitHub. Leave blank to use manual /token mode instead.
const DHAN_PIN          = process.env.DHAN_PIN          || "";  // 6-digit Dhan trading PIN
const DHAN_TOTP_SECRET  = process.env.DHAN_TOTP_SECRET  || "";  // base32 secret from Dhan TOTP setup
const AUTO_REFRESH_TOKEN = !!(DHAN_PIN && DHAN_TOTP_SECRET);

const DRY_RUN   = process.env.DRY_RUN !== "false";
let AUTO_MODE   = process.env.AUTO_MODE === "true";
let TRADE_BUDGET = parseFloat(process.env.TRADE_BUDGET || "5000"); // now mutable at runtime
const MIN_CONFIDENCE = parseFloat(process.env.MIN_CONFIDENCE || "70");

// PUBLIC_URL needed to auto-register the Telegram webhook on startup
const PUBLIC_URL = process.env.PUBLIC_URL || "";

const UNDERLYINGS = {
  NIFTY:      { securityId: 13, strikeStep: 50 },
  BANKNIFTY:  { securityId: 25, strikeStep: 100 }
};
const LOT_SIZES = { NIFTY: 75, BANKNIFTY: 30 };

const pendingTrades = {};

// ============================================================
// AUTO TOKEN REFRESH (using API Key flow: PIN + TOTP)
// ============================================================
async function refreshDhanToken() {
  if (!AUTO_REFRESH_TOKEN) return; // manual /token mode - skip

  try {
    const totpCode = authenticator.generate(DHAN_TOTP_SECRET);
    const url = `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${DHAN_CLIENT_ID}&pin=${DHAN_PIN}&totp=${totpCode}`;
    const resp = await axios.post(url);
    DHAN_ACCESS_TOKEN = resp.data.accessToken;
    console.log("Dhan token auto-refreshed. Expires:", resp.data.expiryTime);
    await sendTelegram(`🔄 Dhan token auto-refreshed. Valid until: ${resp.data.expiryTime}`);
  } catch (err) {
    console.error("Token auto-refresh failed:", err.response?.data || err.message);
    await sendTelegram("⚠️ Dhan token auto-refresh FAILED. Manual /token entry may be needed. Check DHAN_PIN/DHAN_TOTP_SECRET.");
  }
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" });
  } catch (err) {
    console.error("Telegram send failed:", err.response?.data || err.message);
  }
}

async function registerTelegramWebhook() {
  if (!PUBLIC_URL) {
    console.log("PUBLIC_URL not set - skipping Telegram webhook auto-registration. Set it in Railway variables after first deploy, then redeploy.");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;
    await axios.post(url, { url: `${PUBLIC_URL}/telegram-webhook` });
    console.log("Telegram webhook registered at " + PUBLIC_URL + "/telegram-webhook");
  } catch (err) {
    console.error("Telegram webhook registration failed:", err.response?.data || err.message);
  }
}

// ============================================================
// DHAN OPTION CHAIN - real ATM strike + premium resolver
// ============================================================
async function getNearestExpiry(underlyingScrip) {
  const resp = await axios.post(
    "https://api.dhan.co/v2/optionchain/expirylist",
    { UnderlyingScrip: underlyingScrip, UnderlyingSeg: "IDX_I" },
    { headers: dhanHeaders() }
  );
  return resp.data.data[0]; // nearest expiry
}

function dhanHeaders() {
  return {
    "access-token": DHAN_ACCESS_TOKEN,
    "client-id": DHAN_CLIENT_ID,
    "Content-Type": "application/json"
  };
}

async function getATMOption(symbol, side) {
  const under = UNDERLYINGS[symbol];
  if (!under) throw new Error("Unknown symbol: " + symbol);

  const expiry = await getNearestExpiry(under.securityId);

  const resp = await axios.post(
    "https://api.dhan.co/v2/optionchain",
    { UnderlyingScrip: under.securityId, UnderlyingSeg: "IDX_I", Expiry: expiry },
    { headers: dhanHeaders() }
  );

  const data = resp.data.data;
  const spot = data.last_price;

  // Round spot to nearest strike step to find ATM
  const atmStrike = Math.round(spot / under.strikeStep) * under.strikeStep;
  const strikeKey = atmStrike.toFixed(6); // API keys look like "25650.000000"

  const strikeData = data.oc[strikeKey];
  if (!strikeData) {
    // fallback: find closest available strike key
    const keys = Object.keys(data.oc);
    const closest = keys.reduce((a, b) =>
      Math.abs(parseFloat(a) - spot) < Math.abs(parseFloat(b) - spot) ? a : b
    );
    const opt = data.oc[closest][side.toLowerCase()];
    return { securityId: opt.security_id, exchangeSegment: "NSE_FNO", premium: opt.last_price, strike: closest, spot };
  }

  const opt = strikeData[side.toLowerCase()]; // "ce" or "pe"
  return { securityId: opt.security_id, exchangeSegment: "NSE_FNO", premium: opt.last_price, strike: atmStrike, spot };
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
// TRADE PLAN
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
    const resp = await axios.post("https://api.dhan.co/v2/super/orders", payload, { headers: dhanHeaders() });
    return resp.data;
  } catch (err) {
    console.error("Super Order failed:", err.response?.data || err.message);
    return { error: err.response?.data || err.message };
  }
}

// ============================================================
// CORE: process a trading signal
// ============================================================
async function processSignal(signal) {
  const { symbol, side, confidence } = signal;

  if (confidence !== undefined && confidence < MIN_CONFIDENCE) {
    console.log(`Confidence ${confidence}% below threshold ${MIN_CONFIDENCE}% - skipping`);
    return { skipped: true, reason: "low confidence" };
  }

  let atm;
  try {
    atm = await getATMOption(symbol, side);
  } catch (err) {
    console.error("ATM resolution failed:", err.response?.data || err.message);
    await sendTelegram(`⚠️ Signal వచ్చింది (${symbol} ${side}) కానీ option chain fetch fail అయ్యింది. Dhan token/client-id check చేయు.`);
    return { error: "option chain fetch failed" };
  }

  const { securityId, exchangeSegment, premium, strike, spot } = atm;
  const lotSize = LOT_SIZES[symbol] || 75;
  const { quantity, lots, estimatedCost } = calculateQuantity(TRADE_BUDGET, premium, lotSize);

  if (quantity === 0) {
    await sendTelegram(
      `⚠️ Signal: ${symbol} ${side} @ strike ${strike} (premium ₹${premium})\n` +
      `Budget ₹${TRADE_BUDGET} 1 lot (${lotSize} qty) కి కూడా సరిపోలేదు.\n` +
      `Budget పెంచడానికి: /budget <amount> Telegram కి పంపు.`
    );
    return { skipped: true, reason: "budget too small", premium, lotSize };
  }

  const plan = buildTradePlan(premium);
  const tradeDetails = { symbol, side, securityId, exchangeSegment, quantity, lots, estimatedCost, strike, spot, ...plan };

  if (AUTO_MODE) {
    const result = await placeSuperOrder(tradeDetails);
    await sendTelegram(
      `🤖 <b>AUTO-EXECUTED</b>\n${symbol} ${side} | Strike: ${strike} | Spot: ${spot}\n` +
      `Lots: ${lots} | Qty: ${quantity} | Premium: ₹${premium}\n` +
      `Entry: ${plan.entryPrice} | Target: ${plan.targetPrice} | SL: ${plan.slPrice}\n` +
      `Cost: ~₹${estimatedCost}\n${DRY_RUN ? "(DRY RUN - no real order placed)" : "LIVE ORDER PLACED"}`
    );
    return { executed: true, dryRun: DRY_RUN, result };
  } else {
    const token = "t_" + Date.now();
    pendingTrades[token] = tradeDetails;
    const baseUrl = PUBLIC_URL || "http://localhost:3000";
    await sendTelegram(
      `📋 <b>Trade Plan Ready</b>\n${symbol} ${side} | Strike: ${strike} | Spot: ${spot}\n` +
      `Lots: ${lots} | Qty: ${quantity} | Premium: ₹${premium}\n` +
      `Entry: ${plan.entryPrice} | Target: ${plan.targetPrice} | SL: ${plan.slPrice}\n` +
      `Estimated Cost: ~₹${estimatedCost}\n\n` +
      `వీలున్నప్పుడు execute చేయడానికి:\n${baseUrl}/approve/${token}\n\n` +
      `(ఈ link 30 నిమిషాలు valid)`
    );
    setTimeout(() => delete pendingTrades[token], 30 * 60 * 1000);
    return { pending: true, token };
  }
}

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req, res) => res.send(
  "Mohan Trading Bridge v2 running.\n" +
  "Mode: " + (AUTO_MODE ? "AUTO" : "MANUAL") + " | DRY_RUN: " + DRY_RUN + " | Budget: ₹" + TRADE_BUDGET + "\n\n" +
  "Toggle: /mode/on | /mode/off\nBudget: send /budget <amount> to Telegram bot"
));

app.post('/webhook', async (req, res) => {
  console.log("Webhook received:", req.body);
  const result = await processSignal(req.body);
  res.json(result);
});

app.get('/test-signal', async (req, res) => {
  const symbol = req.query.symbol || "NIFTY";
  const side = req.query.side || "CE";
  const confidence = parseFloat(req.query.confidence || "75");
  const result = await processSignal({ symbol, side, confidence });
  res.json(result);
});

app.get('/approve/:token', async (req, res) => {
  const trade = pendingTrades[req.params.token];
  if (!trade) return res.send("Link expired or already used.");
  delete pendingTrades[req.params.token];
  const result = await placeSuperOrder(trade);
  await sendTelegram(
    `✅ <b>MANUALLY EXECUTED</b>\n${trade.symbol} ${trade.side} | Qty: ${trade.quantity}\n` +
    `${DRY_RUN ? "(DRY RUN - no real order placed)" : "LIVE ORDER PLACED"}`
  );
  res.send(`Order ${DRY_RUN ? "(dry run) processed" : "placed"}. Telegram లో confirm చూడు.`);
});

app.get('/mode/on', async (req, res) => {
  AUTO_MODE = true;
  await sendTelegram("🤖 Mode: AUTO — signals ఇక direct గా execute అవుతాయి (DRY_RUN=" + DRY_RUN + ").");
  res.send("AUTO mode ON.");
});

app.get('/mode/off', async (req, res) => {
  AUTO_MODE = false;
  await sendTelegram("✋ Mode: MANUAL — ప్రతి signal కి approve link వస్తుంది.");
  res.send("MANUAL mode ON.");
});

app.get('/mode/status', (req, res) => {
  res.json({ autoMode: AUTO_MODE, dryRun: DRY_RUN, budget: TRADE_BUDGET, minConfidence: MIN_CONFIDENCE, tokenRefresh: AUTO_REFRESH_TOKEN ? "auto" : "manual" });
});

app.get('/refresh-token', async (req, res) => {
  await refreshDhanToken();
  res.send("Refresh attempted. Check Telegram for confirmation.");
});

// ============================================================
// TELEGRAM WEBHOOK - handles "/budget <amount>" sent to the bot
// ============================================================
app.post('/telegram-webhook', async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);

  const text = msg.text.trim();

  if (text.startsWith("/budget")) {
    const parts = text.split(" ");
    const amount = parseFloat(parts[1]);
    if (!isNaN(amount) && amount > 0) {
      TRADE_BUDGET = amount;
      await sendTelegram(`✅ Budget updated: ₹${TRADE_BUDGET}. తర్వాతి signal నుండి ఇదే వాడుతుంది.`);
    } else {
      await sendTelegram("Format: /budget 15000 (ఒక్క number మాత్రమే)");
    }
  } else if (text === "/status") {
    await sendTelegram(
      `Mode: ${AUTO_MODE ? "AUTO" : "MANUAL"}\nDRY_RUN: ${DRY_RUN}\nBudget: ₹${TRADE_BUDGET}\nMin Confidence: ${MIN_CONFIDENCE}%\nToken Refresh: ${AUTO_REFRESH_TOKEN ? "AUTOMATIC" : "MANUAL"}`
    );
  } else if (text === "/auto") {
    AUTO_MODE = true;
    await sendTelegram("🤖 Mode: AUTO");
  } else if (text === "/manual") {
    AUTO_MODE = false;
    await sendTelegram("✋ Mode: MANUAL");
  } else if (text.startsWith("/token")) {
    const parts = text.split(" ");
    const newToken = parts[1];
    if (newToken && newToken.length > 20) {
      DHAN_ACCESS_TOKEN = newToken.trim();
      await sendTelegram("✅ Dhan token updated. ఇక ఇదే వాడుతుంది (24 గంటలు valid, రేపు మళ్ళీ update చేయాలి).");
    } else {
      await sendTelegram("Format: /token <paste_your_dhan_access_token_here>\n(Dhan web app లో రోజూ కొత్తగా generate చేసి, ఇక్కడ paste చేయు)");
    }
  } else if (text.startsWith("/clientid")) {
    const parts = text.split(" ");
    const newId = parts[1];
    if (newId) {
      DHAN_CLIENT_ID = newId.trim();
      await sendTelegram("✅ Dhan Client ID updated.");
    } else {
      await sendTelegram("Format: /clientid <your_dhan_client_id>");
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Trading bridge v2 running on port ${PORT}`);
  console.log(`Mode: ${AUTO_MODE ? "AUTO" : "MANUAL"} | DRY_RUN: ${DRY_RUN} | Budget: ₹${TRADE_BUDGET}`);
  console.log(`Token refresh: ${AUTO_REFRESH_TOKEN ? "AUTOMATIC (PIN+TOTP)" : "MANUAL (/token command)"}`);
  registerTelegramWebhook();

  if (AUTO_REFRESH_TOKEN) {
    refreshDhanToken(); // refresh once on startup
    setInterval(refreshDhanToken, 20 * 60 * 60 * 1000); // then every 20 hours (token valid 24h)
  }
});
