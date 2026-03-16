/**
 * IBKR Flex Web Service MCP Server
 * Provides portfolio position data via the IBKR Flex Web Service (reporting API).
 * Requires no gateway or login session — just a Flex Token and Query ID.
 *
 * Environment variables:
 *   IBKR_FLEX_TOKEN    — Flex Web Service access token (generated in Client Portal)
 *   IBKR_FLEX_QUERY_ID — Query ID of the Flex Query template (created in Client Portal)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { XMLParser } from 'fast-xml-parser';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { z } from 'zod';

// Apple Container VMs have no direct internet — route through the host's forward proxy
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const FLEX_TOKEN = process.env.IBKR_FLEX_TOKEN || '';
const FLEX_QUERY_ID = process.env.IBKR_FLEX_QUERY_ID || '';

const BASE_URL =
  'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const USER_AGENT = 'Node.js/20';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
});

function log(msg: string): void {
  console.error(`[ibkr-flex] ${msg}`);
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Flex Web Service API ---

interface SendRequestResponse {
  status: 'Success' | 'Fail';
  referenceCode?: string;
  url?: string;
  errorCode?: string;
  errorMessage?: string;
}

async function sendRequest(
  token: string,
  queryId: string,
): Promise<SendRequestResponse> {
  const url = new URL(`${BASE_URL}/SendRequest`);
  url.searchParams.set('t', token);
  url.searchParams.set('q', queryId);
  url.searchParams.set('v', '3');

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`SendRequest HTTP error: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const parsed = xmlParser.parse(xml);
  const root = parsed.FlexStatementResponse;

  return {
    status: root.Status,
    referenceCode: root.ReferenceCode?.toString(),
    url: root.Url,
    errorCode: root.ErrorCode?.toString(),
    errorMessage: root.ErrorMessage,
  };
}

async function getStatement(
  token: string,
  referenceCode: string,
): Promise<string> {
  const url = new URL(`${BASE_URL}/GetStatement`);
  url.searchParams.set('t', token);
  url.searchParams.set('q', referenceCode);
  url.searchParams.set('v', '3');

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`GetStatement HTTP error: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

interface FlexOpenPosition {
  symbol: string;
  description: string;
  conid: string;
  assetClass: string;
  currency: string;
  quantity: number;
  costBasisPrice: number;
  costBasisMoney: number;
  markPrice: number;
  positionValue: number;
  fifoPnlUnrealized: number;
  side: 'LONG' | 'SHORT';
  multiplier: number;
  strike?: number;
  expiry?: string;
  putCall?: 'P' | 'C';
  accountId: string;
}

interface FlexStatementMeta {
  accountId: string;
  fromDate: string;
  toDate: string;
  whenGenerated: string;
}

interface FlexQueryResult {
  meta: FlexStatementMeta;
  positions: FlexOpenPosition[];
}

function parsePositions(xml: string): FlexQueryResult {
  const parsed = xmlParser.parse(xml);

  if (parsed.FlexStatementResponse?.Status === 'Fail') {
    throw new Error(
      `Flex API error ${parsed.FlexStatementResponse.ErrorCode}: ${parsed.FlexStatementResponse.ErrorMessage}`,
    );
  }

  const flexStatements = parsed.FlexQueryResponse?.FlexStatements;
  const statement = flexStatements?.FlexStatement;

  if (!statement) {
    throw new Error('No FlexStatement found in response');
  }

  const meta: FlexStatementMeta = {
    accountId: statement.accountId ?? '',
    fromDate: statement.fromDate ?? '',
    toDate: statement.toDate ?? '',
    whenGenerated: statement.whenGenerated ?? '',
  };

  const rawPositions = statement.OpenPositions?.OpenPosition;
  const positionArray: any[] = !rawPositions
    ? []
    : Array.isArray(rawPositions)
      ? rawPositions
      : [rawPositions];

  const positions: FlexOpenPosition[] = positionArray.map((p: any) => ({
    symbol: p.symbol ?? '',
    description: p.description ?? '',
    conid: p.conid?.toString() ?? '',
    assetClass: p.assetCategory ?? p.assetClass ?? '',
    currency: p.currency ?? '',
    quantity: parseFloat(p.position ?? p.quantity ?? '0'),
    costBasisPrice: parseFloat(p.costBasisPrice ?? '0'),
    costBasisMoney: parseFloat(p.costBasisMoney ?? '0'),
    markPrice: parseFloat(p.markPrice ?? '0'),
    positionValue: parseFloat(p.positionValue ?? '0'),
    fifoPnlUnrealized: parseFloat(p.fifoPnlUnrealized ?? '0'),
    side: parseFloat(p.position ?? p.quantity ?? '0') >= 0 ? 'LONG' as const : 'SHORT' as const,
    multiplier: parseFloat(p.multiplier ?? '1'),
    strike: p.strike ? parseFloat(p.strike) : undefined,
    expiry: p.expiry ?? undefined,
    putCall: p.putCall ?? undefined,
    accountId: p.accountId ?? meta.accountId,
  }));

  return { meta, positions };
}

async function fetchPositions(
  token: string,
  queryId: string,
  options?: {
    maxRetries?: number;
    initialDelayMs?: number;
    retryDelayMs?: number;
  },
): Promise<FlexQueryResult> {
  const maxRetries = options?.maxRetries ?? 5;
  const initialDelay = options?.initialDelayMs ?? 3000;
  const retryDelay = options?.retryDelayMs ?? 2000;

  log('Requesting report generation...');
  const sendResult = await sendRequest(token, queryId);

  if (sendResult.status !== 'Success' || !sendResult.referenceCode) {
    throw new Error(
      `SendRequest failed: ${sendResult.errorCode} — ${sendResult.errorMessage}`,
    );
  }

  const referenceCode = sendResult.referenceCode;
  log(`Reference code: ${referenceCode}`);

  await sleep(initialDelay);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`Fetching statement (attempt ${attempt}/${maxRetries})...`);

    const xml = await getStatement(token, referenceCode);

    if (xml.includes('<Status>Fail</Status>')) {
      const errorParsed = xmlParser.parse(xml);
      const errorCode = errorParsed.FlexStatementResponse?.ErrorCode?.toString();

      if (errorCode === '1019') {
        log(`Report still generating, waiting ${retryDelay}ms...`);
        await sleep(retryDelay);
        continue;
      }

      throw new Error(
        `GetStatement error ${errorCode}: ${errorParsed.FlexStatementResponse?.ErrorMessage}`,
      );
    }

    log('Report received, parsing positions...');
    return parsePositions(xml);
  }

  throw new Error(
    `GetStatement failed after ${maxRetries} retries — report never became ready`,
  );
}

// --- Cached positions (avoids hammering the API) ---

let cachedResult: FlexQueryResult | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

async function getCachedPositions(): Promise<FlexQueryResult> {
  if (cachedResult && Date.now() - cachedAt < CACHE_TTL_MS) {
    log('Returning cached positions');
    return cachedResult;
  }
  cachedResult = await fetchPositions(FLEX_TOKEN, FLEX_QUERY_ID);
  cachedAt = Date.now();
  return cachedResult;
}

// --- MCP Server ---

const server = new McpServer({ name: 'ibkr', version: '2.0.0' });

server.tool(
  'get_positions',
  'Get all open portfolio positions from IBKR. Returns symbol, quantity, market value, cost basis, unrealized P&L, and more for each position.',
  {},
  async () => {
    try {
      const result = await getCachedPositions();

      if (result.positions.length === 0) {
        return textResult(
          `Account ${result.meta.accountId} — No open positions.\n` +
          `Report period: ${result.meta.fromDate} to ${result.meta.toDate}`,
        );
      }

      const lines = [
        `Account: ${result.meta.accountId}`,
        `Report: ${result.meta.fromDate} to ${result.meta.toDate} (generated ${result.meta.whenGenerated})`,
        `Positions: ${result.positions.length}`,
        '',
      ];

      for (const pos of result.positions) {
        const parts = [
          pos.symbol.padEnd(12),
          pos.side.padEnd(5),
          `qty=${pos.quantity}`,
          `value=${pos.positionValue.toFixed(2)} ${pos.currency}`,
          `cost=${pos.costBasisMoney.toFixed(2)}`,
          `P&L=${pos.fifoPnlUnrealized.toFixed(2)}`,
        ];
        if (pos.assetClass !== 'STK') parts.push(`[${pos.assetClass}]`);
        if (pos.strike) parts.push(`strike=${pos.strike}`);
        if (pos.expiry) parts.push(`exp=${pos.expiry}`);
        if (pos.putCall) parts.push(pos.putCall === 'C' ? 'CALL' : 'PUT');
        lines.push(parts.join(' | '));
      }

      return textResult(lines.join('\n'));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  'get_position_summary',
  'Get a summary of the portfolio: total value, total P&L, breakdown by asset class and currency.',
  {},
  async () => {
    try {
      const result = await getCachedPositions();

      if (result.positions.length === 0) {
        return textResult('No open positions.');
      }

      // Group by currency
      const byCurrency = new Map<string, { value: number; pnl: number; count: number }>();
      const byAssetClass = new Map<string, { value: number; pnl: number; count: number }>();

      for (const pos of result.positions) {
        // By currency
        const curr = byCurrency.get(pos.currency) || { value: 0, pnl: 0, count: 0 };
        curr.value += pos.positionValue;
        curr.pnl += pos.fifoPnlUnrealized;
        curr.count++;
        byCurrency.set(pos.currency, curr);

        // By asset class
        const ac = byAssetClass.get(pos.assetClass) || { value: 0, pnl: 0, count: 0 };
        ac.value += pos.positionValue;
        ac.pnl += pos.fifoPnlUnrealized;
        ac.count++;
        byAssetClass.set(pos.assetClass, ac);
      }

      const lines = [
        `Account: ${result.meta.accountId}`,
        `Total positions: ${result.positions.length}`,
        '',
        '--- By Currency ---',
      ];

      for (const [currency, data] of byCurrency) {
        lines.push(`  ${currency}: ${data.count} positions, value=${data.value.toFixed(2)}, P&L=${data.pnl.toFixed(2)}`);
      }

      lines.push('', '--- By Asset Class ---');
      for (const [ac, data] of byAssetClass) {
        lines.push(`  ${ac}: ${data.count} positions, value=${data.value.toFixed(2)}, P&L=${data.pnl.toFixed(2)}`);
      }

      return textResult(lines.join('\n'));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  'get_position_by_symbol',
  'Get position details for a specific symbol.',
  {
    symbol: z.string().describe('Symbol to look up (e.g., "AAPL", "6834")'),
  },
  async (args) => {
    try {
      const result = await getCachedPositions();
      const matches = result.positions.filter(
        (p) => p.symbol.toUpperCase().includes(args.symbol.toUpperCase()),
      );

      if (matches.length === 0) {
        return textResult(`No position found matching "${args.symbol}".`);
      }

      const lines = matches.map((pos) => {
        return [
          `Symbol: ${pos.symbol}`,
          `Description: ${pos.description}`,
          `ConID: ${pos.conid}`,
          `Asset Class: ${pos.assetClass}`,
          `Side: ${pos.side}`,
          `Quantity: ${pos.quantity}`,
          `Mark Price: ${pos.markPrice} ${pos.currency}`,
          `Position Value: ${pos.positionValue.toFixed(2)} ${pos.currency}`,
          `Cost Basis: ${pos.costBasisMoney.toFixed(2)} (per unit: ${pos.costBasisPrice.toFixed(2)})`,
          `Unrealized P&L: ${pos.fifoPnlUnrealized.toFixed(2)}`,
          pos.multiplier > 1 ? `Multiplier: ${pos.multiplier}` : null,
          pos.strike ? `Strike: ${pos.strike}` : null,
          pos.expiry ? `Expiry: ${pos.expiry}` : null,
          pos.putCall ? `Type: ${pos.putCall === 'C' ? 'CALL' : 'PUT'}` : null,
        ].filter(Boolean).join('\n');
      });

      return textResult(lines.join('\n\n---\n\n'));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  'refresh_positions',
  'Force refresh positions from IBKR (bypasses the 1-minute cache). Use sparingly — IBKR rate-limits the Flex Web Service.',
  {},
  async () => {
    try {
      cachedResult = null;
      cachedAt = 0;
      const result = await getCachedPositions();
      return textResult(
        `Refreshed. ${result.positions.length} positions for account ${result.meta.accountId}.`,
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

// Start serving
const transport = new StdioServerTransport();
await server.connect(transport);
