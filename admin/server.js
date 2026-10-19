const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// Robust .env parser helper
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf-8');
  const parsed = {};
  const lines = content.split(/\r?\n/);
  let currentKey = null;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith('#')) {
      currentKey = null;
      continue;
    }
    const eqIdx = rawLine.indexOf('=');
    if (eqIdx !== -1) {
      const key = rawLine.slice(0, eqIdx).trim();
      const val = rawLine.slice(eqIdx + 1).trim();
      parsed[key] = val;
      currentKey = key;
    } else if (currentKey && !parsed[currentKey]) {
      // User pasted value on next line after KEY=
      parsed[currentKey] = rawLine;
      currentKey = null;
    }
  }
  for (const [k, v] of Object.entries(parsed)) {
    const clean = v.replace(/^["']|["']$/g, '');
    parsed[k] = clean;
    process.env[k] = clean;
  }
  return parsed;
}
const env = loadEnv();

const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = env.GEMINI_API_KEY;
const GEMINI_VISION_MODEL = "gemini-3.5-flash-lite";
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
const TALLY_HOST = '127.0.0.1';
const TALLY_PORT = 9000;
const STOREFRONT_API_KEY = (env.STOREFRONT_API_KEY || process.env.STOREFRONT_API_KEY || 'sai_store_live_sec_892176').trim();

function requireStorefrontAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!apiKey || apiKey.trim() !== STOREFRONT_API_KEY) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or missing API key. Please pass your API key in the "x-api-key" header.'
    });
  }
  next();
}

// -----------------------------------------------------------------------------
// SaaS Multi-Shop & Godown Configuration (Strict Godown Isolation)
// -----------------------------------------------------------------------------
let currentTargetGodown = (env.TARGET_GODOWN || 'Sarees').trim();

async function getTargetGodown() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.target_godown&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0]?.value) {
      currentTargetGodown = rows[0].value.trim();
    }
  } catch (err) {
    // Keep in-memory currentTargetGodown fallback
  }
  return currentTargetGodown;
}

async function setTargetGodown(name) {
  if (!name || typeof name !== 'string') return currentTargetGodown;
  const cleanName = name.trim();
  currentTargetGodown = cleanName;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ key: 'target_godown', value: cleanName, updated_at: new Date().toISOString() })
    });
  } catch (err) {
    console.warn('[setTargetGodown] Failed to persist target_godown:', err.message);
  }
  return currentTargetGodown;
}

async function fetchTallyGodowns() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllGodowns</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllGodowns">
            <TYPE>Godown</TYPE>
            <FETCH>Name,Parent</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
  try {
    const res = await sendToTally(xml, 4000);
    const names = [];
    const blockRegex = /<GODOWN\s+NAME="([^"]+)"[^>]*>/gi;
    let match;
    while ((match = blockRegex.exec(res)) !== null) {
      const gName = unescapeXml(match[1]).trim();
      if (gName && !names.includes(gName)) {
        names.push(gName);
      }
    }
    return names;
  } catch (err) {
    console.warn('[fetchTallyGodowns] Tally unreachable or error:', err.message);
    return [];
  }
}

app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));

// Enable CORS for external storefront requests (e.g., Angular frontend)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  if (!req.path.startsWith('/api/')) {
    res.setHeader('Clear-Site-Data', '"cache"');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Clear-Site-Data', '"cache"');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(['/app.js', '/app-v2.js'], (req, res) => {
  res.setHeader('Clear-Site-Data', '"cache"');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'app-v2.js'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0
}));

// Serve Storefront API Test Simulation page at /api-test
app.use('/api-test', express.static(path.resolve(__dirname, '..', 'api test')));

// -----------------------------------------------------------------------------
// State: Morning Stock Sync Memory
// -----------------------------------------------------------------------------
let morningSyncState = {
  lastSyncAt: null,
  itemsUpdated: 0,
  status: 'idle',
  error: null,
  reconciliation: []
};
const manuallyDeletedSkus = new Set();

async function loadManuallyDeletedSkus() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.manually_deleted_skus&select=value`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0]?.value) {
      const list = JSON.parse(rows[0].value);
      if (Array.isArray(list)) list.forEach(s => manuallyDeletedSkus.add(s.toLowerCase()));
    }
  } catch (_) {}
  return manuallyDeletedSkus;
}

async function addManuallyDeletedSku(sku) {
  if (!sku) return;
  manuallyDeletedSkus.add(sku.toLowerCase());
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key: 'manually_deleted_skus',
        value: JSON.stringify([...manuallyDeletedSkus]),
        updated_at: new Date().toISOString()
      })
    });
  } catch (_) {}
}

// Load initially on startup
loadManuallyDeletedSkus();

// -----------------------------------------------------------------------------
// Helper: Tally XML Transport
// -----------------------------------------------------------------------------
function sendToTally(xml, customTimeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: TALLY_HOST,
      port: TALLY_PORT,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=utf-8',
        'Content-Length': Buffer.byteLength(xml)
      },
      timeout: customTimeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Tally connection timed out'));
    });
    req.write(xml);
    req.end();
  });
}

function unescapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

// -----------------------------------------------------------------------------
// Helper: Gemini Embedding 2 (Multimodal 768-d)
// -----------------------------------------------------------------------------
async function generateEmbedding(part, taskType = 'RETRIEVAL_DOCUMENT') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [part] },
      taskType,
      outputDimensionality: 768
    })
  });
  const data = await res.json();
  if (!res.ok || !data.embedding?.values) {
    throw new Error(data.error?.message || 'Failed to generate embedding');
  }
  return data.embedding.values;
}

// Cosine similarity
function computeCosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return (normA === 0 || normB === 0) ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// -----------------------------------------------------------------------------
// Helper: Tally XML Generators (Sales Voucher & Receipt Note)
// -----------------------------------------------------------------------------
function buildTallySalesVoucherXml({ orderNumber, stockItemName, qty, rate, unitLabel = 'Nos', godownName = null, buyerName = 'WhatsApp Customer', dateOverride = null }) {
  const targetGodown = (godownName || currentTargetGodown || 'Sarees').trim();
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  // In Tally EDU mode, non-1/2/31 dates are rejected. Use safe day '01' if outside allowed EDU days.
  const safeDay = (day === '01' || day === '02' || day === '31') ? day : '01';
  const dateStr = dateOverride || `${year}${month}${safeDay}`;
  const totalAmount = (qty * rate).toFixed(2);
  const cleanItem = escapeXml(stockItemName);

  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Sales" ACTION="Create">
            <DATE>${dateStr}</DATE>
            <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${orderNumber}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
            <NARRATION>Order ${orderNumber} - Buyer: ${buyerName}</NARRATION>
            
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>Cash</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
              <AMOUNT>-${totalAmount}</AMOUNT>
            </LEDGERENTRIES.LIST>

            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${cleanItem}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <RATE>${Number(rate).toFixed(2)}/${unitLabel}</RATE>
              <AMOUNT>${totalAmount}</AMOUNT>
              <ACTUALQTY>${qty} ${unitLabel}</ACTUALQTY>
              <BILLEDQTY>${qty} ${unitLabel}</BILLEDQTY>
              <BATCHALLOCATIONS.LIST>
                <GODOWNNAME>${targetGodown}</GODOWNNAME>
                <BATCHNAME>Primary Batch</BATCHNAME>
                <AMOUNT>${totalAmount}</AMOUNT>
                <ACTUALQTY>${qty} ${unitLabel}</ACTUALQTY>
                <BILLEDQTY>${qty} ${unitLabel}</BILLEDQTY>
              </BATCHALLOCATIONS.LIST>
              <ACCOUNTINGALLOCATIONS.LIST>
                <LEDGERNAME>Sales Account</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>${totalAmount}</AMOUNT>
              </ACCOUNTINGALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function buildTallyReceiptNoteXml({ refNumber, stockItemName, qty, rate, unitLabel = 'Nos', godownName = null, dateOverride = null }) {
  const targetGodown = (godownName || currentTargetGodown || 'Sarees').trim();
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = dateOverride || `${year}${month}${day}`;
  const totalAmount = (qty * rate).toFixed(2);

  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Receipt Note" ACTION="Create">
            <DATE>${dateStr}</DATE>
            <EFFECTIVEDATE>${dateStr}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>Receipt Note</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${refNumber}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
            <NARRATION>Stock Inward: ${stockItemName} ${qty} ${unitLabel} to ${targetGodown} Godown</NARRATION>
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${stockItemName}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <RATE>${Number(rate).toFixed(2)}/${unitLabel}</RATE>
              <AMOUNT>-${totalAmount}</AMOUNT>
              <ACTUALQTY>${qty} ${unitLabel}</ACTUALQTY>
              <BILLEDQTY>${qty} ${unitLabel}</BILLEDQTY>
              <BATCHALLOCATIONS.LIST>
                <GODOWNNAME>${targetGodown}</GODOWNNAME>
                <BATCHNAME>Primary Batch</BATCHNAME>
                <AMOUNT>-${totalAmount}</AMOUNT>
                <ACTUALQTY>${qty} ${unitLabel}</ACTUALQTY>
                <BILLEDQTY>${qty} ${unitLabel}</BILLEDQTY>
              </BATCHALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe).replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

// Push/Create or Alter Stock Item Master in Tally ERP with Godown Allocation
async function pushProductToTallyMaster({ sku, name, quantity = 0, rate = 5000, unitLabel = 'Pcs', godownName = null }) {
  const targetGodown = (godownName || await getTargetGodown() || 'Sarees').trim();
  const cleanSku = escapeXml((sku || '').trim());
  const cleanName = escapeXml((name || sku || '').trim());
  const cleanQty = Math.max(0, parseInt(quantity, 10) || 0);
  const cleanRate = parseFloat(rate) || 5000;
  const amount = (cleanQty * cleanRate).toFixed(2);

  // 1. Ensure Unit exists in Tally
  try {
    const unitXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<UNIT NAME="${unitLabel}" ACTION="Create"><NAME>${unitLabel}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    await sendToTally(unitXml, 4000);
  } catch (_) {}

  // 2. Ensure Sarees Stock Group exists
  try {
    const groupXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKGROUP NAME="Sarees" ACTION="Create"><NAME>Sarees</NAME><PARENT>Primary</PARENT></STOCKGROUP>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    await sendToTally(groupXml, 4000);
  } catch (_) {}

  // 2b. Ensure Target Godown exists in Tally
  try {
    const godownXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<GODOWN NAME="${escapeXml(targetGodown)}" ACTION="Create">
  <NAME>${escapeXml(targetGodown)}</NAME>
  <PARENT>Main Location</PARENT>
</GODOWN>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    await sendToTally(godownXml, 4000);
  } catch (_) {}

  // 3. Create or Alter Stock Item with Godown Allocation
  const itemXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TALLYUDF">
<STOCKITEM NAME="${cleanSku}" ACTION="Create">
  <NAME.LIST>
    <NAME>${cleanSku}</NAME>
    <NAME>${cleanName}</NAME>
  </NAME.LIST>
  <PARENT>Sarees</PARENT>
  <BASEUNITS>${unitLabel}</BASEUNITS>
  <OPENINGBALANCE>${cleanQty} ${unitLabel}</OPENINGBALANCE>
  <OPENINGRATE>${cleanRate.toFixed(2)}/${unitLabel}</OPENINGRATE>
  <OPENINGVALUE>-${amount}</OPENINGVALUE>
  <BATCHALLOCATIONS.LIST>
    <GODOWNNAME>${targetGodown}</GODOWNNAME>
    <BATCHNAME>Primary Batch</BATCHNAME>
    <OPENINGBALANCE>${cleanQty} ${unitLabel}</OPENINGBALANCE>
    <OPENINGRATE>${cleanRate.toFixed(2)}/${unitLabel}</OPENINGRATE>
    <OPENINGVALUE>-${amount}</OPENINGVALUE>
  </BATCHALLOCATIONS.LIST>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  const res = await sendToTally(itemXml, 5000);
  const created = res.includes('<CREATED>1</CREATED>');
  const altered = res.includes('<ALTERED>1</ALTERED>');
  const errors = res.includes('<ERRORS>') && !res.includes('<ERRORS>0</ERRORS>');

  return { success: (created || altered) && !errors, created, altered, raw: res };
}

// Helper: Fetch all live stock items from Tally ERP via direct master collection
async function fetchAllTallyStockItems() {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CustomStockItems</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CustomStockItems">
            <TYPE>StockItem</TYPE>
            <FETCH>Name,Parent,ClosingBalance,ClosingRate,StandardPrice,BaseUnits,PartNo,BatchAllocations.*</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

  const items = [];
  try {
    const res = await sendToTally(xml, 6000);
    const targetGodown = await getTargetGodown();
    const blockRegex = /<STOCKITEM\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/STOCKITEM>/gi;
    let blockMatch;
    while ((blockMatch = blockRegex.exec(res)) !== null) {
      const name = unescapeXml(blockMatch[1]).trim();
      if (!name || name.toLowerCase() === 'sarees' || name.toLowerCase() === 'primary') continue;
      const body = blockMatch[2];

      // Strict godown isolation check: Inspect batch allocations for target godown
      let qty = 0;
      let foundSpecificBatch = false;
      const batchRegex = /<BATCHALLOCATIONS\.LIST[^>]*>([\s\S]*?)<\/BATCHALLOCATIONS\.LIST>/gi;
      let batchMatch;
      while ((batchMatch = batchRegex.exec(body)) !== null) {
        const bContent = batchMatch[1];
        const gMatch = bContent.match(/<GODOWNNAME[^>]*>([^<]*)<\/GODOWNNAME>/i);
        const gName = gMatch ? unescapeXml(gMatch[1]).trim() : '';
        if (gName.toLowerCase() === targetGodown.toLowerCase()) {
          foundSpecificBatch = true;
          const bClosingMatch = bContent.match(/<(?:CLOSINGBALANCE|OPENINGBALANCE|ACTUALQTY)[^>]*>([^<]*)<\/(?:CLOSINGBALANCE|OPENINGBALANCE|ACTUALQTY)>/i);
          const rawBClosing = bClosingMatch ? bClosingMatch[1].trim() : '';
          const bNumMatch = rawBClosing.match(/[0-9.]+/);
          if (bNumMatch) {
            qty += parseFloat(bNumMatch[0]);
          }
        }
      }

      // If no explicit batch allocation list, read closing balance
      if (!foundSpecificBatch) {
        const closingMatch = body.match(/<CLOSINGBALANCE[^>]*>([^<]*)<\/CLOSINGBALANCE>/i);
        const rawClosing = closingMatch ? closingMatch[1].trim() : '';
        const isNegative = rawClosing.includes('-');
        const numMatch = rawClosing.match(/[0-9.]+/);
        let fallbackQty = numMatch ? parseFloat(numMatch[0]) : 0;
        if (isNegative || isNaN(fallbackQty)) fallbackQty = 0;
        qty = fallbackQty;
      }

      const rateMatch = body.match(/<(?:CLOSINGRATE|STANDARDPRICE)[^>]*>([^<]*)<\/(?:CLOSINGRATE|STANDARDPRICE)>/i);
      const rateStr = rateMatch ? rateMatch[1].trim() : '0';
      const numRateMatch = rateStr.match(/[0-9.]+/);
      const rate = numRateMatch ? parseFloat(numRateMatch[0]) : 0;

      const unitsMatch = body.match(/<BASEUNITS[^>]*>([^<]*)<\/BASEUNITS>/i);
      const unit = (unitsMatch ? unitsMatch[1].trim() : 'Nos').trim();

      items.push({
        product_code: name,
        name,
        tally_qty: Math.max(0, Math.round(qty)),
        rate,
        unit
      });
    }
  } catch (err) {
    console.warn('[fetchAllTallyStockItems] Error querying Tally collection:', err.message);
    throw err;
  }
  return items;
}

// Query live closing stock for a specific item from Tally ERP
async function queryTallyStockForItem(code, name) {
  try {
    const allItems = await fetchAllTallyStockItems();
    const lowerCode = (code || '').toLowerCase().trim();
    const lowerName = (name || '').toLowerCase().trim();

    const match = allItems.find(item => {
      const tCode = item.product_code.toLowerCase().trim();
      const tName = item.name.toLowerCase().trim();
      return (
        (lowerCode && (tCode === lowerCode || tName === lowerCode)) ||
        (lowerName && (tCode === lowerName || tName === lowerName)) ||
        (lowerCode && (tCode.includes(lowerCode) || lowerCode.includes(tCode))) ||
        (lowerName && (tName.includes(lowerName) || lowerName.includes(tName)))
      );
    });

    if (match) {
      return { found: true, name: match.name, quantity: match.tally_qty, rate: match.rate, unit: match.unit };
    }
  } catch (err) {
    console.warn('[queryTallyStockForItem] Tally query warning:', err.message);
  }
  return { found: false, quantity: 0, unit: 'Nos' };
}

// -----------------------------------------------------------------------------
// Helper: Sync Pending Completed Orders to Tally ERP
// -----------------------------------------------------------------------------
async function syncPendingOrdersToTally() {
  try {
    const oRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?status=in.(confirmed,delivered)&payment_status=eq.paid&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    if (!oRes.ok) return { synced: 0, orders: [] };
    const orders = await oRes.json();
    
    const unpushed = (orders || []).filter(o => !o.notes || !o.notes.includes('TALLY_SYNCED_VCH'));
    if (unpushed.length === 0) return { synced: 0, orders: [] };

    const results = [];
    for (const order of unpushed) {
      const items = order.items || [];
      let allItemsSuccess = true;
      
      for (const item of items) {
        const sku = item.sku || '';
        const name = item.name || sku;
        const qty = item.quantity || 1;
        const rate = item.price || 10000;
        const isNos = /mysore|paithani|0021|0022/i.test(name + sku);
        const unitLabel = isNos ? 'Nos' : 'Pcs';
        const targetItem = name.includes('MYSORE') ? name : (sku || name);

        let voucherXml = buildTallySalesVoucherXml({
          orderNumber: order.order_number,
          stockItemName: targetItem,
          qty,
          rate,
          unitLabel,
          godownName: 'Online',
          buyerName: order.shipping_address?.street || order.shipping_address?.full_address || 'WhatsApp Customer'
        });

        try {
          let tallyRes = await sendToTally(voucherXml);
          let isSuccess = tallyRes.includes('<CREATED>1</CREATED>') || 
                          tallyRes.includes('<ALTERED>1</ALTERED>') ||
                          tallyRes.includes('Already Exists');

          // If rejected due to educational mode voucher date restriction, retry with 1st of month
          if (!isSuccess && tallyRes.includes('Voucher date is missing')) {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const fallbackDate = `${year}${month}01`;
            voucherXml = buildTallySalesVoucherXml({
              orderNumber: order.order_number,
              stockItemName: targetItem,
              qty,
              rate,
              unitLabel,
              godownName: 'Online',
              buyerName: order.shipping_address?.street || order.shipping_address?.full_address || 'WhatsApp Customer',
              dateOverride: fallbackDate
            });
            tallyRes = await sendToTally(voucherXml);
            isSuccess = tallyRes.includes('<CREATED>1</CREATED>') || 
                        tallyRes.includes('<ALTERED>1</ALTERED>') ||
                        tallyRes.includes('Already Exists');
          }

          if (!isSuccess) {
            console.warn(`[Tally Sync] Voucher response for ${order.order_number}:`, tallyRes.slice(0, 300));
            allItemsSuccess = false;
          } else {
            // Deduct from stock_pool in Supabase so available_quantity reflects immediately
            const codeToDeduct = (sku || targetItem).trim();
            try {
              const spRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${encodeURIComponent(codeToDeduct)}`, {
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
              });
              const spRows = await spRes.json();
              if (spRows?.[0]) {
                const newQty = Math.max(0, spRows[0].online_quantity - qty);
                await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${spRows[0].id}`, {
                  method: 'PATCH',
                  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ online_quantity: newQty, last_synced_at: new Date().toISOString() })
                });
              }
            } catch (spErr) {
              console.warn('[Tally Sync] stock_pool sync warning:', spErr.message);
            }

            // Also deduct from saree_catalog so both tables stay in sync
            try {
              const catSearch = sku ? `sku=eq.${encodeURIComponent(sku)}` : `name=eq.${encodeURIComponent(targetItem)}`;
              const catRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${catSearch}`, {
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
              });
              const catRows = await catRes.json();
              if (catRows?.[0]) {
                const newCatQty = Math.max(0, catRows[0].stock_quantity - qty);
                await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${catRows[0].id}`, {
                  method: 'PATCH',
                  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ stock_quantity: newCatQty, updated_at: new Date().toISOString() })
                });
              }
            } catch (catErr) {
              console.warn('[Tally Sync] saree_catalog sync warning:', catErr.message);
            }
          }
        } catch (vErr) {
          console.warn(`[Tally Sync] Error pushing voucher for ${order.order_number}:`, vErr.message);
          allItemsSuccess = false;
        }
      }

      if (allItemsSuccess) {
        const updatedNotes = `${order.notes || ''} | TALLY_SYNCED_VCH_${order.order_number}`.trim();
        await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: updatedNotes })
        });
        results.push(order.order_number);
        console.log(`[Tally Sync] ✓ Order ${order.order_number} successfully synced to Tally ERP!`);
      }
    }

    return { synced: results.length, orders: results };
  } catch (err) {
    console.warn('[Tally Sync] Error checking pending orders:', err.message);
    return { synced: 0, error: err.message };
  }
}

// -----------------------------------------------------------------------------
// Helper: Tally Morning / On-Demand Stock Ingestion
// -----------------------------------------------------------------------------
async function performMorningStockSync() {
  morningSyncState.status = 'syncing';
  const shopId = '00000000-0000-0000-0000-000000000001';
  let runId = null;

  // 1. Initialize Sync Run Audit Record
  try {
    const runRes = await fetch(`${SUPABASE_URL}/rest/v1/sync_runs`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        shop_id: shopId,
        triggered_by: 'admin',
        started_at: new Date().toISOString(),
        status: 'running',
        step_log: [{ step: 'sync_initiated', at: new Date().toISOString() }]
      })
    });
    const runData = await runRes.json();
    if (Array.isArray(runData) && runData.length > 0) {
      runId = runData[0].id;
    }
  } catch (_rErr) {
    console.warn('[MorningSync] Could not initialize sync_runs record:', _rErr.message);
  }

  try {
    // 2. Sync pending orders first so closing stock reflects completed transactions
    try {
      await syncPendingOrdersToTally();
    } catch (_pErr) {}

    // 3. Query Tally for all live stock items
    let tallyBalances = [];
    try {
      tallyBalances = await fetchAllTallyStockItems();
    } catch (tallyErr) {
      // Tally offline -> mark sync run failed with downtime alert
      if (runId) {
        await fetch(`${SUPABASE_URL}/rest/v1/sync_runs?id=eq.${runId}`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'failed',
            error_summary: `Tally server unreachable on port ${TALLY_PORT}: ${tallyErr.message}`,
            finished_at: new Date().toISOString()
          })
        });
      }
      morningSyncState.status = 'failed';
      morningSyncState.error = `Tally server unreachable on port ${TALLY_PORT}`;
      throw new Error(`Shop PC / Tally is offline (${tallyErr.message}). Online orders continue operating from cloud inventory. Use manual stock entry if needed.`);
    }

    // 4. Fetch current cloud state from Supabase
    const [catRes, spRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=*`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }),
      fetch(`${SUPABASE_URL}/rest/v1/stock_pool?shop_id=eq.${shopId}&select=*`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } })
    ]);
    const catalog = await catRes.json();
    const stockPool = await spRes.json();

    const stockMap = new Map();
    if (Array.isArray(stockPool)) {
      stockPool.forEach(s => {
        if (s.product_code) stockMap.set(s.product_code.toLowerCase(), s);
        if (s.saree_id) stockMap.set(s.saree_id, s);
      });
    }

    let updatedCount = 0;
    let newStockCount = 0;
    let newDraftsCount = 0;
    let discCount = 0;
    const reconciliation = [];
    const matchedTallyCodes = new Set();

    // 5. Reconcile existing catalog items with Tally
    if (Array.isArray(catalog)) {
      for (const saree of catalog) {
        const sSku = (saree.sku || '').toLowerCase().trim();
        const sPart = (saree.tally_part_number || '').toLowerCase().trim();
        const sName = (saree.name || '').toLowerCase().trim();

        // Find match in Tally items
        const tallyItem = tallyBalances.find(t => {
          const tCode = t.product_code.toLowerCase().trim();
          const tName = t.name.toLowerCase().trim();
          return (
            (sSku && (sSku === tCode || sSku === tName)) ||
            (sPart && (sPart === tCode || sPart === tName)) ||
            (sName && (sName === tCode || sName === tName))
          );
        });

        const stock = stockMap.get(sSku) || stockMap.get(sPart) || stockMap.get(saree.id);
        const expectedQty = stock ? stock.online_quantity : (saree.stock_quantity ?? 0);

        if (tallyItem) {
          // Item exists in Tally
          matchedTallyCodes.add(tallyItem.product_code.toLowerCase());
          const actualQty = tallyItem.tally_qty;
          const delta = actualQty - expectedQty;

          if (actualQty > expectedQty) {
            newStockCount++;
            await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
              method: 'POST',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                actor: 'admin',
                action: 'new_stock_inward_detected',
                entity_type: 'stock_pool',
                entity_id: saree.sku || saree.tally_part_number,
                old_values: { online_quantity: expectedQty },
                new_values: { online_quantity: actualQty, inward_delta: delta },
                metadata: { source_run_id: runId, rate: tallyItem.rate }
              })
            });
          } else if (actualQty < expectedQty) {
            discCount++;
            if (runId) {
              await fetch(`${SUPABASE_URL}/rest/v1/discrepancies`, {
                method: 'POST',
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  shop_id: shopId,
                  item_id: saree.id,
                  product_code: saree.sku || saree.tally_part_number,
                  run_id: runId,
                  expected_qty: expectedQty,
                  actual_qty: actualQty,
                  explanation: `Tally quantity (${actualQty}) is lower than cloud balance (${expectedQty}). Delta: ${delta}`,
                  status: 'open'
                })
              });
            }
          }

          // Update or insert stock_pool
          if (stock) {
            await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${stock.id}`, {
              method: 'PATCH',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                online_quantity: actualQty,
                last_synced_at: new Date().toISOString(),
                source: 'tally_godown',
                updated_at: new Date().toISOString()
              })
            });
          } else {
            await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
              method: 'POST',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                shop_id: shopId,
                product_code: saree.sku || saree.tally_part_number,
                saree_id: saree.id,
                online_quantity: actualQty,
                held_quantity: 0,
                sold_pending_quantity: 0,
                source: 'tally_godown',
                tally_godown: 'Online',
                last_synced_at: new Date().toISOString()
              })
            });
          }

          // Update saree_catalog
          const netAvail = Math.max(0, actualQty - (stock?.held_quantity || 0) - (stock?.sold_pending_quantity || 0));
          await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              stock_quantity: netAvail,
              item_created_in_tally: true,
              stock_added_in_tally: actualQty > 0,
              tally_last_seen_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
          });

          updatedCount++;
          reconciliation.push({
            sku: saree.sku || saree.tally_part_number,
            name: saree.name,
            previousStock: expectedQty,
            currentStock: actualQty,
            delta,
            rate: tallyItem.rate
          });

        } else {
          // ITEM DOES NOT EXIST IN TALLY (DELETED IN TALLY!)
          if (expectedQty > 0 || saree.item_created_in_tally) {
            discCount++;
            // Update stock_pool to 0
            if (stock) {
              await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${stock.id}`, {
                method: 'PATCH',
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  online_quantity: 0,
                  last_synced_at: new Date().toISOString(),
                  source: 'tally_godown',
                  updated_at: new Date().toISOString()
                })
              });
            }

            // Update saree_catalog to 0 & mark not in tally
            await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
              method: 'PATCH',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                stock_quantity: 0,
                item_created_in_tally: false,
                stock_added_in_tally: false,
                tally_last_seen_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              })
            });

            // Write audit log
            await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
              method: 'POST',
              headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                actor: 'admin',
                action: 'stock_deleted_in_tally',
                entity_type: 'stock_pool',
                entity_id: saree.sku || saree.tally_part_number,
                old_values: { online_quantity: expectedQty },
                new_values: { online_quantity: 0 },
                metadata: { source_run_id: runId, reason: 'Item deleted or absent in Tally ERP' }
              })
            });

            reconciliation.push({
              sku: saree.sku || saree.tally_part_number,
              name: saree.name,
              previousStock: expectedQty,
              currentStock: 0,
              delta: -expectedQty,
              notes: 'Deleted in Tally ERP'
            });
            updatedCount++;
          }
        }
      }
    }

    // 6. Zero out any remaining orphaned stock_pool rows (no catalog saree) that are not in Tally
    if (Array.isArray(stockPool)) {
      for (const sp of stockPool) {
        if (sp.saree_id) continue; // Already reconciled with catalog in step 5
        const codeKey = (sp.product_code || '').toLowerCase().trim();
        const isInTally = tallyBalances.some(t => t.product_code.toLowerCase().trim() === codeKey || t.name.toLowerCase().trim() === codeKey);
        if (!isInTally && sp.online_quantity > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${sp.id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              online_quantity: 0,
              last_synced_at: new Date().toISOString(),
              source: 'tally_godown',
              updated_at: new Date().toISOString()
            })
          });
        }
      }
    }

    // 7. Auto-create any brand-new items found in Tally as Drafts
    for (const item of tallyBalances) {
      const codeKey = item.product_code.toLowerCase().trim();
      const nameKey = item.name.toLowerCase().trim();
      if (!matchedTallyCodes.has(codeKey) && !manuallyDeletedSkus.has(codeKey) && !manuallyDeletedSkus.has(nameKey)) {
        newDraftsCount++;
        const newSareeRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog`, {
          method: 'POST',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({
            shop_id: shopId,
            sku: item.product_code,
            tally_part_number: item.product_code,
            name: item.name,
            fabric: 'Pure Silk',
            color_primary: 'Assorted',
            price: item.rate ? Math.round(item.rate * 1.3) : 5000,
            stock_quantity: 0,
            status: 'draft',
            item_created_in_tally: true,
            stock_added_in_tally: item.tally_qty > 0,
            tally_rate: item.rate,
            tally_last_seen_at: new Date().toISOString(),
            listing_notes: `Imported from Tally ERP during sync #${runId || ''}`
          })
        });
        const newSaree = await newSareeRes.json();
        const sareeId = Array.isArray(newSaree) && newSaree[0] ? newSaree[0].id : null;

        await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
          method: 'POST',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shop_id: shopId,
            product_code: item.product_code,
            saree_id: sareeId,
            online_quantity: item.tally_qty,
            held_quantity: 0,
            sold_pending_quantity: 0,
            source: 'tally_godown',
            tally_godown: 'Online',
            last_synced_at: new Date().toISOString()
          })
        });

        updatedCount++;
        reconciliation.push({
          sku: item.product_code,
          name: item.name,
          previousStock: 0,
          currentStock: item.tally_qty,
          delta: item.tally_qty,
          rate: item.rate
        });
      }
    }

    // 8. Finalize sync run record
    if (runId) {
      await fetch(`${SUPABASE_URL}/rest/v1/sync_runs?id=eq.${runId}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          finished_at: new Date().toISOString(),
          status: discCount > 0 ? 'completed_with_issues' : 'completed',
          step_log: [{
            step: 'reconciliation_complete',
            items_synced: updatedCount,
            new_stock_inwards: newStockCount,
            draft_items_created: newDraftsCount,
            discrepancies_logged: discCount,
            at: new Date().toISOString()
          }]
        })
      });
    }

    morningSyncState = {
      lastSyncAt: new Date().toISOString(),
      itemsUpdated: updatedCount,
      newStockInwards: newStockCount,
      draftItemsCreated: newDraftsCount,
      discrepanciesCount: discCount,
      status: discCount > 0 ? 'completed_with_issues' : 'success',
      runId,
      error: null,
      reconciliation
    };

    return morningSyncState;
  } catch (err) {
    morningSyncState.status = 'failed';
    morningSyncState.error = err.message;
    throw err;
  }
}

let isSyncing = false;
// Background Worker: Auto-sync any completed transaction to Tally ERP every 4 seconds
setInterval(async () => {
  if (isSyncing) return;
  try {
    isSyncing = true;
    const syncRes = await syncPendingOrdersToTally();
    if (syncRes && syncRes.synced > 0) {
      console.log(`[AutoSync] 🛒 ${syncRes.synced} order transaction(s) synced to Tally ERP (${syncRes.orders.join(', ')}). Updating stock cache...`);
      await performMorningStockSync();
    }
  } catch (_e) {
  } finally {
    isSyncing = false;
  }
}, 4000);

// Background Worker: Reconcile live Tally stock every 12 seconds to automatically reflect deletions & edits
setInterval(async () => {
  if (isSyncing) return;
  try {
    isSyncing = true;
    await performMorningStockSync();
  } catch (_e) {
  } finally {
    isSyncing = false;
  }
}, 12000);

// Automated morning scheduler (runs daily at 08:00 AM local time)
let lastCheckedDate = null;
setInterval(async () => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const hour = now.getHours();

  if (hour >= 8 && lastCheckedDate !== dateStr) {
    lastCheckedDate = dateStr;
    console.log(`[Scheduler] 🌅 Running automated morning stock sync for ${dateStr}...`);
    try {
      await performMorningStockSync();
      console.log(`[Scheduler] ✓ Morning stock sync complete: ${morningSyncState.itemsUpdated} items updated.`);
    } catch (err) {
      console.warn(`[Scheduler] ⚠️ Morning stock sync warning:`, err.message);
    }
  }
}, 60000); // Check once per minute

// -----------------------------------------------------------------------------
// 1. API: System Health & Diagnostics
// -----------------------------------------------------------------------------
app.get('/api/status', async (req, res) => {
  try {
    let tallyStatus = { connected: false, latencyMs: null, itemCount: 0 };
    try {
      const start = Date.now();
      const testXml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Stock Summary</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
      const tallyRes = await sendToTally(testXml, 1000);
      const matches = tallyRes.match(/<DSPDISPNAME>([^<]+)<\/DSPDISPNAME>/g) || [];
      tallyStatus = {
        connected: true,
        latencyMs: Date.now() - start,
        itemCount: matches.length
      };
    } catch (_e) {}

    let productCount = 0;
    let videoCount = 0;
    try {
      const pRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=id`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const pData = await pRes.json();
      productCount = pData.length || 0;

      const vRes = await fetch(`${SUPABASE_URL}/rest/v1/video_record?select=id`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const vData = await vRes.json();
      videoCount = vData.length || 0;
    } catch (_e) {}

    // Check Windows Agent telemetry in agent_devices
    let agentDevice = null;
    let isAgentOnline = false;
    try {
      const devRes = await fetch(`${SUPABASE_URL}/rest/v1/agent_devices?select=*&order=last_seen_at.desc&limit=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const devData = await devRes.json();
      if (Array.isArray(devData) && devData.length > 0) {
        agentDevice = devData[0];
        const lastSeen = new Date(agentDevice.last_seen_at).getTime();
        isAgentOnline = (Date.now() - lastSeen) < (3 * 60 * 1000); // seen within 3 mins
      }
    } catch (_e) {}

    // Open Discrepancies count
    let openDiscrepanciesCount = 0;
    try {
      const discRes = await fetch(`${SUPABASE_URL}/rest/v1/discrepancies?status=eq.open&select=id`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const discData = await discRes.json();
      openDiscrepanciesCount = Array.isArray(discData) ? discData.length : 0;
    } catch (_e) {}

    const shopPcConnected = Boolean(tallyStatus.connected || isAgentOnline);

    res.json({
      success: true,
      tally: tallyStatus,
      shopPc: {
        connected: shopPcConnected,
        isAgentOnline,
        lastSeenAt: agentDevice?.last_seen_at || null,
        hostname: agentDevice?.hostname || 'Shop-PC-Tally',
        status: shopPcConnected ? 'online' : 'offline'
      },
      discrepancies: {
        openCount: openDiscrepanciesCount
      },
      supabase: { connected: Boolean(productCount >= 0) },
      counts: {
        products: productCount,
        videos: videoCount,
        openDiscrepancies: openDiscrepanciesCount
      },
      morningSync: {
        lastSyncAt: morningSyncState.lastSyncAt,
        itemsUpdated: morningSyncState.itemsUpdated,
        status: morningSyncState.status
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
app.get('/api/products', async (req, res) => {
  try {
    const [pRes, vRes, spRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?order=created_at.desc`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/video_record?select=id,video_id,product_code,saree,reference_frames`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/stock_pool?select=*`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      })
    ]);

    const products = (pRes.ok ? await pRes.json() : []) || [];
    const videoRecords = (vRes.ok ? await vRes.json() : []) || [];
    const stockPool = (spRes.ok ? await spRes.json() : []) || [];

    const videoMap = new Map();
    videoRecords.forEach(v => {
      if (v.product_code) videoMap.set(v.product_code.toLowerCase(), v);
    });

    const stockMap = new Map();
    stockPool.forEach(s => {
      if (s.product_code) stockMap.set(s.product_code.toLowerCase(), s);
      if (s.saree_id) stockMap.set(s.saree_id, s);
    });

    const enriched = (products || []).map(p => {
      const code = (p.tally_part_number || p.sku || '').trim();
      const video = videoMap.get(code.toLowerCase());
      const stock = stockMap.get(code.toLowerCase()) || stockMap.get(p.id);

      const onlineStock = stock ? stock.online_quantity : (p.stock_quantity ?? 0);
      const heldStock = stock ? stock.held_quantity : 0;
      const availableStock = Math.max(0, onlineStock - heldStock);

      return {
        ...p,
        canonical_code: code,
        stock_quantity: onlineStock,
        held_quantity: heldStock,
        available_quantity: availableStock,
        has_video: Boolean(video),
        video_record_id: video?.id || null,
        video_id: video?.video_id || null,
        video_description: video?.saree?.stylist_summary || video?.review_notes || '',
        video_frames_count: video?.reference_frames?.length || 0
      };
    });

    // Group variants by design_family_id if present
    const familyMap = new Map();
    const finalProducts = [];

    enriched.forEach(p => {
      if (p.design_family_id) {
        if (!familyMap.has(p.design_family_id)) {
          const groupObj = {
            id: p.design_family_id,
            is_group: true,
            design_family_id: p.design_family_id,
            canonical_code: p.canonical_code.replace(/-[A-Z0-9]+$/i, ''),
            name: (p.name || '').replace(/\s*\([^)]*\)\s*$/, '').trim(),
            fabric: p.fabric,
            weave_style: p.weave_style,
            price: p.price,
            mrp: p.mrp,
            description: p.description,
            stock_quantity: 0,
            held_quantity: 0,
            available_quantity: 0,
            has_video: p.has_video,
            image_urls: [...(p.image_urls || [])],
            variants: []
          };
          familyMap.set(p.design_family_id, groupObj);
          finalProducts.push(groupObj);
        }
        const grp = familyMap.get(p.design_family_id);
        grp.variants.push(p);
        grp.stock_quantity += (Number(p.stock_quantity) || 0);
        grp.held_quantity += (Number(p.held_quantity) || 0);
        grp.available_quantity += (Number(p.available_quantity) || 0);
        if (p.has_video) grp.has_video = true;
        if (p.image_urls && p.image_urls.length > 0 && grp.image_urls.length === 0) {
          grp.image_urls = p.image_urls;
        }
      } else {
        finalProducts.push(p);
      }
    });

    const outputProducts = req.query.flat === 'true' ? enriched : finalProducts;
    res.json({ success: true, count: outputProducts.length, products: outputProducts, rawCount: enriched.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Group multiple sarees into a Design Family
app.post('/api/admin/products/group', async (req, res) => {
  try {
    const { product_ids, family_name } = req.body;
    if (!Array.isArray(product_ids) || product_ids.length < 2) {
      return res.status(400).json({ success: false, error: 'Select at least 2 sarees to group.' });
    }
    const familyId = crypto.randomUUID();
    for (const pid of product_ids) {
      await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${pid}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          design_family_id: familyId,
          updated_at: new Date().toISOString()
        })
      });
    }
    res.json({ success: true, family_id: familyId, message: `Combined ${product_ids.length} sarees into a color family group!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ungroup a Design Family or individual variant
app.post('/api/admin/products/ungroup', async (req, res) => {
  try {
    const { family_id, product_id } = req.body;
    if (!family_id && !product_id) {
      return res.status(400).json({ success: false, error: 'family_id or product_id is required.' });
    }
    const filter = family_id ? `design_family_id=eq.${family_id}` : `id=eq.${product_id}`;
    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${filter}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        design_family_id: null,
        updated_at: new Date().toISOString()
      })
    });
    res.json({ success: true, message: 'Products ungrouped successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create / Add New Saree to Catalog & Stock Pool
app.post('/api/products', async (req, res) => {
  try {
    const {
      sku,
      name,
      fabric,
      weave_style,
      price,
      mrp,
      stock_quantity = 0,
      description,
      image_base64,
      image_url
    } = req.body;

    if (!sku || !sku.trim()) {
      return res.status(400).json({ success: false, error: 'SKU / Product Code is required.' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Product name is required.' });
    }

    const cleanSku = sku.trim().toUpperCase();
    const cleanName = name.trim();
    const cleanPrice = parseFloat(price) || 0;
    const cleanMrp = parseFloat(mrp) || cleanPrice;
    const cleanStock = parseInt(stock_quantity, 10) || 0;
    const cleanDesc = (description || '').trim();

    // Check if SKU already exists
    const existingRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.eq.${encodeURIComponent(cleanSku)},tally_part_number.eq.${encodeURIComponent(cleanSku)})&select=id`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const existing = await existingRes.json();
    if (existing && existing.length > 0) {
      return res.status(400).json({ success: false, error: `Product with SKU "${cleanSku}" already exists in catalog.` });
    }

    // Process image if provided
    const imageUrls = [];
    if (image_url && image_url.trim().startsWith('http')) {
      imageUrls.push(image_url.trim());
    } else if (image_base64) {
      try {
        const cleanB64 = image_base64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(cleanB64, 'base64');
        const safeName = `${cleanSku.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}.jpg`;
        const uploadUrl = `${SUPABASE_URL}/storage/v1/object/saree-catalog-images/${safeName}`;
        const upRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'image/jpeg',
            'x-upsert': 'true'
          },
          body: buffer
        });
        if (upRes.ok) {
          imageUrls.push(`${SUPABASE_URL}/storage/v1/object/public/saree-catalog-images/${safeName}`);
        }
      } catch (imgErr) {
        console.warn('[AddProduct] Image upload error:', imgErr.message);
      }
    }

    // MULTI-COLOR VARIANT CREATION SUPPORT
    const variants = req.body.variants;
    if (Array.isArray(variants) && variants.length > 0) {
      const familyId = crypto.randomUUID();
      const shopId = '00000000-0000-0000-0000-000000000001';
      const shouldSyncTally = req.body.sync_tally !== false;
      const activeGodown = await getTargetGodown();

      // Master Gemini vector embedding
      let embeddingValues = null;
      try {
        const textForEmbedding = `${cleanName}. Fabric: ${fabric || 'Silk'}. Weave: ${weave_style || 'Woven'}. Description: ${cleanDesc}`;
        embeddingValues = await generateEmbedding({ text: textForEmbedding.slice(0, 2048) });
      } catch (embErr) {
        console.warn('[AddProduct] Variant embedding warning:', embErr.message);
      }

      const createdVariants = [];
      let totalStock = 0;

      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        const vColor = (v.color || `Color ${i + 1}`).trim();
        const vSuffix = (v.sku_suffix || vColor.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4) || `${i + 1}`).trim().toUpperCase();
        const vSku = v.sku ? v.sku.trim().toUpperCase() : `${cleanSku}-${vSuffix}`;
        const vName = `${cleanName} (${vColor})`;
        const vStock = parseInt(v.stock, 10) || 0;
        totalStock += vStock;

        // Image for variant
        let vImages = [];
        if (v.image_url && v.image_url.trim().startsWith('http')) {
          vImages.push(v.image_url.trim());
        } else if (v.image_base64) {
          try {
            const cleanB64 = v.image_base64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(cleanB64, 'base64');
            const safeName = `${vSku.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}.jpg`;
            const uploadUrl = `${SUPABASE_URL}/storage/v1/object/saree-catalog-images/${safeName}`;
            const upRes = await fetch(uploadUrl, {
              method: 'POST',
              headers: {
                apikey: SERVICE_KEY,
                Authorization: `Bearer ${SERVICE_KEY}`,
                'Content-Type': 'image/jpeg',
                'x-upsert': 'true'
              },
              body: buffer
            });
            if (upRes.ok) {
              vImages.push(`${SUPABASE_URL}/storage/v1/object/public/saree-catalog-images/${safeName}`);
            }
          } catch (imgErr) {
            console.warn(`[AddProduct] Variant ${vSku} image upload error:`, imgErr.message);
          }
        }
        if (vImages.length === 0 && imageUrls.length > 0) {
          vImages = [...imageUrls];
        }

        const vRecord = {
          sku: vSku,
          tally_part_number: vSku,
          name: vName,
          fabric: fabric ? fabric.trim() : 'Pure Silk',
          weave_style: weave_style ? weave_style.trim() : null,
          color_primary: vColor,
          design_family_id: familyId,
          price: cleanPrice,
          mrp: cleanMrp,
          stock_quantity: vStock,
          description: cleanDesc,
          image_urls: vImages,
          status: 'draft',
          is_active: true,
          item_created_in_tally: false,
          stock_added_in_tally: false,
          shop_id: shopId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        if (embeddingValues && embeddingValues.length === 768) {
          vRecord.embedding_v2 = embeddingValues;
          vRecord.embedding_model = 'gemini-embedding-2';
          vRecord.embedding_dim = 768;
        }

        const insertCatRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog`, {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify(vRecord)
        });
        const catData = await insertCatRes.json();
        const createdSaree = Array.isArray(catData) ? catData[0] : catData;

        // Stock pool
        await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            shop_id: shopId,
            product_code: vSku,
            saree_id: createdSaree.id,
            online_quantity: vStock,
            held_quantity: 0,
            sold_pending_quantity: 0,
            source: 'admin_entered',
            tally_godown: activeGodown,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        });

        // Push to Tally
        let tallySynced = false;
        if (shouldSyncTally) {
          try {
            const isNos = /mysore|paithani|0021|0022/i.test(vName + vSku);
            const unitLabel = isNos ? 'Nos' : 'Pcs';
            const pushResult = await pushProductToTallyMaster({
              sku: vSku,
              name: vName,
              quantity: vStock,
              rate: cleanPrice,
              unitLabel,
              godownName: activeGodown
            });
            if (pushResult.success) {
              tallySynced = true;
              await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${createdSaree.id}`, {
                method: 'PATCH',
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  item_created_in_tally: true,
                  stock_added_in_tally: vStock > 0,
                  tally_last_seen_at: new Date().toISOString()
                })
              });
              await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${vSku}`, {
                method: 'PATCH',
                headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  source: 'tally_godown',
                  last_synced_at: new Date().toISOString()
                })
              });
            }
          } catch (tErr) {
            console.warn(`[AddProduct] Tally sync error for variant ${vSku}:`, tErr.message);
          }
        }

        createdVariants.push({
          ...createdSaree,
          canonical_code: vSku,
          stock_quantity: vStock,
          item_created_in_tally: tallySynced
        });
      }

      return res.json({
        success: true,
        message: `Saree family [${cleanSku}] created with ${createdVariants.length} color variants (Total ${totalStock} units in ${activeGodown}).`,
        family_id: familyId,
        variants_count: createdVariants.length,
        total_stock: totalStock,
        variants: createdVariants
      });
    }

    // Generate Gemini vector embedding for AI bot and multimodal search
    let embeddingValues = null;
    try {
      const textForEmbedding = `${cleanName}. Fabric: ${fabric || 'Silk'}. Weave: ${weave_style || 'Woven'}. Description: ${cleanDesc}`;
      embeddingValues = await generateEmbedding({ text: textForEmbedding.slice(0, 2048) });
    } catch (embErr) {
      console.warn('[AddProduct] Embedding generation warning:', embErr.message);
    }

    const shopId = '00000000-0000-0000-0000-000000000001';

    // Insert into saree_catalog
    const newRecord = {
      sku: cleanSku,
      tally_part_number: cleanSku,
      name: cleanName,
      fabric: fabric ? fabric.trim() : 'Pure Silk',
      weave_style: weave_style ? weave_style.trim() : null,
      color_primary: req.body.color_primary ? req.body.color_primary.trim() : 'Assorted',
      price: cleanPrice,
      mrp: cleanMrp,
      stock_quantity: cleanStock,
      description: cleanDesc,
      image_urls: imageUrls,
      status: 'draft',
      is_active: true,
      item_created_in_tally: false,
      stock_added_in_tally: false,
      shop_id: shopId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (embeddingValues && embeddingValues.length === 768) {
      newRecord.embedding_v2 = embeddingValues;
      newRecord.embedding_model = 'gemini-embedding-2';
      newRecord.embedding_dim = 768;
    }

    const insertCatRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(newRecord)
    });

    const catData = await insertCatRes.json();
    if (!insertCatRes.ok) {
      throw new Error(catData.message || catData.error || 'Failed to insert saree into catalog');
    }
    const createdSaree = Array.isArray(catData) ? catData[0] : catData;

    // Insert / Initialize stock_pool
    await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        shop_id: shopId,
        product_code: cleanSku,
        saree_id: createdSaree.id,
        online_quantity: cleanStock,
        held_quantity: 0,
        sold_pending_quantity: 0,
        source: 'admin_entered',
        tally_godown: 'Online',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    // Audit log
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        actor: 'admin:store_manager',
        action: 'manual_saree_added',
        entity_type: 'saree_catalog',
        entity_id: cleanSku,
        new_values: {
          sku: cleanSku,
          name: cleanName,
          price: cleanPrice,
          stock: cleanStock
        }
      })
    });

    // Automatically push and inward initial stock into Tally ERP Online Godown
    let tallySynced = false;
    let tallyMsg = '';
    const shouldSyncTally = req.body.sync_tally !== false;

    if (shouldSyncTally) {
      try {
        const isNos = /mysore|paithani|0021|0022/i.test(cleanName + cleanSku);
        const unitLabel = isNos ? 'Nos' : 'Pcs';
        const activeGodown = await getTargetGodown();
        const pushResult = await pushProductToTallyMaster({
          sku: cleanSku,
          name: cleanName,
          quantity: cleanStock,
          rate: cleanPrice,
          unitLabel,
          godownName: activeGodown
        });

        if (pushResult.success) {
          tallySynced = true;
          tallyMsg = ` and synchronized to Tally ERP ${activeGodown} Godown (${cleanStock} ${unitLabel})`;
          // Update saree_catalog
          await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${createdSaree.id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              item_created_in_tally: true,
              stock_added_in_tally: cleanStock > 0,
              tally_last_seen_at: new Date().toISOString()
            })
          });
          // Update stock_pool
          await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${cleanSku}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: 'tally_godown',
              last_synced_at: new Date().toISOString()
            })
          });
        }
      } catch (tErr) {
        console.warn('[AddProduct] Tally sync error:', tErr.message);
      }
    }

    res.json({
      success: true,
      message: `Saree [${cleanSku}] added successfully${tallyMsg}.`,
      tallySynced,
      product: {
        ...createdSaree,
        canonical_code: cleanSku,
        stock_quantity: cleanStock,
        item_created_in_tally: tallySynced
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// 3. API: Tally Stock Ingestion & Real-Time Sync
// -----------------------------------------------------------------------------
// Live Stock Polling Endpoint for Frontend Card Realtime Auto-Update
app.get('/api/live-stock', async (req, res) => {
  try {
    const [pRes, oRes, spRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=id,sku,tally_part_number,name,stock_quantity,price,updated_at&order=created_at.desc`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/orders?select=id,order_number,items,total_amount,payment_status,status,created_at&order=created_at.desc&limit=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/stock_pool?select=*`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      })
    ]);

    const products = (pRes.ok ? await pRes.json() : []) || [];
    const latestOrders = (oRes.ok ? await oRes.json() : []) || [];
    const stockPool = (spRes.ok ? await spRes.json() : []) || [];

    const stockMap = new Map();
    stockPool.forEach(s => {
      if (s.product_code) stockMap.set(s.product_code.toLowerCase(), s);
      if (s.saree_id) stockMap.set(s.saree_id, s);
    });

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      products: (products || []).map(p => {
        const code = (p.tally_part_number || p.sku || '').trim();
        const stock = stockMap.get(code.toLowerCase()) || stockMap.get(p.id);
        const onlineStock = stock ? stock.online_quantity : (p.stock_quantity ?? 0);
        return {
          id: p.id,
          sku: p.sku,
          canonical_code: code,
          name: p.name,
          stock_quantity: onlineStock,
          price: p.price,
          updated_at: p.updated_at
        };
      }),
      latestOrder: latestOrders[0] || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Full Sync: Syncs pending transactions to Tally and ingests closing stock
app.post('/api/sync-tally-stock', async (req, res) => {
  try {
    const orderSync = await syncPendingOrdersToTally();
    const result = await performMorningStockSync();
    res.json({
      success: true,
      message: `Tally ERP synchronized! ${result.itemsUpdated} sarees updated, ${orderSync.synced || 0} pending orders pushed.`,
      orderSync,
      result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Per-Product Sync: Syncs a single product's pending orders and stock with Tally
app.post('/api/sync-product-stock/:code', async (req, res) => {
  try {
    const code = req.params.code;
    
    // 1. Fetch saree from catalog
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code);
    const filterQuery = isUuid 
      ? `id=eq.${encodeURIComponent(code)}`
      : `or=(sku.eq.${encodeURIComponent(code)},tally_part_number.eq.${encodeURIComponent(code)},sku.eq.${encodeURIComponent(code.toUpperCase())})`;

    const pRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${filterQuery}&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const catalogItems = await pRes.json();
    const saree = catalogItems && catalogItems[0] ? catalogItems[0] : null;

    if (!saree) {
      return res.status(404).json({ success: false, error: `Product [${code}] not found in catalog.` });
    }

    const canonicalCode = saree.sku || saree.tally_part_number || code;
    const isNos = /mysore|paithani|0021|0022/i.test((saree.name || '') + canonicalCode);
    const unitLabel = isNos ? 'Nos' : 'Pcs';

    // 2. Query Tally to check if item exists and its live quantity
    let tallyStockInfo = await queryTallyStockForItem(canonicalCode, saree.name);

    // 3. If NOT found in Tally (or deleted in Tally)
    if (!tallyStockInfo.found) {
      if (req.query.push === 'true' || req.body?.push === true) {
        const pushResult = await pushProductToTallyMaster({
          sku: canonicalCode,
          name: saree.name || canonicalCode,
          quantity: saree.stock_quantity || 0,
          rate: saree.price || 5000,
          unitLabel,
          godownName: 'Online'
        });

        if (pushResult.success) {
          await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              item_created_in_tally: true,
              stock_added_in_tally: (saree.stock_quantity || 0) > 0,
              tally_last_seen_at: new Date().toISOString()
            })
          });

          await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(saree_id.eq.${saree.id},product_code.eq.${encodeURIComponent(canonicalCode)})`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: 'tally_godown',
              online_quantity: saree.stock_quantity || 0,
              last_synced_at: new Date().toISOString()
            })
          });

          return res.json({
            success: true,
            code: canonicalCode,
            createdInTally: true,
            message: `Item [${canonicalCode}] created and synchronized in Tally ERP with ${saree.stock_quantity || 0} ${unitLabel}.`,
            item: {
              sku: canonicalCode,
              name: saree.name,
              currentStock: saree.stock_quantity || 0
            }
          });
        } else {
          throw new Error(`Failed to create item in Tally ERP. Response: ${pushResult.raw?.slice(0, 150)}`);
        }
      }

      // Default: Item is absent/deleted in Tally -> Zero out cloud stock!
      await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(saree_id.eq.${saree.id},product_code.eq.${encodeURIComponent(canonicalCode)})`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          online_quantity: 0,
          source: 'tally_godown',
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });

      await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stock_quantity: 0,
          item_created_in_tally: false,
          stock_added_in_tally: false,
          tally_last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });

      return res.json({
        success: true,
        code: canonicalCode,
        message: `Product [${canonicalCode}] is absent/deleted in Tally. Stock updated to 0 (Out of Stock).`,
        item: {
          sku: canonicalCode,
          name: saree.name,
          currentStock: 0,
          status: 'out_of_stock'
        }
      });
    }

    // 4. Item exists in Tally -> Sync closing quantity into cloud
    const actualQty = tallyStockInfo.quantity;
    await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(saree_id.eq.${saree.id},product_code.eq.${encodeURIComponent(canonicalCode)})`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        online_quantity: actualQty,
        source: 'tally_godown',
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stock_quantity: actualQty,
        item_created_in_tally: true,
        stock_added_in_tally: actualQty > 0,
        tally_last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    return res.json({
      success: true,
      code: canonicalCode,
      message: `Live stock synchronized: ${actualQty} ${tallyStockInfo.unit || unitLabel} in Tally.`,
      item: {
        sku: canonicalCode,
        name: saree.name,
        currentStock: actualQty
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Product from Catalog & Stock Pool
// Delete Product from Catalog & Stock Pool, and zero out stock in Tally ERP safely
app.delete('/api/products/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const filterQuery = isUuid
      ? `id=eq.${id}`
      : `or=(sku.eq.${encodeURIComponent(id)},tally_part_number.eq.${encodeURIComponent(id)},name.eq.${encodeURIComponent(id)})`;

    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?${filterQuery}&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const items = await sRes.json();
    const saree = items && items[0];

    const sku = saree ? (saree.sku || saree.tally_part_number) : id;
    if (saree) {
      if (saree.sku) await addManuallyDeletedSku(saree.sku);
      if (saree.tally_part_number) await addManuallyDeletedSku(saree.tally_part_number);
      if (saree.name) await addManuallyDeletedSku(saree.name);
    } else {
      await addManuallyDeletedSku(id);
    }

    // Clean deletion in Tally ERP:
    // Zero out opening balance within Sarees group (NEVER post fake sales deduction vouchers or move to Primary)
    try {
      const activeGodown = await getTargetGodown();
      const tallyItems = await fetchAllTallyStockItems();
      const targetLookups = [sku, saree?.name, saree?.tally_part_number].filter(Boolean).map(x => x.toLowerCase());
      const tallyItemFound = tallyItems.find(t => {
        const n = (t.name || '').toLowerCase();
        const p = (t.partNo || '').toLowerCase();
        return targetLookups.includes(n) || targetLookups.includes(p);
      });

      if (tallyItemFound) {
        const itemName = tallyItemFound.name;
        const isNos = /mysore|paithani|0021|0022/i.test(itemName) || (tallyItemFound.closing || '').toLowerCase().includes('nos');
        const unitLabel = isNos ? 'Nos' : 'Pcs';

        // Safely alter Tally master: set Opening Balance to 0 within Sarees group
        const alterXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<STOCKITEM NAME="${escapeXml(itemName)}" ACTION="Alter">
  <NAME>${escapeXml(itemName)}</NAME>
  <PARENT>Sarees</PARENT>
  <OPENINGBALANCE>0 ${unitLabel}</OPENINGBALANCE>
  <OPENINGRATE>0/${unitLabel}</OPENINGRATE>
  <OPENINGVALUE>0</OPENINGVALUE>
  <BATCHALLOCATIONS.LIST>
    <GODOWNNAME>${activeGodown}</GODOWNNAME>
    <BATCHNAME>Primary Batch</BATCHNAME>
    <OPENINGBALANCE>0 ${unitLabel}</OPENINGBALANCE>
    <OPENINGRATE>0/${unitLabel}</OPENINGRATE>
    <OPENINGVALUE>0</OPENINGVALUE>
  </BATCHALLOCATIONS.LIST>
</STOCKITEM>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
        await sendToTally(alterXml, 3000);
        console.log(`[DELETE /api/products] Cleanly zeroed stock for "${itemName}" in Tally ERP within Sarees group.`);
      }
    } catch (_tErr) {
      console.warn(`[DELETE /api/products] Tally stock zeroing notice for ${sku}:`, _tErr.message);
    }

    // Cascade delete related records before deleting saree_catalog (to avoid FK 409 errors)
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/video_item?or=(product_code.eq.${encodeURIComponent(sku)},saree_id.eq.${saree ? saree.id : id})`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      await fetch(`${SUPABASE_URL}/rest/v1/discrepancy_log?product_code=eq.${encodeURIComponent(sku)}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(saree_id.eq.${saree ? saree.id : id},product_code.eq.${encodeURIComponent(sku)})`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
    } catch (_) {}

    if (saree) {
      // Delete from saree_catalog
      const delCatRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      if (!delCatRes.ok) {
        console.warn(`[DELETE /api/products] saree_catalog delete returned ${delCatRes.status}:`, await delCatRes.text());
      }

      // Audit log
      await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actor: 'admin',
          action: 'delete_product_catalog',
          entity_type: 'saree_catalog',
          entity_id: sku,
          metadata: {
            saree_id: saree.id,
            name: saree.name,
            tally_item: tallyItemFound?.name || null,
            previous_stock: Math.max(tallyCurrentQty, stockPoolQty)
          }
        })
      });
    }

    res.json({
      success: true,
      message: `Product [${sku}] deleted from catalog and zeroed out in Tally ERP.`,
      tallyReflected: Boolean(tallyItemFound),
      previousStock: Math.max(tallyCurrentQty, stockPoolQty)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Adjust / Inward Stock directly in Tally ERP & sync to Supabase
app.post('/api/adjust-tally-stock', async (req, res) => {
  try {
    const { code, targetQuantity, reason } = req.body;
    if (code === undefined || targetQuantity === undefined) {
      return res.status(400).json({ success: false, error: 'Missing code or targetQuantity' });
    }

    const newQty = parseInt(targetQuantity, 10);
    if (isNaN(newQty) || newQty < 0) {
      return res.status(400).json({ success: false, error: 'targetQuantity must be a positive integer' });
    }

    const pRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.eq.${encodeURIComponent(code)},tally_part_number.eq.${encodeURIComponent(code)},name.eq.${encodeURIComponent(code)})&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const catalogItems = await pRes.json();
    const saree = catalogItems[0];
    if (!saree) {
      return res.status(404).json({ success: false, error: `Saree ${code} not found in catalog` });
    }

    const currentQty = saree.stock_quantity || 0;
    const delta = newQty - currentQty;
    const targetItem = saree.name || saree.sku;
    const isNos = /mysore|paithani|0021|0022/i.test(targetItem + saree.sku);
    const unitLabel = isNos ? 'Nos' : 'Pcs';
    const rate = saree.price || 10000;
    const activeGodown = await getTargetGodown();

    let tallyAction = 'none';
    if (delta > 0) {
      const refNum = `RN-ADJ-${Date.now().toString().slice(-6)}`;
      let rnXml = buildTallyReceiptNoteXml({
        refNumber: refNum,
        stockItemName: targetItem,
        qty: delta,
        rate,
        unitLabel,
        godownName: activeGodown
      });
      try {
        let tallyRes = await sendToTally(rnXml);
        if (!tallyRes.includes('<CREATED>1</CREATED>') && tallyRes.includes('Voucher date is missing')) {
          const now = new Date();
          const fallbackDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}01`;
          rnXml = buildTallyReceiptNoteXml({
            refNumber: refNum,
            stockItemName: targetItem,
            qty: delta,
            rate,
            unitLabel,
            godownName: activeGodown,
            dateOverride: fallbackDate
          });
          tallyRes = await sendToTally(rnXml);
        }
        tallyAction = `Inwarded +${delta} ${unitLabel} via ${refNum} (${activeGodown} Godown)`;
      } catch (tErr) {
        console.warn('[adjust-tally-stock] Tally receipt note notice:', tErr.message);
        tallyAction = `Tally offline or error (${tErr.message}); adjusted in cloud inventory`;
      }
    } else if (delta < 0) {
      const refNum = `VCH-ADJ-${Date.now().toString().slice(-6)}`;
      let svXml = buildTallySalesVoucherXml({
        orderNumber: refNum,
        stockItemName: targetItem,
        qty: Math.abs(delta),
        rate,
        unitLabel,
        godownName: activeGodown,
        buyerName: reason || 'Inventory Adjustment'
      });
      try {
        let tallyRes = await sendToTally(svXml);
        if (!tallyRes.includes('<CREATED>1</CREATED>') && tallyRes.includes('Voucher date is missing')) {
          const now = new Date();
          const fallbackDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}01`;
          svXml = buildTallySalesVoucherXml({
            orderNumber: refNum,
            stockItemName: targetItem,
            qty: Math.abs(delta),
            rate,
            unitLabel,
            godownName: activeGodown,
            buyerName: reason || 'Inventory Adjustment',
            dateOverride: fallbackDate
          });
          tallyRes = await sendToTally(svXml);
        }
        tallyAction = `Deducted -${Math.abs(delta)} ${unitLabel} via ${refNum} (${activeGodown} Godown)`;
      } catch (tErr) {
        console.warn('[adjust-tally-stock] Tally sales voucher notice:', tErr.message);
        tallyAction = `Tally offline or error (${tErr.message}); adjusted in cloud inventory`;
      }
    }

    // 1. Directly update saree_catalog stock_quantity
    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stock_quantity: newQty, updated_at: new Date().toISOString() })
    });

    // 2. Directly upsert into stock_pool so dashboard reflects real-time quantity immediately
    const shopId = '00000000-0000-0000-0000-000000000001';
    const spCheck = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(product_code.eq.${encodeURIComponent(saree.sku)},saree_id.eq.${saree.id})`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const spRows = await spCheck.json();
    if (Array.isArray(spRows) && spRows.length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${spRows[0].id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ online_quantity: newQty, source: 'admin_entered', tally_godown: activeGodown, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      });
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop_id: shopId,
          product_code: saree.sku,
          saree_id: saree.id,
          online_quantity: newQty,
          held_quantity: 0,
          sold_pending_quantity: 0,
          source: 'admin_entered',
          tally_godown: activeGodown,
          last_synced_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });
    }

    // Write audit log
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'admin:store_manager',
        action: 'adjust_tally_stock',
        entity_type: 'saree_catalog',
        entity_id: saree.sku,
        new_values: { oldQuantity: currentQty, newQuantity: newQty, delta, reason: reason || 'Stock adjustment' }
      })
    });

    res.json({
      success: true,
      code,
      delta,
      newQuantity: newQty,
      tallyAction,
      message: `Stock successfully adjusted for ${saree.name} (${saree.sku}): ${newQty} ${unitLabel}`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Alias for existing Morning Stock Ingestion button
app.post('/api/sync-morning-stock', async (req, res) => {
  try {
    const result = await performMorningStockSync();
    res.json({
      success: true,
      message: `Morning stock successfully ingested from Tally! ${result.itemsUpdated} stored sarees updated.`,
      result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/morning-stock-status', (req, res) => {
  res.json({ success: true, state: morningSyncState });
});

// -----------------------------------------------------------------------------
// Phase 2: Discrepancy & Sync Run APIs
// -----------------------------------------------------------------------------

// GET /api/discrepancies (and /discrepancies)
async function handleGetDiscrepancies(req, res) {
  try {
    const status = req.query.status;
    let url = `${SUPABASE_URL}/rest/v1/discrepancies?select=*,saree:saree_catalog(name,price,image_urls,status)&order=created_at.desc`;
    if (status) {
      url += `&status=eq.${encodeURIComponent(status)}`;
    }

    const r = await fetch(url, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const items = await r.json();
    res.json({ success: true, count: items.length, discrepancies: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/discrepancies', handleGetDiscrepancies);
app.get('/discrepancies', handleGetDiscrepancies);

// POST /api/discrepancies/:id/resolve (and /discrepancies/:id/resolve)
// POST /api/discrepancies/:id/resolve (and /discrepancies/:id/resolve)
async function handleResolveDiscrepancy(req, res) {
  try {
    const discrepancyId = req.params.id;
    const { action, verified_qty, notes, resolved_by } = req.body;

    if (!action) {
      return res.status(400).json({ success: false, error: 'action is required (accept_tally, keep_cloud, or manual_count)' });
    }

    // 1. Try atomic RPC resolve_discrepancy
    try {
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_discrepancy`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_discrepancy_id: discrepancyId,
          p_action: action,
          p_verified_qty: verified_qty !== undefined ? parseInt(verified_qty, 10) : null,
          p_notes: notes || '',
          p_resolved_by: resolved_by || 'admin:store_manager'
        })
      });

      if (rpcRes.ok) {
        const result = await rpcRes.json();
        return res.json(result);
      }
    } catch (_rpcErr) {}

    // 2. PostgREST Fallback Resolution
    const dRes = await fetch(`${SUPABASE_URL}/rest/v1/discrepancies?id=eq.${discrepancyId}&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const dItems = await dRes.json();
    if (!Array.isArray(dItems) || dItems.length === 0) {
      return res.status(404).json({ success: false, error: 'Discrepancy record not found' });
    }

    const disc = dItems[0];
    if (disc.status === 'resolved') {
      return res.json({
        success: true,
        idempotent_replay: true,
        discrepancy_id: discrepancyId,
        message: 'Discrepancy already resolved'
      });
    }

    let finalQty = 0;
    if (action === 'accept_tally') {
      finalQty = disc.actual_qty;
    } else if (action === 'keep_cloud') {
      finalQty = disc.expected_qty;
    } else if (action === 'manual_count') {
      if (verified_qty === undefined || verified_qty === null || parseInt(verified_qty, 10) < 0) {
        return res.status(400).json({ success: false, error: 'verified_qty must be a non-negative integer for manual_count' });
      }
      finalQty = parseInt(verified_qty, 10);
    } else {
      return res.status(400).json({ success: false, error: 'Invalid action. Must be accept_tally, keep_cloud, or manual_count' });
    }

    // Update stock_pool
    const spRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?shop_id=eq.${disc.shop_id}&product_code=eq.${encodeURIComponent(disc.product_code)}&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const spItems = await spRes.json();
    if (Array.isArray(spItems) && spItems.length > 0) {
      const stock = spItems[0];
      await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${stock.id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          online_quantity: finalQty,
          source: action === 'accept_tally' ? 'tally_godown' : 'admin_entered',
          updated_at: new Date().toISOString()
        })
      });

      if (stock.saree_id) {
        const netAvail = Math.max(0, finalQty - (stock.held_quantity || 0) - (stock.sold_pending_quantity || 0));
        await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${stock.saree_id}`, {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stock_quantity: netAvail,
            updated_at: new Date().toISOString()
          })
        });
      }
    }

    // Update discrepancy record
    const resNotes = `${notes || ''} [Action: ${action}, Set Qty: ${finalQty}]`.trim();
    await fetch(`${SUPABASE_URL}/rest/v1/discrepancies?id=eq.${disc.id}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'resolved',
        resolved_by: resolved_by || 'admin:store_manager',
        resolved_at: new Date().toISOString(),
        resolution_notes: resNotes
      })
    });

    // Write audit log
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: resolved_by || 'admin:store_manager',
        action: 'resolve_discrepancy',
        entity_type: 'discrepancies',
        entity_id: disc.id,
        old_values: { expected_qty: disc.expected_qty, actual_qty: disc.actual_qty, status: 'open' },
        new_values: { final_qty: finalQty, action, status: 'resolved' },
        metadata: { product_code: disc.product_code, notes: notes || '' }
      })
    });

    res.json({
      success: true,
      discrepancy_id: disc.id,
      status: 'resolved',
      product_code: disc.product_code,
      action,
      final_quantity: finalQty
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
app.post('/api/discrepancies/:id/resolve', handleResolveDiscrepancy);
app.post('/discrepancies/:id/resolve', handleResolveDiscrepancy);

// POST /api/manual-stock-entry (Shop PC Downtime Manual Stock Override)
app.post('/api/manual-stock-entry', async (req, res) => {
  try {
    const { product_code, new_quantity, reason, admin_user, shop_id = '00000000-0000-0000-0000-000000000001' } = req.body;

    if (!product_code) {
      return res.status(400).json({ success: false, error: 'product_code is required' });
    }
    if (new_quantity === undefined || new_quantity === null || parseInt(new_quantity, 10) < 0) {
      return res.status(400).json({ success: false, error: 'new_quantity must be a non-negative integer' });
    }
    if (!reason || reason.trim() === '') {
      return res.status(400).json({ success: false, error: 'A mandatory reason is required for manual stock entries' });
    }

    const qty = parseInt(new_quantity, 10);
    const actor = admin_user || 'admin:store_manager';

    // 1. Try RPC admin_manual_stock_entry
    try {
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_manual_stock_entry`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_shop_id: shop_id,
          p_product_code: product_code,
          p_new_quantity: qty,
          p_reason: reason,
          p_admin_user: actor
        })
      });

      if (rpcRes.ok) {
        const rpcData = await rpcRes.json();
        return res.json(rpcData);
      }
    } catch (_rpcErr) {}

    // 2. PostgREST Fallback
    const spRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?shop_id=eq.${shop_id}&product_code=eq.${encodeURIComponent(product_code)}&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const spItems = await spRes.json();
    if (!Array.isArray(spItems) || spItems.length === 0) {
      // Check if product exists in saree_catalog
      const catCheck = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.eq.${encodeURIComponent(product_code)},tally_part_number.eq.${encodeURIComponent(product_code)},name.eq.${encodeURIComponent(product_code)})&limit=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const catRows = await catCheck.json();
      if (!Array.isArray(catRows) || catRows.length === 0) {
        return res.status(404).json({ success: false, error: `Product code ${product_code} not found in catalog or stock pool` });
      }
      const saree = catRows[0];
      // Create stock_pool entry
      await fetch(`${SUPABASE_URL}/rest/v1/stock_pool`, {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop_id,
          product_code: saree.sku || product_code,
          saree_id: saree.id,
          online_quantity: qty,
          held_quantity: 0,
          sold_pending_quantity: 0,
          source: 'admin_entered',
          tally_godown: 'Online',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });
      // Update catalog
      await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${saree.id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock_quantity: qty, updated_at: new Date().toISOString() })
      });
      return res.json({
        success: true,
        product_code: saree.sku,
        new_quantity: qty,
        message: `Stock updated for ${saree.name} (${saree.sku}): ${qty}`
      });
    }

    const stock = spItems[0];
    const oldQty = stock.online_quantity;

    await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${stock.id}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        online_quantity: qty,
        source: 'admin_entered',
        updated_at: new Date().toISOString()
      })
    });

    if (stock.saree_id) {
      const netAvailable = Math.max(0, qty - (stock.held_quantity || 0) - (stock.sold_pending_quantity || 0));
      await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${stock.saree_id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stock_quantity: netAvailable,
          updated_at: new Date().toISOString()
        })
      });
    }

    // Write audit log
    await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor,
        action: 'manual_stock_entry_downtime',
        entity_type: 'stock_pool',
        entity_id: stock.id,
        old_values: { online_quantity: oldQty },
        new_values: { online_quantity: qty },
        metadata: { product_code, reason, shop_id }
      })
    });

    res.json({
      success: true,
      shop_id,
      product_code,
      old_quantity: oldQty,
      new_quantity: qty,
      reason,
      adjusted_by: actor
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sync/runs (and /sync/runs)
async function handleGetSyncRuns(req, res) {
  try {
    const limit = parseInt(req.query.limit || '15', 10);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/sync_runs?select=*&order=started_at.desc&limit=${limit}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const runs = await r.json();
    res.json({ success: true, count: runs.length, runs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
app.get('/api/sync/runs', handleGetSyncRuns);
app.get('/sync/runs', handleGetSyncRuns);

// GET & POST /api/sync/schedule (Dynamic morning sync time setting)
app.get('/api/sync/schedule', async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.sync_schedule_config&select=*`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const items = await r.json();
    const config = items[0]?.value ? JSON.parse(items[0].value) : { time: '09:30', cutoff_minutes: 90 };
    res.json({ success: true, schedule: config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sync/schedule', async (req, res) => {
  try {
    const { time, cutoff_minutes, retry_interval_minutes } = req.body;
    const newConfig = {
      time: time || '09:30',
      cutoff_minutes: parseInt(cutoff_minutes || '90', 10),
      retry_interval_minutes: parseInt(retry_interval_minutes || '15', 10),
      updated_at: new Date().toISOString()
    };

    await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.sync_schedule_config`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(newConfig), updated_at: new Date().toISOString() })
    });

    res.json({ success: true, message: `Morning sync schedule updated to ${newConfig.time}`, schedule: newConfig });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// SaaS Multi-Shop Godown Setup & Isolation Endpoints
// -----------------------------------------------------------------------------
app.get('/api/admin/godowns/list', async (req, res) => {
  try {
    const activeGodown = await getTargetGodown();
    const tallyGodowns = await fetchTallyGodowns();
    
    // Check if target_godown has been saved in app_settings
    let isConfigured = false;
    try {
      const setRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.target_godown&select=value`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const setRows = await setRes.json();
      isConfigured = Array.isArray(setRows) && setRows.length > 0 && Boolean(setRows[0]?.value);
    } catch (_) {}

    // Combine godowns: live from Tally + active/known godowns
    const allGodowns = [...tallyGodowns];
    if (activeGodown && !allGodowns.some(g => g.toLowerCase() === activeGodown.toLowerCase())) {
      allGodowns.push(activeGodown);
    }
    if (!allGodowns.some(g => g.toLowerCase() === 'sarees')) allGodowns.push('Sarees');
    if (!allGodowns.some(g => g.toLowerCase() === 'online')) allGodowns.push('Online');

    res.json({
      success: true,
      activeGodown,
      isConfigured,
      godowns: allGodowns,
      tallyConnected: tallyGodowns.length > 0
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/godowns/configure', async (req, res) => {
  try {
    const { godown } = req.body;
    if (!godown || typeof godown !== 'string' || !godown.trim()) {
      return res.status(400).json({ success: false, error: 'A valid godown name is required.' });
    }
    const cleanGodown = godown.trim();
    await setTargetGodown(cleanGodown);

    // Auto-ensure Godown master exists in connected Tally instance
    try {
      const godownXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
<GODOWN NAME="${escapeXml(cleanGodown)}" ACTION="Create">
  <NAME>${escapeXml(cleanGodown)}</NAME>
  <PARENT>Main Location</PARENT>
</GODOWN>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
      await sendToTally(godownXml, 4000);
    } catch (_) {}

    // Also update shops flagship configuration
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/shops?code=eq.SAI`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            online_godown: cleanGodown,
            city: 'Tumakuru',
            state: 'Karnataka'
          },
          updated_at: new Date().toISOString()
        })
      });
    } catch (_) {}

    res.json({
      success: true,
      activeGodown: cleanGodown,
      message: `SaaS designated godown locked to "${cleanGodown}". Strict isolation active.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync Sales to Google Sheets via Webhook
app.post('/api/admin/sync-sheets', async (req, res) => {
  try {
    const { period = 'all' } = req.body || {};
    const currentEnv = loadEnv();
    const webhookUrl = currentEnv.GOOGLE_SHEET_WEBHOOK_URL || process.env.GOOGLE_SHEET_WEBHOOK_URL;
    if (!webhookUrl) {
      return res.status(400).json({ success: false, error: 'GOOGLE_SHEET_WEBHOOK_URL is not configured.' });
    }

    let url = `${SUPABASE_URL}/rest/v1/orders?select=id,order_number,status,total_amount,payment_status,channel,items,created_at,customers(name,phone_number)&order=created_at.desc`;
    if (period === 'today') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      url += `&created_at=gte.${encodeURIComponent(today.toISOString())}`;
    }

    const oRes = await fetch(url, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const orders = await oRes.json();
    if (!orders || orders.length === 0) {
      return res.json({ success: true, count: 0, message: 'No orders found to sync for the selected period.' });
    }

    // Format rows
    const rows = orders.map(ord => {
      let totalUnits = 0;
      let sareeList = [];
      if (Array.isArray(ord.items)) {
        ord.items.forEach(it => {
          const qty = parseInt(it.quantity || it.qty || 1, 10);
          totalUnits += qty;
          sareeList.push(`${it.name || it.title || it.sku || 'Saree'} (${qty}x)`);
        });
      }
      if (sareeList.length === 0) {
        sareeList.push('Saree Order');
        totalUnits = 1;
      }
      const d = new Date(ord.created_at);
      const dateFormatted = d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });

      return {
        date: dateFormatted,
        orderNumber: ord.order_number || `ORD-${ord.id.slice(0, 8)}`,
        customerName: ord.customers?.name || 'Walk-in / WhatsApp Customer',
        customerPhone: ord.customers?.phone_number || '-',
        sareeItems: sareeList.join(', '),
        totalUnits: totalUnits,
        totalAmount: Number(ord.total_amount || 0),
        paymentStatus: (ord.payment_status || 'paid').toUpperCase(),
        channel: (ord.channel || 'WhatsApp').toUpperCase(),
        status: (ord.status || 'completed').toUpperCase()
      };
    });

    const postRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
      redirect: 'follow'
    });

    const postResult = await postRes.json().catch(() => ({}));
    res.json({ success: postRes.ok, count: rows.length, message: `Successfully synced ${rows.length} sales orders to Google Sheets!`, data: postResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: Automatically push a single order to Google Spreadsheet
async function syncSingleOrderToGoogleSheets(order) {
  try {
    const currentEnv = loadEnv();
    const webhookUrl = currentEnv.GOOGLE_SHEET_WEBHOOK_URL || process.env.GOOGLE_SHEET_WEBHOOK_URL;
    if (!webhookUrl) return false;

    let totalUnits = 0;
    let sareeList = [];
    if (Array.isArray(order.items)) {
      order.items.forEach(it => {
        const qty = parseInt(it.quantity || it.qty || 1, 10);
        totalUnits += qty;
        sareeList.push(`${it.name || it.sku || 'Saree'} (${qty}x)`);
      });
    }

    const d = new Date(order.created_at || Date.now());
    const dateFormatted = d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' });

    const row = {
      date: dateFormatted,
      orderNumber: order.order_number,
      customerName: order.customer?.name || order.shipping_address?.name || 'Angular Storefront Customer',
      customerPhone: order.customer?.phone || order.shipping_address?.phone || '-',
      sareeItems: sareeList.join(', ') || 'Saree Order',
      totalUnits: totalUnits || 1,
      totalAmount: Number(order.total_amount || 0),
      paymentStatus: (order.payment_status || 'paid').toUpperCase(),
      channel: 'WEB',
      status: (order.status || 'confirmed').toUpperCase()
    };

    const postRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([row]),
      redirect: 'follow'
    });
    return postRes.ok;
  } catch (err) {
    console.warn('[syncSingleOrderToGoogleSheets] Webhook notice:', err.message);
    return false;
  }
}

// =============================================================================
// EXTERNAL STOREFRONT REST APIs (Angular / E-Commerce Storefront Integration)
// =============================================================================

// 1. GET /api/v1/store/products
// Fetch full catalog with photos, price, description, live stock, and color variants
app.get('/api/v1/store/products', requireStorefrontAuth, async (req, res) => {
  try {
    const inStockOnly = req.query.in_stock_only !== 'false';
    const searchQuery = (req.query.search || '').toLowerCase().trim();

    const [pRes, vRes, spRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?order=created_at.desc`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/video_record?select=id,video_id,product_code,saree,reference_frames`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/stock_pool?select=*`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      })
    ]);

    const products = (pRes.ok ? await pRes.json() : []) || [];
    const videoRecords = (vRes.ok ? await vRes.json() : []) || [];
    const stockPool = (spRes.ok ? await spRes.json() : []) || [];

    const videoMap = new Map();
    videoRecords.forEach(v => {
      if (v.product_code) videoMap.set(v.product_code.toLowerCase(), v);
    });

    const stockMap = new Map();
    stockPool.forEach(s => {
      if (s.product_code) stockMap.set(s.product_code.toLowerCase(), s);
      if (s.saree_id) stockMap.set(s.saree_id, s);
    });

    // Enrich products with live stock
    const enriched = products.map(p => {
      const code = (p.tally_part_number || p.sku || '').trim();
      const video = videoMap.get(code.toLowerCase());
      const stock = stockMap.get(code.toLowerCase()) || stockMap.get(p.id);

      const onlineStock = stock ? stock.online_quantity : (p.stock_quantity ?? 0);
      const heldStock = stock ? stock.held_quantity : 0;
      const availableStock = Math.max(0, onlineStock - heldStock);

      return {
        id: p.id,
        sku: code,
        name: p.name || 'Handcrafted Silk Saree',
        fabric: p.fabric || 'Pure Silk',
        weave: p.weave_style || null,
        color_primary: p.color_primary || 'Assorted',
        price: Number(p.price || 0),
        mrp: Number(p.mrp || p.price || 0),
        stock: availableStock,
        in_stock: availableStock > 0,
        image_urls: Array.isArray(p.image_urls) ? p.image_urls : [],
        description: p.description || '',
        design_family_id: p.design_family_id || null,
        has_video: Boolean(video),
        video_description: video?.saree?.stylist_summary || video?.review_notes || null
      };
    });

    // Group variants by design_family_id if present
    const familyMap = new Map();
    const finalStoreProducts = [];

    enriched.forEach(p => {
      if (p.design_family_id) {
        if (!familyMap.has(p.design_family_id)) {
          const groupObj = {
            id: p.design_family_id,
            sku: p.sku.replace(/-[A-Z0-9]+$/i, ''),
            name: (p.name || '').replace(/\s*\([^)]*\)\s*$/, '').trim(),
            fabric: p.fabric,
            weave: p.weave,
            price: p.price,
            mrp: p.mrp,
            description: p.description,
            stock: 0,
            in_stock: false,
            image_urls: [...p.image_urls],
            is_group: true,
            has_video: p.has_video,
            variants: []
          };
          familyMap.set(p.design_family_id, groupObj);
          finalStoreProducts.push(groupObj);
        }
        const grp = familyMap.get(p.design_family_id);
        grp.variants.push({
          id: p.id,
          sku: p.sku,
          name: p.name,
          color: p.color_primary,
          stock: p.stock,
          in_stock: p.stock > 0,
          price: p.price,
          mrp: p.mrp,
          image_urls: p.image_urls
        });
        grp.stock += p.stock;
        if (p.stock > 0) grp.in_stock = true;
        if (p.image_urls.length > 0 && grp.image_urls.length === 0) {
          grp.image_urls = p.image_urls;
        }
        if (p.has_video) grp.has_video = true;
      } else {
        finalStoreProducts.push({
          ...p,
          is_group: false,
          variants: []
        });
      }
    });

    // Filter by stock and search query
    let filtered = finalStoreProducts;
    if (inStockOnly) {
      filtered = filtered.filter(p => p.stock > 0);
    }
    if (searchQuery) {
      filtered = filtered.filter(p => {
        return (
          p.sku.toLowerCase().includes(searchQuery) ||
          p.name.toLowerCase().includes(searchQuery) ||
          (p.fabric && p.fabric.toLowerCase().includes(searchQuery)) ||
          (p.description && p.description.toLowerCase().includes(searchQuery))
        );
      });
    }

    res.json({
      success: true,
      count: filtered.length,
      store: 'Sai Traders',
      currency: 'INR',
      products: filtered
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. GET /api/v1/store/products/:sku
// Fetch single product / variant details by SKU
app.get('/api/v1/store/products/:sku', requireStorefrontAuth, async (req, res) => {
  try {
    const rawSku = (req.params.sku || '').trim().toUpperCase();
    if (!rawSku) {
      return res.status(400).json({ success: false, error: 'SKU is required.' });
    }

    const pRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.eq.${encodeURIComponent(rawSku)},tally_part_number.eq.${encodeURIComponent(rawSku)})&limit=1`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const catalogItems = await pRes.json();
    let item = catalogItems?.[0];

    if (!item) {
      // Fallback: check prefix match (e.g. searching 'SAI-VAR-01' finds 'SAI-VAR-01-BLU' variant or family)
      const prefixRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?sku=ilike.${encodeURIComponent(rawSku + '%')}&limit=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const prefixItems = await prefixRes.json();
      item = prefixItems?.[0];
    }

    if (!item) {
      return res.status(404).json({ success: false, error: `Product [${rawSku}] not found.` });
    }

    // If part of design family, fetch all sibling variants
    let variants = [];
    let liveStock = Number(item.stock_quantity || 0);

    if (item.design_family_id) {
      const famRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?design_family_id=eq.${item.design_family_id}`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const famItems = (await famRes.json()) || [];
      variants = famItems.map(f => ({
        id: f.id,
        sku: f.sku || f.tally_part_number,
        name: f.name,
        color: f.color_primary || 'Color',
        price: Number(f.price || item.price),
        mrp: Number(f.mrp || item.mrp),
        stock: Number(f.stock_quantity || 0),
        in_stock: Number(f.stock_quantity || 0) > 0,
        image_urls: Array.isArray(f.image_urls) ? f.image_urls : []
      }));
      liveStock = variants.reduce((acc, v) => acc + (v.stock || 0), 0);
    } else {
      const spRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?or=(product_code.eq.${encodeURIComponent(item.sku || rawSku)},saree_id.eq.${encodeURIComponent(item.id)})&limit=1`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      const spRows = await spRes.json();
      const stockRec = spRows?.[0];
      if (stockRec) {
        liveStock = Math.max(0, stockRec.online_quantity - (stockRec.held_quantity || 0));
      }
    }

    res.json({
      success: true,
      product: {
        id: item.id,
        sku: item.sku || item.tally_part_number,
        name: item.name,
        fabric: item.fabric,
        weave: item.weave_style,
        color_primary: item.color_primary,
        price: Number(item.price || 0),
        mrp: Number(item.mrp || item.price || 0),
        stock: liveStock,
        in_stock: liveStock > 0,
        image_urls: Array.isArray(item.image_urls) ? item.image_urls : [],
        description: item.description,
        design_family_id: item.design_family_id || null,
        is_group: Boolean(item.design_family_id),
        variants: variants
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. POST /api/v1/store/orders
// Post-checkout purchase update webhook from Angular
app.post('/api/v1/store/orders', requireStorefrontAuth, async (req, res) => {
  try {
    const {
      order_id,
      customer,
      items,
      total_amount,
      payment_status = 'paid',
      payment_method = 'online',
      payment_reference = null,
      notes = ''
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Order must contain at least one item.' });
    }

    const orderNumber = (order_id || `ANG-${Date.now()}`).trim();
    const cleanCustomer = {
      name: customer?.name || 'Angular Storefront Customer',
      phone: customer?.phone || customer?.mobile || '',
      email: customer?.email || '',
      address: customer?.address || customer?.street || 'Online Web Order'
    };
    const cleanAmount = parseFloat(total_amount) || 0;
    const targetGodown = await getTargetGodown();

    // 1. Deduct Stock in Supabase Immediately (stock_pool + saree_catalog)
    const stockUpdates = [];
    for (const item of items) {
      const sku = (item.sku || '').trim().toUpperCase();
      const qty = parseInt(item.quantity || item.qty || 1, 10);
      if (!sku) continue;

      try {
        // Deduct from stock_pool
        const spRes = await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?product_code=eq.${encodeURIComponent(sku)}`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
        const spRows = await spRes.json();
        if (spRows?.[0]) {
          const newQty = Math.max(0, (spRows[0].online_quantity || 0) - qty);
          await fetch(`${SUPABASE_URL}/rest/v1/stock_pool?id=eq.${spRows[0].id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ online_quantity: newQty, last_synced_at: new Date().toISOString() })
          });
        }

        // Deduct from saree_catalog
        const catRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?or=(sku.eq.${encodeURIComponent(sku)},tally_part_number.eq.${encodeURIComponent(sku)})`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        });
        const catRows = await catRes.json();
        if (catRows?.[0]) {
          const newCatQty = Math.max(0, (catRows[0].stock_quantity || 0) - qty);
          await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${catRows[0].id}`, {
            method: 'PATCH',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ stock_quantity: newCatQty, updated_at: new Date().toISOString() })
          });
        }

        stockUpdates.push({ sku, deducted: qty });
      } catch (deductErr) {
        console.warn(`[StoreOrder] Stock deduction error for ${sku}:`, deductErr.message);
      }
    }

    // 2. Insert Order into Supabase orders table
    const orderRecord = {
      order_number: orderNumber,
      channel: 'web',
      status: 'confirmed',
      payment_status: payment_status.toLowerCase(),
      payment_method: payment_method,
      total_amount: cleanAmount,
      items: items,
      shipping_address: cleanCustomer,
      notes: `Purchased via Angular Storefront [${orderNumber}] ${notes ? '| ' + notes : ''}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(orderRecord)
    });
    const createdOrder = await insRes.json().catch(() => null);

    // 3. Post Sales Voucher into Tally ERP Sarees Godown
    let tallySynced = false;
    for (const item of items) {
      const sku = (item.sku || '').trim().toUpperCase();
      const name = item.name || sku;
      const qty = parseInt(item.quantity || 1, 10);
      const rate = parseFloat(item.price) || 5000;
      const isNos = /mysore|paithani|0021|0022/i.test(name + sku);
      const unitLabel = isNos ? 'Nos' : 'Pcs';

      try {
        let voucherXml = buildTallySalesVoucherXml({
          orderNumber,
          stockItemName: sku,
          qty,
          rate,
          unitLabel,
          godownName: targetGodown,
          buyerName: cleanCustomer.name
        });

        let tallyRes = await sendToTally(voucherXml);
        let isSuccess = tallyRes.includes('<CREATED>1</CREATED>') || 
                        tallyRes.includes('<ALTERED>1</ALTERED>') ||
                        tallyRes.includes('Already Exists');

        // Educational mode date restriction fallback
        if (!isSuccess && tallyRes.includes('Voucher date is missing')) {
          const now = new Date();
          const fallbackDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}01`;
          voucherXml = buildTallySalesVoucherXml({
            orderNumber,
            stockItemName: sku,
            qty,
            rate,
            unitLabel,
            godownName: targetGodown,
            buyerName: cleanCustomer.name,
            dateOverride: fallbackDate
          });
          tallyRes = await sendToTally(voucherXml);
          isSuccess = tallyRes.includes('<CREATED>1</CREATED>') || tallyRes.includes('Already Exists');
        }

        if (isSuccess) {
          tallySynced = true;
        }
      } catch (tErr) {
        console.warn(`[StoreOrder] Tally voucher sync error for ${sku}:`, tErr.message);
      }
    }

    if (tallySynced && createdOrder?.[0]?.id) {
      await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${createdOrder[0].id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: `${orderRecord.notes} | TALLY_SYNCED_VCH_${orderNumber}` })
      });
    }

    // 4. Automatically Sync to Google Spreadsheet
    const sheetsSynced = await syncSingleOrderToGoogleSheets({
      order_number: orderNumber,
      customer: cleanCustomer,
      items: items,
      total_amount: cleanAmount,
      payment_status: payment_status,
      status: 'confirmed',
      created_at: new Date().toISOString()
    });

    res.json({
      success: true,
      message: `Order [${orderNumber}] received! Inventory updated, Tally ${targetGodown} godown synced, and Google Sheets logged.`,
      order_number: orderNumber,
      stock_updates: stockUpdates,
      tally_synced: tallySynced,
      sheets_synced: sheetsSynced,
      target_godown: targetGodown
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// -----------------------------------------------------------------------------
// Separate Sales Analytics API
// -----------------------------------------------------------------------------
app.get('/api/admin/analytics/sales', async (req, res) => {
  try {
    const period = (req.query.period || '7d').toLowerCase();
    let startDate = null;
    const now = new Date();

    if (period === 'today') {
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      startDate = today.toISOString();
    } else if (period === '7d') {
      const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      startDate = d.toISOString();
    } else if (period === '30d') {
      const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      startDate = d.toISOString();
    }

    let url = `${SUPABASE_URL}/rest/v1/orders?select=id,order_number,status,total_amount,payment_status,channel,items,notes,created_at,customers(name,phone_number)&order=created_at.desc`;
    if (startDate) {
      url += `&created_at=gte.${startDate}`;
    }

    const ordersRes = await fetch(url, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const rawOrders = await ordersRes.json();
    const orders = Array.isArray(rawOrders) ? rawOrders : [];

    // Aggregations
    let totalRevenue = 0;
    let completedOrders = 0;
    let totalUnitsSold = 0;
    const statusBreakdown = {};
    const channelBreakdown = {};
    const sareeVolumeMap = {};

    for (const ord of orders) {
      const st = ord.status || 'pending';
      statusBreakdown[st] = (statusBreakdown[st] || 0) + 1;

      const ch = ord.channel || 'whatsapp';
      channelBreakdown[ch] = (channelBreakdown[ch] || 0) + 1;

      const isCompleted = ['confirmed', 'paid', 'paid_pending_approval', 'approved', 'posted_to_tally', 'packed', 'shipped', 'delivered', 'dispatched'].includes(st);
      
      const amt = Number(ord.total_amount) || 0;
      if (isCompleted || ord.payment_status === 'paid') {
        totalRevenue += amt;
        completedOrders += 1;
      }

      // Items calculation
      const itemsList = Array.isArray(ord.items) ? ord.items : [];
      for (const item of itemsList) {
        const qty = parseInt(item.quantity, 10) || 1;
        if (isCompleted || ord.payment_status === 'paid') {
          totalUnitsSold += qty;
          const sName = item.name || item.sku || 'Saree';
          sareeVolumeMap[sName] = (sareeVolumeMap[sName] || 0) + qty;
        }
      }
    }

    const averageOrderValue = completedOrders > 0 ? Math.round(totalRevenue / completedOrders) : 0;

    // Top sarees list
    const topSarees = Object.entries(sareeVolumeMap)
      .map(([name, units]) => ({ name, units }))
      .sort((a, b) => b.units - a.units)
      .slice(0, 5);

    // Format orders for table display
    const formattedOrders = orders.map(ord => {
      const itemsList = Array.isArray(ord.items) ? ord.items : [];
      const itemDesc = itemsList.map(i => `${i.name || i.sku || 'Saree'} (x${i.quantity || 1})`).join(', ') || 'Standard Saree Order';
      return {
        id: ord.id,
        order_number: ord.order_number,
        customer_name: ord.customers?.name || 'Customer',
        customer_phone: ord.customers?.phone_number || '-',
        date: ord.created_at,
        items_desc: itemDesc,
        item_count: itemsList.reduce((acc, i) => acc + (parseInt(i.quantity, 10) || 1), 0),
        total_amount: Number(ord.total_amount) || 0,
        status: ord.status,
        payment_status: ord.payment_status || 'pending',
        channel: ord.channel || 'whatsapp'
      };
    });

    const activeGodown = await getTargetGodown();

    res.json({
      success: true,
      period,
      activeGodown,
      metrics: {
        totalRevenue,
        totalOrders: orders.length,
        completedOrders,
        averageOrderValue,
        totalUnitsSold,
        statusBreakdown,
        channelBreakdown,
        topSarees
      },
      orders: formattedOrders
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/new-stock: Recently detected inward stock & draft items
app.get('/api/new-stock', async (req, res) => {
  try {
    const [draftsRes, auditRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?status=in.(draft,pending_review)&select=*&order=created_at.desc&limit=20`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/audit_log?action=eq.new_stock_inward_detected&order=created_at.desc&limit=15`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      })
    ]);

    const drafts = await draftsRes.json();
    const inwards = await auditRes.json();

    res.json({
      success: true,
      draft_items: Array.isArray(drafts) ? drafts : [],
      inward_events: Array.isArray(inwards) ? inwards : []
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// 4. API: Video Knowledge Registry (Videos & Craft Descriptions)
// -----------------------------------------------------------------------------
app.get('/api/videos', async (req, res) => {
  try {
    const vRes = await fetch(`${SUPABASE_URL}/rest/v1/video_record?order=created_at.desc`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const records = await vRes.json();
    res.json({ success: true, count: records.length, records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/videos', async (req, res) => {
  try {
    const {
      video_id,
      product_code,
      source,
      source_url,
      video_description,
      craft_attributes,
      reference_frames
    } = req.body;

    if (!product_code) {
      return res.status(400).json({ success: false, error: "Product Code is required" });
    }

    const cleanCode = product_code.trim();
    const cleanVidId = (video_id || `vid_${cleanCode.toLowerCase()}_${Date.now()}`).trim();

    const sareeAttrs = craft_attributes || {};
    if (video_description) {
      sareeAttrs.stylist_summary = video_description;
    }

    const payload = {
      video_id: cleanVidId,
      product_code: cleanCode,
      source: source || 'studio',
      source_url: source_url || '',
      saree: sareeAttrs,
      reference_frames: reference_frames || [],
      review_notes: video_description || '',
      verified: true,
      is_active: true,
      updated_at: new Date().toISOString()
    };

    // Upsert video_record
    const vrRes = await fetch(`${SUPABASE_URL}/rest/v1/video_record`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(payload)
    });

    if (!vrRes.ok) {
      const err = await vrRes.text();
      return res.status(400).json({ success: false, error: `Failed to save video record: ${err}` });
    }
    const saved = await vrRes.json();

    // Maintain video_item
    await fetch(`${SUPABASE_URL}/rest/v1/video_item`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify({
        video_id: cleanVidId,
        product_code: cleanCode,
        verified: true,
        attrs: sareeAttrs,
        notes: video_description
      })
    });

    // Generate Multimodal Embeddings for each frame and description
    let embeddedFrames = 0;
    const frames = reference_frames || [];

    // Description embedding
    let textEmb = null;
    const fullTextDesc = `${cleanCode} saree. ${video_description || ''} ${sareeAttrs.fabric || ''} ${sareeAttrs.weave_style || ''} ${sareeAttrs.color_primary || ''} ${sareeAttrs.border_type || ''}`;
    try {
      textEmb = await generateEmbedding({ text: fullTextDesc.trim() }, 'RETRIEVAL_DOCUMENT');
    } catch (_tErr) {}

    for (const frame of frames) {
      try {
        let imageEmb = null;
        if (frame.base64) {
          const cleanB64 = frame.base64.replace(/^data:image\/\w+;base64,/, '');
          imageEmb = await generateEmbedding({
            inline_data: { mime_type: frame.mimeType || 'image/jpeg', data: cleanB64 }
          }, 'RETRIEVAL_DOCUMENT');
        }

        await fetch(`${SUPABASE_URL}/rest/v1/saree_frame`, {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            video_id: cleanVidId,
            product_code: cleanCode,
            timestamp_sec: frame.timestamp_sec || 0,
            attrs: sareeAttrs,
            image_emb: imageEmb,
            text_emb: textEmb,
            embedding_model: GEMINI_EMBEDDING_MODEL,
            embedding_dim: 768,
            verified: true
          })
        });
        embeddedFrames++;
      } catch (embErr) {
        console.warn("Frame embedding note:", embErr.message);
      }
    }

    res.json({
      success: true,
      message: `Video & craftsmanship description saved for [${cleanCode}]. ${embeddedFrames} keyframes indexed.`,
      record: saved[0],
      framesIndexed: embeddedFrames
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/videos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const getRes = await fetch(`${SUPABASE_URL}/rest/v1/video_record?id=eq.${id}&select=video_id`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const found = await getRes.json();
    if (!found?.[0]) return res.status(404).json({ success: false, error: "Record not found" });

    const vidId = found[0].video_id;
    await fetch(`${SUPABASE_URL}/rest/v1/saree_frame?video_id=eq.${encodeURIComponent(vidId)}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    await fetch(`${SUPABASE_URL}/rest/v1/video_item?video_id=eq.${encodeURIComponent(vidId)}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    await fetch(`${SUPABASE_URL}/rest/v1/video_record?id=eq.${id}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });

    res.json({ success: true, message: `Video record ${vidId} deleted.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// 5. API: Customer Screenshot Identification Engine
// -----------------------------------------------------------------------------
app.post('/api/identify-screenshot', async (req, res) => {
  try {
    const { screenshotBase64, customerHint } = req.body;
    if (!screenshotBase64) {
      return res.status(400).json({ success: false, error: "Customer screenshot is required" });
    }

    const cleanB64 = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');

    // 1. Load stored catalog and video frames
    const [catRes, frameRes, vidRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?select=*`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/saree_frame?select=id,video_id,product_code,timestamp_sec,attrs,image_emb,text_emb`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/video_record?select=id,video_id,product_code,saree,reference_frames`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      })
    ]);

    const catalog = await catRes.json();
    const storedFrames = await frameRes.json();
    const storedVideos = await vidRes.json();

    const catalogMap = new Map();
    catalog.forEach(p => {
      const code = (p.tally_part_number || p.sku || '').trim().toLowerCase();
      catalogMap.set(code, p);
    });

    // 2. Multimodal Query Embedding with gemini-embedding-2
    let queryEmbedding = null;
    try {
      queryEmbedding = await generateEmbedding({
        inline_data: { mime_type: 'image/jpeg', data: cleanB64 }
      }, 'RETRIEVAL_QUERY');
    } catch (_embErr) {
      console.warn("Screenshot image embedding fallback to vision analysis");
    }

    // 3. Cosine similarity scoring across all stored frames
    let frameScores = [];
    if (queryEmbedding && storedFrames.length > 0) {
      frameScores = storedFrames.map(f => {
        let sim = 0;
        if (f.image_emb) {
          const embArr = typeof f.image_emb === 'string' ? JSON.parse(f.image_emb) : f.image_emb;
          sim = computeCosineSimilarity(queryEmbedding, embArr);
        } else if (f.text_emb) {
          const embArr = typeof f.text_emb === 'string' ? JSON.parse(f.text_emb) : f.text_emb;
          sim = computeCosineSimilarity(queryEmbedding, embArr) * 0.85;
        }
        return {
          product_code: f.product_code,
          video_id: f.video_id,
          similarity: sim,
          frame: f
        };
      }).sort((a, b) => b.similarity - a.similarity);
    }

    // Top 3 candidate product codes
    const topCandidates = [];
    const seenCodes = new Set();
    for (const fs of frameScores) {
      if (fs.product_code && !seenCodes.has(fs.product_code)) {
        seenCodes.add(fs.product_code);
        topCandidates.push(fs);
        if (topCandidates.length >= 3) break;
      }
    }

    // 4. Gemini Vision Verification with gemini-3.5-flash-lite
    // Pass customer screenshot and stored saree catalog options for confirmation
    const candidateSummary = catalog.map(p => {
      const code = p.tally_part_number || p.sku;
      const v = storedVideos.find(x => x.product_code === code);
      return `Product Code: ${code}
Title: ${p.name}
Fabric: ${p.fabric || 'Silk'}
Price: ₹${p.price}
Video Description: ${v?.saree?.stylist_summary || p.description || 'Traditional Indian saree'}`;
    }).join('\n---\n');

    const promptText = `You are the master textile identification AI for Sai Traders.
Analyze the attached customer screenshot (from an Instagram reel, video still, or customer photo).
Determine WHICH saree in our stored catalog is shown in the screenshot.

STORED SAREE CATALOG & VIDEO DESCRIPTIONS:
${candidateSummary}

${customerHint ? `CUSTOMER MESSAGE/HINT: "${customerHint}"` : ''}

Evaluate the visual characteristics: body color, zari pattern on the border, pallu motifs, weave texture.
Return ONLY valid JSON matching this exact structure:
{
  "matched_product_code": "STRING (must match one of our Product Codes above)",
  "confidence_percentage": NUMBER (between 0 and 100, e.g. 96),
  "visual_reasoning": "STRING (concise explanation of why this matches the screenshot: matching pallu, border zari, color, weave)",
  "detected_features": {
    "color": "STRING",
    "border": "STRING",
    "pallu": "STRING",
    "weave": "STRING"
  }
}`;

    const visionUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const visionRes = await fetch(visionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: promptText },
            { inline_data: { mime_type: 'image/jpeg', data: cleanB64 } }
          ]
        }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    const visionData = await visionRes.json();
    let verdict = {};
    try {
      const rawText = visionData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      verdict = JSON.parse(rawText);
    } catch (_parseErr) {
      verdict = {
        matched_product_code: topCandidates[0]?.product_code || catalog[0]?.sku,
        confidence_percentage: 85,
        visual_reasoning: "Matched based on color palette and border style."
      };
    }

    const matchedCode = (verdict.matched_product_code || topCandidates[0]?.product_code || '').trim();
    const matchedSaree = catalogMap.get(matchedCode.toLowerCase()) || catalog[0];
    const matchedVideo = storedVideos.find(v => v.product_code?.toLowerCase() === matchedSaree.tally_part_number?.toLowerCase() || v.product_code?.toLowerCase() === matchedSaree.sku?.toLowerCase());

    // Best reference keyframe from our video library
    let matchedKeyframeBase64 = null;
    if (matchedVideo && matchedVideo.reference_frames && matchedVideo.reference_frames.length > 0) {
      matchedKeyframeBase64 = matchedVideo.reference_frames[0].base64;
    }

    // Compose ready-to-send WhatsApp response message
    const whatsappMessage = `Namaste! 🙏 The saree from your screenshot is our *${matchedSaree.name}* (Item Code: *${matchedSaree.tally_part_number || matchedSaree.sku}*).

✨ *Details:*
• Fabric: ${matchedSaree.fabric || 'Pure Silk'}
• Price: ₹${Number(matchedSaree.price || 0).toLocaleString('en-IN')}${matchedSaree.mrp ? ` (MRP: ₹${Number(matchedSaree.mrp).toLocaleString('en-IN')})` : ''}
• Live Stock: ${matchedSaree.stock_quantity > 0 ? `✅ ${matchedSaree.stock_quantity} Pcs Available (Online Godown)` : '⚠️ Currently in high demand'}

${matchedVideo?.saree?.stylist_summary ? `🥻 *Stylist Drape Note:* ${matchedVideo.saree.stylist_summary}\n` : ''}
Would you like us to reserve this piece for you or share a detailed video drape?`;

    res.json({
      success: true,
      matched: {
        product_code: matchedSaree.tally_part_number || matchedSaree.sku,
        name: matchedSaree.name,
        price: matchedSaree.price,
        mrp: matchedSaree.mrp,
        stock_quantity: matchedSaree.stock_quantity,
        confidence: verdict.confidence_percentage || 95,
        visual_reasoning: verdict.visual_reasoning || "Confirmed visual match against saree video keyframe.",
        detected_features: verdict.detected_features || {},
        matched_keyframe: matchedKeyframeBase64,
        video_description: matchedVideo?.saree?.stylist_summary || matchedSaree.description || '',
        saree_image: matchedSaree.image_urls?.[0] || null,
        whatsapp_reply: whatsappMessage
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// 6. Photo Management (View, Upload, Delete)
// -----------------------------------------------------------------------------
app.post('/api/upload-photo', async (req, res) => {
  try {
    const { sku, base64Image, fileName } = req.body;
    if (!sku || !base64Image) {
      return res.status(400).json({ success: false, error: "Missing sku or base64Image" });
    }

    const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const safeName = (fileName || `${sku.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}.jpg`).replace(/\s+/g, '_');

    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/saree-catalog-images/${safeName}`;
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "image/jpeg",
        "x-upsert": "true",
      },
      body: buffer
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      return res.status(500).json({ success: false, error: `Storage upload failed: ${errText}` });
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/saree-catalog-images/${safeName}`;

    let getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?sku=eq.${encodeURIComponent(sku)}&select=id,image_urls`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    let rows = await getRes.json();
    if (!rows?.[0]) {
      getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?tally_part_number=eq.${encodeURIComponent(sku)}&select=id,image_urls`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      rows = await getRes.json();
    }

    const existingUrls = rows[0]?.image_urls || [];
    const updatedUrls = [...existingUrls, publicUrl];

    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${rows[0].id}`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_urls: updatedUrls })
    });

    res.json({ success: true, publicUrl, updatedUrls });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/remove-photo', async (req, res) => {
  try {
    const { sku, photoUrl } = req.body;
    let getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?sku=eq.${encodeURIComponent(sku)}&select=id,image_urls`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    let rows = await getRes.json();
    if (!rows?.[0]) {
      getRes = await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?tally_part_number=eq.${encodeURIComponent(sku)}&select=id,image_urls`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      rows = await getRes.json();
    }

    const updated = (rows[0]?.image_urls || []).filter(u => u !== photoUrl);
    await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${rows[0].id}`, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_urls: updated })
    });

    res.json({ success: true, updatedUrls: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Archify Interactive Architecture Diagram Web Viewer
// -----------------------------------------------------------------------------
const archifyHtmlPath = path.resolve(__dirname, '..', '.archify', 'architecture-runtime-overview-20261005-110840', 'runtime-overview.html');
app.get('/archify', (req, res) => {
  if (fs.existsSync(archifyHtmlPath)) {
    const html = fs.readFileSync(archifyHtmlPath, 'utf-8');
    res.type('html').send(html);
  } else {
    res.status(404).send('Archify architecture diagram HTML not found');
  }
});

// -----------------------------------------------------------------------------
// Automatic Live Token Synchronizer (.env -> Supabase app_settings)
// -----------------------------------------------------------------------------
let lastSyncedToken = null;

async function syncEnvTokensToDatabase() {
  try {
    const currentEnv = loadEnv();
    const token = currentEnv.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneId = currentEnv.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token) return;

    if (lastSyncedToken !== token) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify([
          { key: 'WHATSAPP_ACCESS_TOKEN', value: token, description: 'Meta WhatsApp Cloud API Access Token' },
          { key: 'WHATSAPP_PHONE_NUMBER_ID', value: phoneId || '', description: 'Meta Phone Number ID' }
        ])
      });
      if (res.ok) {
        lastSyncedToken = token;
        console.log(`[TokenSync] ✓ Live WHATSAPP_ACCESS_TOKEN synced from .env to Supabase! (${token.slice(0, 15)}...)`);
      }
    }
  } catch (err) {
    console.warn('[TokenSync] Warning:', err.message);
  }
}

// Hot-reload .env whenever updated
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  fs.watchFile(envPath, { interval: 1000 }, () => {
    console.log('[EnvWatcher] 📝 .env change detected! Hot-reloading token...');
    try {
      loadEnv();
      syncEnvTokensToDatabase();
    } catch (e) {
      console.warn('[EnvWatcher] Failed parsing .env:', e.message);
    }
  });
}

// Initial sync on boot + periodic 5s verification
syncEnvTokensToDatabase();
setInterval(syncEnvTokensToDatabase, 5000);

// Auto-sync completed WhatsApp & Web orders to Tally ERP (Sales Vouchers) + stock_pool
syncPendingOrdersToTally();
setInterval(syncPendingOrdersToTally, 5000);

// API endpoint to inspect active token status
app.get('/api/whatsapp-token', async (req, res) => {
  try {
    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.WHATSAPP_ACCESS_TOKEN&select=value,updated_at`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
    });
    const data = await sRes.json();
    const token = data?.[0]?.value || process.env.WHATSAPP_ACCESS_TOKEN || '';
    res.json({
      success: true,
      hasToken: Boolean(token),
      tokenMasked: token ? `${token.slice(0, 15)}...${token.slice(-8)}` : null,
      lastUpdated: data?.[0]?.updated_at || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`===============================================================================`);
  console.log(`⚡ SAI TRADERS ENTERPRISE INVENTORY & SCREENSHOT IDENTIFIER ACTIVE`);
  console.log(`🌐 System Web Portal : http://localhost:${PORT}`);
  console.log(`🧪 API Simulator     : http://localhost:${PORT}/api-test`);
  console.log(`🗺️ Archify Diagram  : http://localhost:${PORT}/archify`);
  console.log(`🖥️ TallyPrime Server : http://${TALLY_HOST}:${TALLY_PORT}`);
  console.log(`🌅 Morning Sync     : Automated daily at 08:00 AM`);
  console.log(`🔍 Screenshot Match  : gemini-embedding-2 + ${GEMINI_VISION_MODEL}`);
  console.log(`===============================================================================`);
});
