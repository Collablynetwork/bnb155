const axios = require('axios');
const WebSocket = require('ws');
const config = require('./config');

const rest = axios.create({
  baseURL: config.binanceApiUrl,
  timeout: 25_000
});

const publicData = axios.create({
  baseURL: config.binanceApiUrl,
  timeout: 25_000
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry(client, url, params = {}, attempt = 1) {
  try {
    const response = await client.get(url, { params });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const shouldRetry = attempt < 4 && (!status || status >= 429);
    if (shouldRetry) {
      await sleep(400 * attempt);
      return requestWithRetry(client, url, params, attempt + 1);
    }
    throw error;
  }
}

function mapKline(row) {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    tradeCount: Number(row[8]),
    takerBuyBase: Number(row[9]),
    takerBuyQuote: Number(row[10])
  };
}

async function ping() {
  return requestWithRetry(rest, '/fapi/v1/ping');
}

async function getExchangeInfo() {
  return requestWithRetry(rest, '/fapi/v1/exchangeInfo');
}

async function getValidUsdtPerpSet() {
  const info = await getExchangeInfo();
  const symbols = info.symbols || [];
  return new Set(
    symbols
      .filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.marginAsset === 'USDT')
      .map((s) => s.symbol)
  );
}

async function getKlines(symbol, interval, limit = 300, startTime, endTime) {
  const params = { symbol, interval, limit };
  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;
  const rows = await requestWithRetry(rest, '/fapi/v1/klines', params);
  return rows.map(mapKline);
}

async function getMarkPrice(symbol) {
  return requestWithRetry(rest, '/fapi/v1/premiumIndex', { symbol });
}

async function getTickerPrice(symbol) {
  return requestWithRetry(rest, '/fapi/v1/ticker/price', { symbol });
}

async function getBookTicker(symbol) {
  return requestWithRetry(rest, '/fapi/v1/ticker/bookTicker', { symbol });
}

async function getFundingRate(symbol, limit = 20) {
  return requestWithRetry(rest, '/fapi/v1/fundingRate', { symbol, limit });
}

async function getOpenInterest(symbol) {
  return requestWithRetry(rest, '/fapi/v1/openInterest', { symbol });
}

async function getOpenInterestHist(symbol, period = '5m', limit = 30) {
  return requestWithRetry(rest, '/futures/data/openInterestHist', { symbol, period, limit });
}

async function getTakerLongShortRatio(symbol, period = '5m', limit = 30) {
  return requestWithRetry(rest, '/futures/data/takerlongshortRatio', { symbol, period, limit });
}

async function getTopLongShortAccountRatio(symbol, period = '5m', limit = 30) {
  return requestWithRetry(rest, '/futures/data/topLongShortAccountRatio', { symbol, period, limit });
}

async function getGlobalLongShortRatio(symbol, period = '5m', limit = 30) {
  return requestWithRetry(rest, '/futures/data/globalLongShortAccountRatio', { symbol, period, limit });
}

async function getRecentAggTrades(symbol, limit = 100) {
  return requestWithRetry(rest, '/fapi/v1/aggTrades', { symbol, limit });
}

function createCombinedKlineSocket(symbols, intervals, onMessage) {
  const streams = [];
  for (const symbol of symbols) {
    for (const interval of intervals) {
      streams.push(`${symbol.toLowerCase()}@kline_${interval}`);
    }
  }
  const ws = new WebSocket(`${config.binanceWsUrl}/stream?streams=${streams.join('/')}`);
  ws.on('message', (raw) => {
    try {
      const payload = JSON.parse(raw);
      onMessage(payload);
    } catch (error) {
      console.error('WS parse error:', error.message);
    }
  });
  ws.on('error', (error) => console.error('WS error:', error.message));
  return ws;
}

module.exports = {
  ping,
  getExchangeInfo,
  getValidUsdtPerpSet,
  getKlines,
  getMarkPrice,
  getTickerPrice,
  getBookTicker,
  getFundingRate,
  getOpenInterest,
  getOpenInterestHist,
  getTakerLongShortRatio,
  getTopLongShortAccountRatio,
  getGlobalLongShortRatio,
  getRecentAggTrades,
  createCombinedKlineSocket
};
