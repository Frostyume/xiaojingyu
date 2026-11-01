import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const SPENDING_SOURCE = Object.freeze({
  path: fileURLToPath(new URL('../../../../companion/guarded-client.mjs', import.meta.url)),
  sha256: 'fd74006432829b249ea1e4c1dc969e6374a981a436429b7f0dacc75b71a9932d'
});
const integer = value => Number.isSafeInteger(value) && value >= 0;
function mappedUsage(usage) {
  if (!usage || !integer(usage.inputTokens) || !integer(usage.outputTokens) || !integer(usage.totalTokens)) return null;
  const read = usage.cacheReadTokens ?? 0, write = usage.cacheWriteTokens ?? 0;
  if (!integer(read) || !integer(write)) return null;
  const input = usage.inputTokens + read + write;
  if (!Number.isSafeInteger(input) || input + usage.outputTokens !== usage.totalTokens || usage.totalTokens === 0) return null;
  return { input, cachedInput: read, output: usage.outputTokens };
}

const QINIU = Object.freeze({ route: 'qiniu-conatus', model: 'deepseek/deepseek-v4.1-flash-1017', baseURL: 'https://api.qnaigc.com/v1' });
function exactQiniu(provider) {
  try { const url = new URL(provider.baseURL); return provider.route === QINIU.route && provider.model === QINIU.model && url.href.replace(/\/+$/, '') === QINIU.baseURL; }
  catch { return false; }
}

// Native DSH/pi-ai input excludes cache tokens. Keep every reported field and
// its normalized total; no price, SDK cost placeholder or package balance is
// interpreted as a monetary charge for this external provider.
function openQiniuAccounting({ ledgerPath, maxOutput, provider, ownershipGate }) {
  let db;
  try {
    db = new DatabaseSync(ledgerPath); db.exec('PRAGMA busy_timeout=5000');
    db.exec(`CREATE TABLE IF NOT EXISTS external_provider_calls(
      id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,model TEXT NOT NULL,base_url TEXT NOT NULL,
      request_bytes INTEGER NOT NULL,max_output INTEGER NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,
      state TEXT NOT NULL,outcome TEXT NOT NULL,usage_status TEXT NOT NULL,input_tokens INTEGER,cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,reported_usage_json TEXT,http_status INTEGER,
      cost_micro_cny INTEGER,resource_deduction TEXT)`);
    const expected = 'id,request_id,provider,model,base_url,request_bytes,max_output,started_at,completed_at,state,outcome,usage_status,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,total_tokens,reported_usage_json,http_status,cost_micro_cny,resource_deduction';
    if (db.prepare('PRAGMA table_info(external_provider_calls)').all().map(row => row.name).join(',') !== expected) throw new Error('OWNED_QINIU_EXISTING_EXTERNAL_SCHEMA_CHANGED');
  } catch (error) { db?.close(); throw error; }
  const requests = new Map(); let connected = true, finalCounts;
  const active = () => { if (!connected) throw new Error('OWNED_ACCOUNTING_CLOSED'); };
  const counts = () => ({ total: db.prepare('SELECT count(*) n FROM external_provider_calls').get().n,
    unknown: db.prepare("SELECT count(*) n FROM external_provider_calls WHERE state='unknown'").get().n,
    unfinished: db.prepare("SELECT count(*) n FROM external_provider_calls WHERE outcome='started'").get().n });
  async function admit(request) {
    active();
    if (await ownershipGate({ ledgerPath, operation: 'admit-model-request' }) !== true) throw new Error('OWNED_ACCOUNTING_LEDGER_OWNERSHIP_REVOKED');
    active();
    if (typeof request?.requestId !== 'string' || !request.requestId || request.requestId.length > 256 || requests.has(request.requestId) || db.prepare('SELECT 1 FROM external_provider_calls WHERE request_id=?').get(request.requestId)) throw new Error('OWNED_ACCOUNTING_DUPLICATE_OR_INVALID_REQUEST');
    if (request.provider !== provider.route || request.model !== provider.model || !integer(request.requestBytes) || !Number.isSafeInteger(request.maxOutput) || request.maxOutput < 1 || request.maxOutput > maxOutput) throw new Error('OWNED_ACCOUNTING_REQUEST_BOUND_REJECTED');
    // External-provider usage accounting makes no monetary reservation. JSON
    // bytes (including tool schemas and base64 images) are not input tokens.
    // Keep a separate local payload ceiling; the provider owns context limits.
    if (request.requestBytes > 64 * 1024 * 1024) throw new Error('OWNED_ACCOUNTING_PAYLOAD_TOO_LARGE');
    const admissionId = 'qiniu-' + randomUUID();
    db.prepare(`INSERT INTO external_provider_calls(id,request_id,provider,model,base_url,request_bytes,max_output,started_at,state,outcome,usage_status,cost_micro_cny,resource_deduction)
      VALUES(?,?,?,?,?,?,?,?,'unknown','started','not-reported',NULL,NULL)`).run(admissionId,request.requestId,QINIU.route,QINIU.model,QINIU.baseURL,request.requestBytes,request.maxOutput,new Date().toISOString());
    requests.set(request.requestId,{ admissionId, closed: false });
    return { admissionId, requestId: request.requestId, reservedMicroCny: null };
  }
  function complete(receipt) {
    active(); const entry = requests.get(receipt?.requestId);
    if (!entry || entry.admissionId !== receipt.admissionId) throw new Error('OWNED_ACCOUNTING_UNKNOWN_ADMISSION');
    if (entry.closed) throw new Error('OWNED_ACCOUNTING_ALREADY_FINALIZED');
    if (!['completed','failed-or-aborted'].includes(receipt.outcome)) throw new Error('OWNED_ACCOUNTING_INVALID_OUTCOME');
    const usage = mappedUsage(receipt.usage), reported = {};
    for (const name of ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','totalTokens']) if (receipt.usage && Object.hasOwn(receipt.usage,name)) reported[name] = integer(receipt.usage[name]) ? receipt.usage[name] : null;
    const finished = receipt.outcome === 'completed', known = Boolean(usage);
    const usageStatus = known ? (finished ? 'reported-complete' : 'reported-partial') : 'unknown';
    db.prepare(`UPDATE external_provider_calls SET completed_at=?,state=?,outcome=?,usage_status=?,input_tokens=?,cache_read_tokens=?,cache_write_tokens=?,output_tokens=?,total_tokens=?,reported_usage_json=?,http_status=?,cost_micro_cny=NULL,resource_deduction=NULL WHERE id=?`).run(
      new Date().toISOString(),finished && known ? 'usage-recorded' : 'unknown',receipt.outcome,usageStatus,
      known ? receipt.usage.inputTokens : null,known ? receipt.usage.cacheReadTokens ?? 0 : null,known ? receipt.usage.cacheWriteTokens ?? 0 : null,
      known ? receipt.usage.outputTokens : null,known ? receipt.usage.totalTokens : null,Object.keys(reported).length ? JSON.stringify(reported) : null,
      Number.isInteger(receipt.httpStatus) && receipt.httpStatus >= 100 && receipt.httpStatus <= 599 ? receipt.httpStatus : null,entry.admissionId);
    entry.closed = true;
    return { settled: false, pending: true, usageRecorded: known, outcome: receipt.outcome, ...(known ? { mappedUsage: usage } : {}),
      costMicroCny: null, reservedMicroCny: null, resourceDeduction: null, costUnknown: true, costIsInvoice: false };
  }
  return { admit, complete, status: () => ({ connected, ledgerPath, capMicroCny: null, maxOutput, provider: QINIU.route, model: QINIU.model,
    accountingMode: 'external-provider-usage-only', officialReservationsUsed: false, costMicroCny: null, resourceDeduction: null, costUnknown: true,
    ownRequests: requests.size, ownUnfinished: [...requests.values()].filter(entry => !entry.closed).length, externalCalls: connected ? counts() : finalCounts }),
    close() { if (connected) { finalCounts = counts(); db.close(); connected = false; } } };
}

/** Opens an explicitly leased EXISTING ledger; never invents a fresh history. */
export async function openOwnedAccounting(options = {}) {
  const { ledgerPath, cap, maxOutput = 8192, provider, ownershipGate, expectedSourceSha256 = SPENDING_SOURCE.sha256 } = options;
  if (!Object.hasOwn(options,'cap') || !(cap === null || integer(cap))) throw new Error('OWNED_ACCOUNTING_EXPLICIT_NULL_OR_MICRO_CNY_CAP_REQUIRED');
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 32768) throw new Error('OWNED_ACCOUNTING_MAX_OUTPUT_INVALID');
  if (!path.isAbsolute(String(ledgerPath ?? '')) || typeof ownershipGate !== 'function' || await ownershipGate({ledgerPath,operation:'open-existing-accounting-ledger'}) !== true) throw new Error('OWNED_ACCOUNTING_EXPLICIT_LEDGER_OWNERSHIP_REQUIRED');
  if (!fs.existsSync(ledgerPath) || !fs.lstatSync(ledgerPath).isFile() || fs.lstatSync(ledgerPath).isSymbolicLink()) throw new Error('OWNED_ACCOUNTING_EXISTING_LEDGER_REQUIRED');
  if (provider?.route === QINIU.route) {
    if (!exactQiniu(provider)) throw new Error('OWNED_QINIU_EXPLICIT_PROVIDER_MODEL_ENDPOINT_REQUIRED');
    if (cap !== null) throw new Error('OWNED_QINIU_REQUIRES_EXPLICIT_NULL_CAP_WITH_UNKNOWN_PRICING');
    const metadata = new DatabaseSync(ledgerPath,{readOnly:true});
    try {
      const columns=metadata.prepare('PRAGMA table_info(calls)').all().map(row=>row.name);
      if (!['id','day','reserved','actual','state'].every(name=>columns.includes(name)) || !metadata.prepare('SELECT 1 FROM calls LIMIT 1').get()) throw new Error('OWNED_ACCOUNTING_EXISTING_HISTORY_REQUIRED');
    } finally { metadata.close(); }
    return openQiniuAccounting({ ledgerPath, maxOutput, provider: { ...provider }, ownershipGate });
  }
  const source = fs.readFileSync(SPENDING_SOURCE.path);
  if (createHash('sha256').update(source).digest('hex') !== expectedSourceSha256 || expectedSourceSha256 !== SPENDING_SOURCE.sha256) throw new Error('OWNED_ACCOUNTING_PINNED_SOURCE_CHANGED');
  const metadata = new DatabaseSync(ledgerPath,{readOnly:true});
  try { const columns = metadata.prepare('PRAGMA table_info(calls)').all().map(x=>x.name); for(const name of ['id','day','reserved','actual','state']) if(!columns.includes(name))throw new Error('OWNED_ACCOUNTING_EXISTING_CALLS_SCHEMA_REQUIRED'); if(!metadata.prepare('SELECT 1 AS present FROM calls LIMIT 1').get())throw new Error('OWNED_ACCOUNTING_EXISTING_HISTORY_REQUIRED'); }
  finally { metadata.close(); }
  if (provider?.model !== 'deepseek-flash' || new URL(provider.baseURL).hostname !== 'api.deepseek.com' || !provider.route) throw new Error('OWNED_ACCOUNTING_UNVALIDATED_PROVIDER_PRICING');
  const { SpendingBook } = await import(pathToFileURL(SPENDING_SOURCE.path).href);
  if(createHash('sha256').update(fs.readFileSync(SPENDING_SOURCE.path)).digest('hex')!==expectedSourceSha256)throw new Error('OWNED_ACCOUNTING_PINNED_SOURCE_CHANGED');
  const book = new SpendingBook(ledgerPath,cap,{maxOutput});
  const requests = new Map(); let connected = true;
  function active(){if(!connected)throw new Error('OWNED_ACCOUNTING_CLOSED');}
  async function admit(request) {
    active();
    if(await ownershipGate({ledgerPath,operation:'admit-model-request'})!==true)throw new Error('OWNED_ACCOUNTING_LEDGER_OWNERSHIP_REVOKED');
    active();
    if(typeof request.requestId!=='string'||!request.requestId||request.requestId.length>256||requests.has(request.requestId))throw new Error('OWNED_ACCOUNTING_DUPLICATE_OR_INVALID_REQUEST');
    if(request.provider!==provider.route||request.model!==provider.model||!integer(request.requestBytes)||!Number.isSafeInteger(request.maxOutput)||request.maxOutput<1||request.maxOutput>maxOutput)throw new Error('OWNED_ACCOUNTING_REQUEST_BOUND_REJECTED');
    // The same byte fallback/formula as the pinned guardedClient contract,
    // without moving private prompt bodies over the parent/child seam.
    const inputUpper=request.requestBytes*4+8192;
    if(!Number.isSafeInteger(inputUpper)||inputUpper>1048576)throw new Error('OWNED_ACCOUNTING_RESERVATION_BOUND_EXCEEDED');
    const amount=Math.max(50000,Math.ceil((inputUpper*200+request.maxOutput*800)/100));
    const admissionId=book.reserve(amount);
    book.db.prepare('INSERT INTO reservation_bounds VALUES(?,?,?,?,?)').run(admissionId,inputUpper,request.maxOutput,request.requestBytes,new Date().toISOString());
    const entry={admissionId,requestId:request.requestId,reservedMicroCny:amount,closed:false};requests.set(request.requestId,entry);
    return {admissionId,requestId:request.requestId,reservedMicroCny:amount};
  }
  function entryFor(receipt){active();const entry=requests.get(receipt.requestId);if(!entry||entry.admissionId!==receipt.admissionId)throw new Error('OWNED_ACCOUNTING_UNKNOWN_ADMISSION');return entry;}
  function complete(receipt) {
    const entry=entryFor(receipt);
    if(entry.closed)throw new Error('OWNED_ACCOUNTING_ALREADY_FINALIZED');
    const meters=receipt.outcome==='completed'?mappedUsage(receipt.usage):null;
    if(!meters){
      const category=receipt.outcome==='completed'?'usage-unknown':'failed-or-aborted-usage-unconfirmed';
      book.db.prepare('INSERT OR REPLACE INTO provider_failures VALUES(?,?,?,?,?)').run(entry.admissionId,category,Number.isInteger(receipt.httpStatus)?receipt.httpStatus:null,1,new Date().toISOString());
      entry.closed=true;return {settled:false,pending:true,reason:category};
    }
    book.settleDeepSeek(entry.admissionId,[{id:receipt.requestId,meters}]);
    const row=book.db.prepare('SELECT actual,state FROM calls WHERE id=?').get(entry.admissionId);
    entry.closed=true;
    return {settled:row.state==='settled',pending:row.state!=='settled',mappedUsage:meters,ceilingMicroCny:row.actual,costIsInvoice:false};
  }
  return {admit,complete,status:()=>({connected,ledgerPath,capMicroCny:cap,maxOutput,sourceSha256:expectedSourceSha256,ownRequests:requests.size,ownUnfinished:[...requests.values()].filter(x=>!x.closed).length}),close(){if(connected){connected=false;book.close();}}};
}
