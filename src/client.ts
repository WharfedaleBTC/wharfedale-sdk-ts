// Client for a node's JSON-RPC (`POST /`) and Esplora REST (`GET /…`), same base URL.
import * as liquid from 'liquidjs-lib';

export interface ChainInfo {
  chain: string;
  blocks: number;
  bestBlockHash: string;
  /** Display (RPC) hex. */
  genesisHash: string;
  /** Display hex. */
  feeAsset: string;
}

export interface ScriptUtxo {
  txid: string;
  vout: number;
  height?: number;
  spentInMempool: boolean;
}

export interface AssetRecord {
  asset: string;
  reissuanceToken?: string;
  /** Issuance entropy, internal byte order, hex. */
  entropy: string;
  issuedAmount?: number;
}

export class RpcError extends Error {
  constructor(readonly method: string, message: string) {
    super(`RPC ${method}: ${message}`);
  }
}

export class Client {
  readonly url: string;

  /** `url`: e.g. `http://127.0.0.1:18443`. */
  constructor(url: string, private readonly timeoutMs = 30_000) {
    this.url = url.replace(/\/+$/, '');
  }

  /** Any JSON-RPC method. */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'sdk', method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let body: { result?: T; error?: { message?: string } | null };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error(`RPC ${method}: HTTP ${res.status}`);
    }
    if (body.error) throw new RpcError(method, body.error.message ?? JSON.stringify(body.error));
    return body.result as T;
  }

  /** Esplora `GET <url>/<path>`, parsed as JSON. */
  async rest<T = unknown>(path: string): Promise<T> {
    return JSON.parse(await this.restText(path)) as T;
  }

  async restText(path: string): Promise<string> {
    const res = await fetch(`${this.url}/${path.replace(/^\/+/, '')}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${text}`);
    return text;
  }

  async chainInfo(): Promise<ChainInfo> {
    const v = await this.call<Record<string, unknown>>('getblockchaininfo');
    return {
      chain: String(v.chain),
      blocks: Number(v.blocks),
      bestBlockHash: String(v.bestblockhash),
      genesisHash: String(v.genesis_hash),
      feeAsset: String(v.fee_asset),
    };
  }

  blockCount(): Promise<number> {
    return this.call<number>('getblockcount');
  }

  async transaction(txid: string): Promise<liquid.Transaction> {
    return liquid.Transaction.fromHex(await this.call<string>('getrawtransaction', [txid]));
  }

  /** Height of the block containing `txid`; `undefined` while unconfirmed. */
  async txHeight(txid: string): Promise<number | undefined> {
    const v = await this.call<{ blockheight?: number }>('getrawtransaction', [txid, true]);
    return v.blockheight;
  }

  /** `sendrawtransaction`: admitted to the node's mempool and gossiped. Returns the txid. */
  sendTransaction(tx: liquid.Transaction | string): Promise<string> {
    return this.call<string>('sendrawtransaction', [typeof tx === 'string' ? tx : tx.toHex()]);
  }

  /** Dry run (`testmempoolaccept`): `undefined` if accepted, else the reject reason. */
  async testAccept(tx: liquid.Transaction | string): Promise<string | undefined> {
    const [r] = await this.call<{ allowed: boolean; 'reject-reason'?: string }[]>('testmempoolaccept', [[typeof tx === 'string' ? tx : tx.toHex()]]);
    return r?.allowed ? undefined : (r?.['reject-reason'] ?? 'rejected');
  }

  /** Confirmed unspent outputs locked to `script` (`getscriptutxos`). */
  async scriptUtxos(script: Uint8Array): Promise<ScriptUtxo[]> {
    const v = await this.call<{ txid: string; vout: number; height?: number; spent_in_mempool?: boolean }[]>('getscriptutxos', [
      Buffer.from(script).toString('hex'),
    ]);
    return v.map((u) => ({ txid: u.txid, vout: u.vout, height: u.height, spentInMempool: !!u.spent_in_mempool }));
  }

  /** Esplora `/asset/:id`. */
  async asset(asset: string): Promise<AssetRecord> {
    const v = await this.rest<{ reissuance_token?: string; entropy?: string; chain_stats?: { issued_amount?: number } }>(`asset/${asset}`);
    if (!v.entropy) throw new Error('asset record has no entropy');
    return { asset, reissuanceToken: v.reissuance_token ?? undefined, entropy: v.entropy, issuedAmount: v.chain_stats?.issued_amount };
  }

  /** Resolves with the block height once `txid` is confirmed. */
  waitForTx(txid: string, timeoutMs = 60_000): Promise<number> {
    return poll(timeoutMs, `transaction ${txid} not confirmed`, async () => {
      try {
        return await this.txHeight(txid);
      } catch {
        return undefined;
      }
    });
  }

  waitForHeight(height: number, timeoutMs = 60_000): Promise<number> {
    return poll(timeoutMs, `height ${height} not reached`, async () => {
      const h = await this.blockCount().catch(() => 0);
      return h >= height ? h : undefined;
    });
  }
}

async function poll<T>(timeoutMs: number, what: string, f: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
