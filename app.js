// =============================================================================
// Sai Traders — Retail Operations & Inventory Management Controller
// Standard Enterprise Data Operations and Multimodal Catalog Search
// =============================================================================

// State
let storedProducts = [];
let videoRecords = [];
let capturedKeyframes = []; // [{ base64, mimeType, timestamp_sec }]
let currentScreenshotBase64 = null;
let activeInventoryFilter = 'in_stock';
const knownStockMap = new Map();

// Initialize
async function initApp() {
  try { setupNavigationTabs(); } catch (e) { console.error('setupNavigationTabs error:', e); }
  try { setupStoredInventory(); } catch (e) { console.error('setupStoredInventory error:', e); }
  try { setupScreenshotMatcher(); } catch (e) { console.error('setupScreenshotMatcher error:', e); }
  try { setupVideoRegistry(); } catch (e) { console.error('setupVideoRegistry error:', e); }
  try { setupMorningStockSync(); } catch (e) { console.error('setupMorningStockSync error:', e); }
  try { setupPhotoManager(); } catch (e) { console.error('setupPhotoManager error:', e); }
  try { setupLiveStockPoller(); } catch (e) { console.error('setupLiveStockPoller error:', e); }
  try { setupAdjustStockModal(); } catch (e) { console.error('setupAdjustStockModal error:', e); }
  try { setupAddSareeModal(); } catch (e) { console.error('setupAddSareeModal error:', e); }
  try { setupSaaSSpecificGodown(); } catch (e) { console.error('setupSaaSSpecificGodown error:', e); }
  try { setupSalesAnalytics(); } catch (e) { console.error('setupSalesAnalytics error:', e); }

  // Initial Load (Run in parallel so catalog renders instantly even if Tally is offline)
  loadStoredProducts();
  loadSystemStatus();
  loadVideoRecords();
  loadGodownStatus();
  loadSalesAnalytics('7d');

  // Status Poll every 8s
  setInterval(loadSystemStatus, 8000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Toast notification helper
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.innerText = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// -----------------------------------------------------------------------------
// 1. Navigation Tabs
// -----------------------------------------------------------------------------
function setupNavigationTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add('active');
        if (targetId === 'tabAnalytics') {
          loadSalesAnalytics(currentAnalyticsPeriod);
        }
      }
    });
  });

  const btnRefresh = document.getElementById('btnRefresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      await loadSystemStatus();
      await loadStoredProducts();
      await loadVideoRecords();
      await loadGodownStatus();
      await loadSalesAnalytics(currentAnalyticsPeriod);
      showToast('Inventory & system data refreshed.');
    });
  }
}

// -----------------------------------------------------------------------------
// 2. System Status & Morning Sync State
// -----------------------------------------------------------------------------
async function loadSystemStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data.success) return;

    // Tally Indicator
    const tallyDot = document.getElementById('tallyDot');
    const tallyText = document.getElementById('tallyStatusText');
    if (data.tally && data.tally.connected) {
      tallyDot.className = 'status-dot';
      tallyText.innerText = `TALLY: 9000 (${data.tally.latencyMs || 8}ms)`;
    } else {
      tallyDot.className = 'status-dot offline';
      tallyText.innerText = 'TALLY: OFFLINE';
    }

    // Morning Sync Status
    const morningSyncText = document.getElementById('morningSyncText');
    if (data.morningSync?.lastSyncAt) {
      const d = new Date(data.morningSync.lastSyncAt);
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      morningSyncText.innerText = `INGESTED (${timeStr})`;
    } else {
      morningSyncText.innerText = 'SCHEDULED 08:00 AM';
    }

    // Counts & Discrepancies
    if (data.counts) {
      document.getElementById('badgeInventoryCount').innerText = data.counts.products || 0;
      document.getElementById('badgeVideoCount').innerText = data.counts.videos || 0;

      const openDisc = data.counts.openDiscrepancies || 0;
      const badgeDisc = document.getElementById('badgeDiscrepancyCount');
      const openDiscElem = document.getElementById('openDiscrepanciesCount');
      if (badgeDisc) {
        badgeDisc.innerText = openDisc;
        badgeDisc.style.display = openDisc > 0 ? 'inline-block' : 'none';
      }
      if (openDiscElem) {
        openDiscElem.innerText = openDisc;
      }
    }

    // Shop PC & Agent Telemetry
    const agentLiveDot = document.getElementById('agentLiveDot');
    const agentLiveText = document.getElementById('agentLiveStatusText');
    const downtimeBanner = document.getElementById('downtimeAlertBanner');
    if (agentLiveDot && agentLiveText) {
      if (data.shopPc && data.shopPc.connected) {
        agentLiveDot.className = 'status-dot';
        agentLiveText.innerText = `Shop PC Online (${data.shopPc.hostname || 'Active'})`;
        if (downtimeBanner) downtimeBanner.style.display = 'none';
      } else {
        agentLiveDot.className = 'status-dot offline';
        agentLiveText.innerText = 'Shop PC Offline (Tally Unreachable)';
        if (downtimeBanner) downtimeBanner.style.display = 'block';
      }
    }

    // WhatsApp Live Token Indicator
    try {
      const waRes = await fetch('/api/whatsapp-token');
      const waData = await waRes.json();
      const waDot = document.getElementById('waDot');
      const waText = document.getElementById('waStatusText');
      if (waDot && waText) {
        if (waData.hasToken) {
          waDot.className = 'status-dot';
          waText.innerText = `WA BOT: LIVE (${waData.tokenMasked?.slice(0, 10) || 'ACTIVE'}...)`;
        } else {
          waDot.className = 'status-dot offline';
          waText.innerText = 'WA BOT: NO TOKEN';
        }
      }
    } catch (_e) {}
  } catch (err) {
    console.warn("Status poll error:", err.message);
  }
}

// -----------------------------------------------------------------------------
// 3. Stored Inventory Tab (Read-Only Stored Catalog)
// -----------------------------------------------------------------------------
async function loadStoredProducts() {
  const grid = document.getElementById('inventoryGrid');
  try {
    const res = await fetch('/api/products');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    storedProducts = data.products || [];
    const inStockCount = storedProducts.filter(p => (p.stock_quantity || 0) > 0).length;
    const badgeCount = document.getElementById('badgeInventoryCount');
    if (badgeCount) badgeCount.innerText = activeInventoryFilter === 'in_stock' ? inStockCount : storedProducts.length;

    const countAllEl = document.getElementById('countAllCatalog');
    if (countAllEl) countAllEl.innerText = storedProducts.length;

    // Populate stock map for live tracking
    storedProducts.forEach(p => {
      const code = p.canonical_code || p.sku;
      if (code) knownStockMap.set(code, Number(p.stock_quantity) || 0);
    });

    renderInventoryGrid();
    populateTargetSareeSelect();
  } catch (err) {
    grid.innerHTML = `<div style="padding:40px; color:var(--status-rose);">Failed to load stored inventory: ${err.message}</div>`;
  }
}

// Color mapping utility for vibrant UI swatches
function getColorHex(colorName) {
  if (!colorName) return '#94a3b8';
  const c = colorName.toLowerCase().trim();
  if (c.includes('red') || c.includes('maroon') || c.includes('crimson') || c.includes('ruby')) return '#ef4444';
  if (c.includes('blue') || c.includes('navy') || c.includes('royal') || c.includes('indigo')) return '#3b82f6';
  if (c.includes('green') || c.includes('emerald') || c.includes('mint') || c.includes('olive') || c.includes('pista')) return '#10b981';
  if (c.includes('yellow') || c.includes('gold') || c.includes('mustard')) return '#eab308';
  if (c.includes('pink') || c.includes('rose') || c.includes('magenta') || c.includes('rani')) return '#ec4899';
  if (c.includes('purple') || c.includes('violet') || c.includes('lavender') || c.includes('plum')) return '#a855f7';
  if (c.includes('orange') || c.includes('saffron') || c.includes('rust') || c.includes('coral') || c.includes('peach')) return '#f97316';
  if (c.includes('black') || c.includes('charcoal')) return '#1e293b';
  if (c.includes('white') || c.includes('offwhite') || c.includes('cream') || c.includes('ivory')) return '#f8fafc';
  if (c.includes('cyan') || c.includes('teal') || c.includes('turquoise') || c.includes('aqua')) return '#06b6d4';
  if (c.includes('brown') || c.includes('coffee') || c.includes('copper') || c.includes('bronze')) return '#92400e';
  if (c.includes('grey') || c.includes('silver')) return '#64748b';
  return '#8b5cf6';
}

let isGroupModeActive = false;
const selectedProductIdsForGroup = new Set();

window.selectVariantPill = function(btnEl) {
  const cardId = btnEl.getAttribute('data-parent-card');
  const card = document.getElementById(cardId) || btnEl.closest('.inventory-card');
  if (!card) return;

  card.querySelectorAll('.color-pill').forEach(p => p.classList.remove('active'));
  btnEl.classList.add('active');

  const sku = btnEl.getAttribute('data-sku');
  const stock = parseInt(btnEl.getAttribute('data-stock'), 10) || 0;
  const name = decodeURIComponent(btnEl.getAttribute('data-name') || '');
  const photo = btnEl.getAttribute('data-photo');
  const unit = btnEl.getAttribute('data-unit') || 'Pcs';
  const inTally = btnEl.getAttribute('data-tally') === 'true';

  const imgEl = card.querySelector('.card-media img');
  if (imgEl && photo) imgEl.src = photo;

  const stockTag = card.querySelector('.stock-tag');
  if (stockTag) {
    stockTag.className = `stock-tag ${stock > 0 ? 'in-stock' : 'out-of-stock'}`;
    stockTag.innerText = stock > 0 ? `${stock} ${unit} (${activeGodownName || 'Sarees'})` : 'Out of Stock';
  }

  const skuEl = card.querySelector('.sku-code');
  if (skuEl) skuEl.innerText = sku;

  const tallyBadge = card.querySelector('.tally-status-badge');
  if (tallyBadge) {
    tallyBadge.className = `tally-status-badge ${inTally ? 'synced' : 'pending'}`;
    tallyBadge.innerHTML = `<span class="status-dot ${inTally ? '' : 'offline'}"></span> ${inTally ? 'Tally' : 'Not in Tally'}`;
  }

  const syncBtn = card.querySelector('.btn-sync-card');
  if (syncBtn) {
    syncBtn.setAttribute('onclick', `syncTallyForCard('${sku}', this)`);
    syncBtn.innerHTML = `
      <svg class="sync-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
      ${inTally ? 'Sync Stock' : 'Push to Tally'}
    `;
  }

  const adjustBtn = card.querySelector('button[title*="Adjust"]');
  if (adjustBtn) {
    adjustBtn.setAttribute('onclick', `openAdjustStockModal('${sku}', '${encodeURIComponent(name)}', ${stock})`);
  }

  const delBtn = card.querySelector('.btn-delete-card');
  if (delBtn) {
    delBtn.setAttribute('onclick', `deleteProductCard('', '${sku}', event)`);
  }
};

window.handleGroupSelect = function(checkboxEl, productId) {
  if (checkboxEl.checked) {
    selectedProductIdsForGroup.add(productId);
  } else {
    selectedProductIdsForGroup.delete(productId);
  }
  const countEl = document.getElementById('selectedGroupCount');
  if (countEl) countEl.innerText = `${selectedProductIdsForGroup.size} selected`;

  const btnConfirm = document.getElementById('btnConfirmGroupSelected');
  if (btnConfirm) btnConfirm.disabled = selectedProductIdsForGroup.size < 2;
};

window.ungroupFamily = async function(familyId, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!confirm('Are you sure you want to ungroup this family into individual sarees?')) return;
  try {
    const res = await fetch('/api/admin/products/ungroup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family_id: familyId })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    showToast('Products ungrouped into individual sarees.');
    await loadStoredProducts();
  } catch (err) {
    alert(`Failed to ungroup: ${err.message}`);
  }
};

function renderInventoryGrid() {
  const grid = document.getElementById('inventoryGrid');
  const query = document.getElementById('inventorySearch').value.toLowerCase().trim();

  const filtered = storedProducts.filter(p => {
    const code = (p.canonical_code || '').toLowerCase();
    const name = (p.name || '').toLowerCase();
    const matchesSearch = !query || code.includes(query) || name.includes(query);

    let matchesFilter = true;
    if (activeInventoryFilter === 'in_stock') matchesFilter = (p.stock_quantity || 0) > 0;
    else if (activeInventoryFilter === 'has_video') matchesFilter = Boolean(p.has_video);
    else if (activeInventoryFilter === 'missing_video') matchesFilter = !p.has_video;

    return matchesSearch && matchesFilter;
  });

  // Update badge count to reflect currently filtered count
  const badgeCount = document.getElementById('badgeInventoryCount');
  if (badgeCount) {
    const inStockCount = storedProducts.filter(p => (p.stock_quantity || 0) > 0).length;
    badgeCount.innerText = activeInventoryFilter === 'in_stock' ? inStockCount : storedProducts.length;
  }

  if (filtered.length === 0) {
    grid.innerHTML = `<div style="padding:40px; text-align:center; color:var(--text-muted); grid-column:1/-1;">No stored sarees match the selected filter.</div>`;
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const isGroup = Boolean(p.is_group && p.variants && p.variants.length > 0);
    const activeVar = isGroup ? p.variants[0] : null;

    const code = isGroup ? activeVar.canonical_code : p.canonical_code;
    const cardIdCode = p.canonical_code;
    const hasPhoto = isGroup
      ? ((activeVar.image_urls && activeVar.image_urls.length > 0) || (p.image_urls && p.image_urls.length > 0))
      : (p.image_urls && p.image_urls.length > 0);
    const photoUrl = hasPhoto ? (isGroup ? (activeVar.image_urls?.[0] || p.image_urls?.[0]) : p.image_urls[0]) : null;
    const inStock = isGroup ? ((activeVar.stock_quantity || 0) > 0) : ((p.stock_quantity || 0) > 0);
    const totalGroupStock = isGroup ? p.stock_quantity : (p.stock_quantity || 0);
    const isNos = /mysore|paithani|0021|0022/i.test((p.name || '') + code);
    const unitLabel = isNos ? 'Nos' : 'Pcs';
    const isItemInTally = isGroup ? activeVar.item_created_in_tally : p.item_created_in_tally;
    const activeVarStock = isGroup ? activeVar.stock_quantity : p.stock_quantity;

    return `
      <div class="inventory-card" id="card-${cardIdCode}">
        <div class="card-media">
          ${isGroupModeActive ? `
            <input type="checkbox" class="card-select-checkbox" data-id="${p.id}" ${selectedProductIdsForGroup.has(p.id) ? 'checked' : ''} onchange="window.handleGroupSelect(this, '${p.id}')">
          ` : ''}
          ${photoUrl ? `<img src="${photoUrl}" alt="${p.name}">` : `
            <div class="card-media-placeholder">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
              <span>No Photo Assigned</span>
            </div>
          `}
          <div class="stock-tag ${inStock ? 'in-stock' : 'out-of-stock'}" id="stock-tag-${cardIdCode}">
            ${isGroup
              ? `${activeVarStock} ${unitLabel} (${activeGodownName || 'Sarees'})`
              : (inStock ? `${p.stock_quantity} ${unitLabel} (${activeGodownName || 'Sarees'})` : 'Out of Stock')
            }
          </div>
        </div>

        <div class="card-body">
          <div class="sku-line">
            <span class="sku-code">${code}</span>
            <div style="display:flex; align-items:center; gap:5px;">
              ${isGroup ? `<span class="group-badge">Color Family</span>` : ''}
              <span class="tally-status-badge ${isItemInTally ? 'synced' : 'pending'}" title="${isItemInTally ? 'Synchronized with Tally ERP' : 'Pending Tally Creation & Sync'}">
                <span class="status-dot ${isItemInTally ? '' : 'offline'}"></span>
                ${isItemInTally ? 'Tally' : 'Not in Tally'}
              </span>
              <span class="video-status-indicator ${p.has_video ? 'attached' : ''}">
                ${p.has_video ? 'Video' : 'No Video'}
              </span>
            </div>
          </div>

          <h3 class="card-title" title="${p.name || ''}">${p.name || 'Untitled Saree'}</h3>

          <div class="card-pricing">
            <span class="price-current">₹${Number(p.price || 0).toLocaleString('en-IN')}</span>
            ${p.mrp ? `<span class="price-mrp">MRP ₹${Number(p.mrp).toLocaleString('en-IN')}</span>` : ''}
          </div>

          ${isGroup ? `
            <div class="color-variants-container">
              <div class="color-variant-label">
                <span>Color Options (${p.variants.length})</span>
                <span style="color:var(--status-emerald); font-family:var(--font-mono); font-weight:600;">Total: ${totalGroupStock} ${unitLabel}</span>
              </div>
              <div class="color-variant-pills">
                ${p.variants.map((v, idx) => `
                  <button type="button" class="color-pill ${idx === 0 ? 'active' : ''}"
                    data-parent-card="card-${cardIdCode}"
                    data-sku="${v.canonical_code}"
                    data-stock="${v.stock_quantity}"
                    data-name="${encodeURIComponent(v.name || p.name)}"
                    data-photo="${v.image_urls?.[0] || photoUrl || ''}"
                    data-unit="${unitLabel}"
                    data-tally="${v.item_created_in_tally ? 'true' : 'false'}"
                    onclick="window.selectVariantPill(this)">
                    <span class="color-dot" style="background:${getColorHex(v.color_primary)}"></span>
                    <span class="color-name">${v.color_primary || 'Color'}</span>
                    <span class="color-qty">${v.stock_quantity}</span>
                  </button>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${p.video_description ? `
            <div class="card-video-snippet" title="${p.video_description}">
              ${p.video_description}
            </div>
          ` : ''}

          <div class="card-actions" style="display:flex; flex-wrap:wrap; gap:6px;">
            <button class="btn btn-sm btn-primary btn-sync-card" id="btnSync_${cardIdCode}" onclick="syncTallyForCard('${code}', this)" title="${isItemInTally ? 'Synchronize live closing stock with Tally ERP' : `Push & inward stock into Tally ERP ${activeGodownName || 'Sarees'} Godown`}" style="flex:1;">
              <svg class="sync-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
              ${isItemInTally ? 'Sync Stock' : 'Push to Tally'}
            </button>
            <button class="btn btn-sm btn-outline" onclick="openAdjustStockModal('${code}', '${encodeURIComponent(isGroup ? activeVar.name : (p.name || ''))}', ${activeVarStock || 0})" title="Adjust or inward stock directly in Tally ERP ${activeGodownName || 'Sarees'} Godown">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              Adjust
            </button>
            <button class="btn btn-sm btn-outline" onclick="openVideoModalForSaree('${code}')" title="Attach video file and craftsmanship description">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
              ${p.has_video ? 'Media' : 'Attach'}
            </button>
            <button class="btn btn-sm btn-outline" onclick="openPhotoModal('${code}')" title="Manage saree photos">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
              Photos (${p.image_urls?.length || 0})
            </button>
            ${isGroup ? `
              <button class="btn btn-sm btn-outline" onclick="window.ungroupFamily('${p.design_family_id || p.id}', event)" title="Separate into individual sarees" style="color:var(--text-muted); border-color:var(--border);">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1"/><path d="M18 8h4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-4"/></svg>
                Ungroup
              </button>
            ` : ''}
            <button class="btn btn-sm btn-outline btn-delete-card" onclick="deleteProductCard('${p.id}', '${code}', event)" title="Delete product completely from catalog" style="color:var(--status-rose); border-color:rgba(244,63,94,0.35);">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function setupStoredInventory() {
  const invSearch = document.getElementById('inventorySearch');
  if (invSearch) invSearch.addEventListener('input', renderInventoryGrid);

  const pills = document.querySelectorAll('.filter-pill[data-filter]');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeInventoryFilter = pill.getAttribute('data-filter');
      renderInventoryGrid();
    });
  });

  // Group Mode Toolbar controls
  const btnToggleGroupMode = document.getElementById('btnToggleGroupMode');
  const groupActionBar = document.getElementById('groupActionBar');
  const btnCancelGroupMode = document.getElementById('btnCancelGroupMode');
  const btnConfirmGroupSelected = document.getElementById('btnConfirmGroupSelected');

  if (btnToggleGroupMode) {
    btnToggleGroupMode.addEventListener('click', () => {
      isGroupModeActive = !isGroupModeActive;
      selectedProductIdsForGroup.clear();
      if (groupActionBar) groupActionBar.style.display = isGroupModeActive ? 'flex' : 'none';
      btnToggleGroupMode.className = `btn ${isGroupModeActive ? 'btn-primary' : 'btn-outline'}`;
      btnToggleGroupMode.innerHTML = isGroupModeActive ? `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Exit Group Mode
      ` : `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        Group Sarees
      `;
      renderInventoryGrid();
    });
  }

  if (btnCancelGroupMode) {
    btnCancelGroupMode.addEventListener('click', () => {
      isGroupModeActive = false;
      selectedProductIdsForGroup.clear();
      if (groupActionBar) groupActionBar.style.display = 'none';
      if (btnToggleGroupMode) {
        btnToggleGroupMode.className = 'btn btn-outline';
        btnToggleGroupMode.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Group Sarees
        `;
      }
      renderInventoryGrid();
    });
  }

  if (btnConfirmGroupSelected) {
    btnConfirmGroupSelected.addEventListener('click', async () => {
      if (selectedProductIdsForGroup.size < 2) return;
      btnConfirmGroupSelected.disabled = true;
      btnConfirmGroupSelected.innerText = 'Grouping...';
      try {
        const res = await fetch('/api/admin/products/group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: Array.from(selectedProductIdsForGroup) })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        showToast(data.message || 'Sarees combined into color family!');
        isGroupModeActive = false;
        selectedProductIdsForGroup.clear();
        if (groupActionBar) groupActionBar.style.display = 'none';
        if (btnToggleGroupMode) {
          btnToggleGroupMode.className = 'btn btn-outline';
          btnToggleGroupMode.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Group Sarees
          `;
        }
        await loadStoredProducts();
      } catch (err) {
        alert(`Failed to group sarees: ${err.message}`);
      } finally {
        if (btnConfirmGroupSelected) {
          btnConfirmGroupSelected.disabled = false;
          btnConfirmGroupSelected.innerText = 'Combine into Family';
        }
      }
    });
  }

  // Global Sync Tally Stock toolbar button
  const btnSyncTallyAll = document.getElementById('btnSyncTallyAll');
  if (btnSyncTallyAll) {
    btnSyncTallyAll.addEventListener('click', async () => {
      btnSyncTallyAll.disabled = true;
      btnSyncTallyAll.innerHTML = `<span class="status-dot"></span> Synchronizing...`;

      try {
        const res = await fetch('/api/sync-tally-stock', { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        showToast(`Tally stock synchronized: ${data.result?.itemsUpdated || 0} items updated.`);
        renderStockReconciliation(data.result?.reconciliation || []);
        await loadStoredProducts();
        await loadSystemStatus();
      } catch (err) {
        showToast(`Sync failed: ${err.message}`);
      } finally {
        btnSyncTallyAll.disabled = false;
        btnSyncTallyAll.innerHTML = `
          <svg class="sync-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
          Sync All Stock
        `;
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 4. Morning Stock Ingestion, Discrepancies & Downtime Resilience (Phase 2)
// -----------------------------------------------------------------------------
let currentDiscrepancyFilter = 'open';
let cachedDiscrepancies = [];

function setupMorningStockSync() {
  setupSyncButtons();
  setupSyncSchedule();
  setupDiscrepancyResolutionModal();
  setupDowntimeModal();

  // Load initial Phase 2 data
  loadSyncSchedule();
  loadDiscrepancies('open');
  loadNewStockAndDrafts();
  loadSyncRuns();
}

function setupSyncButtons() {
  const syncBtn = document.getElementById('btnMorningSync');
  const runSyncNowBtn = document.getElementById('btnRunSyncNow');

  async function triggerSync(btn) {
    if (btn) {
      btn.disabled = true;
      btn.dataset.originalText = btn.innerHTML;
      btn.innerText = 'Syncing Stock...';
    }

    try {
      const res = await fetch('/api/sync-morning-stock', { method: 'POST' });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Morning sync failed');
      }

      const resObj = data.result || {};
      const msg = `Morning sync completed: ${resObj.itemsUpdated || 0} items updated, ${resObj.newStockInwards || 0} inward receipts, ${resObj.discrepanciesCount || 0} discrepancies logged.`;
      showToast(msg);

      await loadStoredProducts();
      await loadSystemStatus();
      await loadDiscrepancies(currentDiscrepancyFilter);
      await loadNewStockAndDrafts();
      await loadSyncRuns();
    } catch (err) {
      showToast(`Sync notice: ${err.message}`);
      await loadSystemStatus();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalText || 'Run Morning Sync Now';
      }
    }
  }

  if (syncBtn) syncBtn.addEventListener('click', () => triggerSync(syncBtn));
  if (runSyncNowBtn) runSyncNowBtn.addEventListener('click', () => triggerSync(runSyncNowBtn));
}

// Dynamic Daily Sync Schedule
async function loadSyncSchedule() {
  try {
    const res = await fetch('/api/sync/schedule');
    const data = await res.json();
    if (data.success && data.schedule?.time) {
      const input = document.getElementById('syncScheduleInput');
      if (input) input.value = data.schedule.time;
    }
  } catch (err) {
    console.warn('Could not load sync schedule:', err.message);
  }
}

function setupSyncSchedule() {
  const btn = document.getElementById('btnSaveSyncSchedule');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const input = document.getElementById('syncScheduleInput');
    const timeVal = input ? input.value : '09:30';
    try {
      const res = await fetch('/api/sync/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time: timeVal })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Daily sync schedule updated to ${timeVal}.`);
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      alert(`Failed to save sync schedule: ${err.message}`);
    }
  });
}

// Discrepancies Table
window.filterDiscrepancies = function(filter) {
  currentDiscrepancyFilter = filter;
  const btnOpen = document.getElementById('btnFilterDiscOpen');
  const btnAll = document.getElementById('btnFilterDiscAll');
  if (btnOpen && btnAll) {
    if (filter === 'open') {
      btnOpen.classList.add('active');
      btnAll.classList.remove('active');
    } else {
      btnOpen.classList.remove('active');
      btnAll.classList.add('active');
    }
  }
  loadDiscrepancies(filter);
};

async function loadDiscrepancies(filter = 'open') {
  const tbody = document.getElementById('discrepanciesTableBody');
  if (!tbody) return;

  try {
    const url = `/api/discrepancies?status=${filter}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    cachedDiscrepancies = data.discrepancies || [];
    renderDiscrepanciesTable(cachedDiscrepancies);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:20px; text-align:center; color:var(--status-rose);">Failed to load discrepancies: ${err.message}</td></tr>`;
  }
}

function renderDiscrepanciesTable(discrepancies) {
  const tbody = document.getElementById('discrepanciesTableBody');
  if (!discrepancies || discrepancies.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:24px; text-align:center; color:var(--text-muted);">No ${currentDiscrepancyFilter === 'open' ? 'open' : ''} discrepancies. Tally and cloud inventory are in sync.</td></tr>`;
    return;
  }

  tbody.innerHTML = discrepancies.map(d => {
    const delta = d.actual_qty - d.expected_qty;
    const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
    const sareeName = d.saree?.name || 'Catalog Saree';
    const isOpen = d.status === 'open';
    const detectedAt = d.created_at ? new Date(d.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';

    return `
      <tr>
        <td><strong style="font-family:var(--font-mono); color:var(--accent-primary);">${d.product_code}</strong></td>
        <td>${sareeName}</td>
        <td style="font-family:var(--font-mono); font-weight:600;">${d.expected_qty} Nos</td>
        <td style="font-family:var(--font-mono); font-weight:600; color:var(--status-rose);">${d.actual_qty} Nos</td>
        <td>
          <span style="font-family:var(--font-mono); font-weight:600; padding:2px 6px; border-radius:4px; font-size:11px; background:rgba(244,63,94,0.15); color:var(--status-rose);">
            ${deltaStr}
          </span>
        </td>
        <td style="font-size:11px; color:var(--text-secondary); max-width:240px; word-break:break-word;">
          ${d.explanation || 'Variance detected'}
        </td>
        <td style="font-size:11px; color:var(--text-muted);">${detectedAt}</td>
        <td>
          ${isOpen ? `
            <button class="btn btn-sm btn-primary" onclick="window.openResolveDiscrepancyModal('${d.id}')">
              Resolve
            </button>
          ` : `
            <span style="font-size:11px; font-weight:600; color:var(--status-emerald); font-family:var(--font-mono);">
              Resolved
            </span>
          `}
        </td>
      </tr>
    `;
  }).join('');
}

// Discrepancy Resolution Modal
function setupDiscrepancyResolutionModal() {
  const modal = document.getElementById('discrepancyModal');
  const closeBtn = document.getElementById('closeDiscrepancyModalBtn');
  const cancelBtn = document.getElementById('btnCancelDiscrepancyModal');
  const confirmBtn = document.getElementById('btnConfirmResolveDiscrepancy');
  const radioInputs = document.querySelectorAll('input[name="discResolutionAction"]');
  const verifiedQtyGroup = document.getElementById('discVerifiedQtyGroup');

  function closeModal() {
    if (modal) modal.classList.remove('active');
  }

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  radioInputs.forEach(r => {
    r.addEventListener('change', () => {
      if (verifiedQtyGroup) {
        verifiedQtyGroup.style.display = r.value === 'manual_count' ? 'block' : 'none';
      }
    });
  });

  window.openResolveDiscrepancyModal = function(id) {
    const disc = cachedDiscrepancies.find(x => x.id === id);
    if (!disc) return;

    document.getElementById('discModalId').value = disc.id;
    document.getElementById('discModalProductCode').value = disc.product_code;
    document.getElementById('discModalItemCode').innerText = disc.product_code;
    document.getElementById('discModalItemName').innerText = disc.saree?.name || 'Saree Product';
    document.getElementById('discModalExpectedQty').innerText = `${disc.expected_qty} Nos`;
    document.getElementById('discModalActualQty').innerText = `${disc.actual_qty} Nos`;
    const delta = disc.actual_qty - disc.expected_qty;
    document.getElementById('discModalDeltaBadge').innerText = `${delta > 0 ? '+' : ''}${delta} Delta`;
    document.getElementById('discModalExplanation').innerText = disc.explanation || 'Tally actual does not match cloud balance.';

    document.getElementById('discVerifiedQtyInput').value = disc.actual_qty;
    document.getElementById('discNotesInput').value = '';

    // Reset radio to accept_tally
    const defaultRadio = document.querySelector('input[name="discResolutionAction"][value="accept_tally"]');
    if (defaultRadio) defaultRadio.checked = true;
    if (verifiedQtyGroup) verifiedQtyGroup.style.display = 'none';

    if (modal) modal.classList.add('active');
  };

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const discId = document.getElementById('discModalId').value;
      const actionRadio = document.querySelector('input[name="discResolutionAction"]:checked');
      const action = actionRadio ? actionRadio.value : 'accept_tally';
      const verifiedQty = document.getElementById('discVerifiedQtyInput').value;
      const notes = document.getElementById('discNotesInput').value;

      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Resolving...';

      try {
        const res = await fetch(`/api/discrepancies/${discId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            verified_qty: action === 'manual_count' ? parseInt(verifiedQty, 10) : undefined,
            notes,
            resolved_by: 'admin:store_manager'
          })
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to resolve discrepancy');

        showToast(`Discrepancy resolved via "${action}". Stock updated.`);
        closeModal();
        await loadDiscrepancies(currentDiscrepancyFilter);
        await loadStoredProducts();
        await loadSystemStatus();
      } catch (err) {
        alert(`Resolution error: ${err.message}`);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Confirm Resolution
        `;
      }
    });
  }
}

// Downtime Modal (Manual Stock Entry when Shop PC is offline)
function setupDowntimeModal() {
  const modal = document.getElementById('downtimeModal');
  const openBtn = document.getElementById('btnOpenDowntimeModal');
  const closeBtn = document.getElementById('closeDowntimeModalBtn');
  const cancelBtn = document.getElementById('btnCancelDowntimeModal');
  const confirmBtn = document.getElementById('btnConfirmDowntimeEntry');
  const select = document.getElementById('dtTargetSareeSelect');

  function closeModal() {
    if (modal) modal.classList.remove('active');
  }

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      if (select) {
        select.innerHTML = storedProducts.map(p => {
          const code = p.canonical_code || p.sku;
          return `<option value="${code}">${code} — ${p.name || 'Untitled'}</option>`;
        }).join('');
        updateDowntimeModalStats();
      }
      if (modal) modal.classList.add('active');
    });
  }

  function updateDowntimeModalStats() {
    if (!select) return;
    const code = select.value;
    const product = storedProducts.find(p => (p.canonical_code || p.sku) === code);
    const online = product ? (product.stock_quantity || 0) : 0;
    const held = product ? (product.held_quantity || 0) : 0;
    const avail = Math.max(0, online - held);

    document.getElementById('dtCurrentOnlineQty').innerText = `${online} Nos`;
    document.getElementById('dtCurrentHeldQty').innerText = `${held} Nos`;
    document.getElementById('dtCurrentAvailableQty').innerText = `${avail} Nos`;
  }

  if (select) select.addEventListener('change', updateDowntimeModalStats);

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const productCode = select ? select.value : '';
      const newQty = document.getElementById('dtNewQuantityInput').value;
      const reason = document.getElementById('dtReasonInput').value;

      if (!productCode) return alert('Please select a target saree.');
      if (newQty === '' || parseInt(newQty, 10) < 0) return alert('Please enter a valid non-negative quantity.');
      if (!reason || reason.trim() === '') return alert('A reason is mandatory for manual stock adjustments.');

      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Recording...';

      try {
        const res = await fetch('/api/manual-stock-entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_code: productCode,
            new_quantity: parseInt(newQty, 10),
            reason,
            admin_user: 'admin:store_manager'
          })
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed manual stock entry');

        showToast(`Shelf stock recorded for ${productCode}: ${newQty} units`);
        closeModal();
        await loadStoredProducts();
        await loadSystemStatus();
      } catch (err) {
        alert(`Manual entry error: ${err.message}`);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Record Shelf Stock
        `;
      }
    });
  }
}

// New Stock Inwards & Draft Products
async function loadNewStockAndDrafts() {
  const inwardList = document.getElementById('newStockInwardList');
  const draftsList = document.getElementById('newDraftProductsList');

  try {
    const res = await fetch('/api/new-stock');
    const data = await res.json();
    if (!data.success) return;

    if (inwardList) {
      const inwards = data.inward_events || [];
      if (inwards.length === 0) {
        inwardList.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-muted);">No new inward stock detected recently.</div>`;
      } else {
        inwardList.innerHTML = inwards.map(evt => {
          const delta = evt.new_state?.inward_delta || (evt.new_state?.online_quantity - evt.old_state?.online_quantity);
          const time = evt.created_at ? new Date(evt.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid var(--border);">
              <div>
                <strong style="font-family:var(--font-mono); color:var(--status-emerald); font-size:12px;">${evt.entity_id}</strong>
                <span style="font-size:11px; color:var(--text-muted); margin-left:6px;">Inward Delta: +${delta}</span>
              </div>
              <span style="font-size:11px; color:var(--text-muted);">${time}</span>
            </div>
          `;
        }).join('');
      }
    }

    if (draftsList) {
      const drafts = data.draft_items || [];
      if (drafts.length === 0) {
        draftsList.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-muted);">No unmapped items found in Tally.</div>`;
      } else {
        draftsList.innerHTML = drafts.map(d => {
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid var(--border);">
              <div>
                <strong style="font-family:var(--font-mono); color:var(--accent-primary); font-size:12px;">${d.sku}</strong>
                <span style="font-size:11px; color:var(--text-secondary); margin-left:6px;">${d.name || 'Draft Saree'}</span>
              </div>
              <span style="font-size:10px; font-family:var(--font-mono); padding:2px 6px; border-radius:4px; background:rgba(99,102,241,0.15); color:var(--accent-primary);">
                Draft (Review Needed)
              </span>
            </div>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.warn('Error loading new stock & drafts:', err.message);
  }
}

// Recent Sync Runs Audit Table
async function loadSyncRuns() {
  const tbody = document.getElementById('syncRunsTableBody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/sync/runs?limit=10');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const runs = data.runs || [];
    if (runs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding:20px; text-align:center; color:var(--text-muted);">No sync runs recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = runs.map(r => {
      let statusColor = 'var(--text-muted)';
      if (r.status === 'completed') statusColor = 'var(--status-emerald)';
      else if (r.status === 'completed_with_issues') statusColor = 'var(--status-amber)';
      else if (r.status === 'failed') statusColor = 'var(--status-rose)';
      else if (r.status === 'running') statusColor = 'var(--accent-primary)';

      const started = r.started_at ? new Date(r.started_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';
      const finished = r.finished_at ? new Date(r.finished_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'In Progress';
      const summary = r.error_summary || (r.step_log && r.step_log.length > 0 ? r.step_log[r.step_log.length - 1].step : 'Completed');

      return `
        <tr>
          <td><strong style="font-family:var(--font-mono); font-size:11px;">#${r.id.slice(0, 8)}</strong></td>
          <td style="font-size:11px;">${r.triggered_by || 'system'}</td>
          <td>
            <span style="font-size:11px; font-weight:600; padding:2px 8px; border-radius:10px; color:${statusColor}; background:rgba(255,255,255,0.06); font-family:var(--font-mono);">
              ${r.status}
            </span>
          </td>
          <td style="font-size:11px; color:var(--text-muted);">${started}</td>
          <td style="font-size:11px; color:var(--text-muted);">${finished}</td>
          <td style="font-size:11px; color:var(--text-secondary); max-width:260px; word-break:break-word;">${summary}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:20px; text-align:center; color:var(--status-rose);">Failed to load sync runs: ${err.message}</td></tr>`;
  }
}

// -----------------------------------------------------------------------------
// 5. Customer Screenshot Identification Engine
// -----------------------------------------------------------------------------
function setupScreenshotMatcher() {
  const dropzone = document.getElementById('screenshotDropzone');
  const fileInput = document.getElementById('screenshotFileInput');
  if (!dropzone || !fileInput) return;

  const dropPrompt = document.getElementById('dropPrompt');
  const dropPreview = document.getElementById('dropPreview');
  const previewImg = document.getElementById('screenshotPreviewImg');
  const btnClear = document.getElementById('btnClearScreenshot');
  const btnIdentify = document.getElementById('btnRunIdentification');

  // Click to upload
  dropzone.addEventListener('click', () => {
    if (!currentScreenshotBase64) fileInput.click();
  });

  // Drag & drop
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--border-focus)';
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = 'var(--border)';
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--border)';
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleScreenshotFile(file);
    }
  });

  // File picker change
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleScreenshotFile(file);
  });

  // Paste from clipboard (Ctrl+V) anywhere on the page
  window.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (items) {
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          handleScreenshotFile(file);
          // Switch to Matcher tab automatically
          const matcherBtn = document.querySelector('.tab-btn[data-tab="tabMatcher"]');
          if (matcherBtn) matcherBtn.click();
          showToast('Image pasted from clipboard.');
          break;
        }
      }
    }
  });

  function handleScreenshotFile(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      currentScreenshotBase64 = event.target.result;
      if (previewImg) previewImg.src = currentScreenshotBase64;
      if (dropPrompt) dropPrompt.style.display = 'none';
      if (dropPreview) dropPreview.style.display = 'block';
      if (btnClear) btnClear.style.display = 'inline-flex';
    };
    reader.readAsDataURL(file);
  }

  if (btnClear) {
    btnClear.addEventListener('click', (e) => {
      e.stopPropagation();
      currentScreenshotBase64 = null;
      fileInput.value = '';
      if (previewImg) previewImg.src = '';
      if (dropPrompt) dropPrompt.style.display = 'flex';
      if (dropPreview) dropPreview.style.display = 'none';
      btnClear.style.display = 'none';
      const emptyState = document.getElementById('matchEmptyState');
      const verdictCard = document.getElementById('matchVerdictCard');
      if (emptyState) emptyState.style.display = 'flex';
      if (verdictCard) verdictCard.style.display = 'none';
    });
  }

  // Identify action
  if (btnIdentify) {
    btnIdentify.addEventListener('click', async () => {
      if (!currentScreenshotBase64) {
        alert("Please upload or paste a customer screenshot first.");
        return;
      }

      const emptyState = document.getElementById('matchEmptyState');
    const loadingState = document.getElementById('matchLoadingState');
    const verdictCard = document.getElementById('matchVerdictCard');

    emptyState.style.display = 'none';
    verdictCard.style.display = 'none';
    loadingState.style.display = 'flex';
    btnIdentify.disabled = true;

    try {
      const hint = document.getElementById('customerHintInput').value.trim();
      const res = await fetch('/api/identify-screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          screenshotBase64: currentScreenshotBase64,
          customerHint: hint
        })
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      const m = data.matched;

      // Populate verdict card
      document.getElementById('verdictSareeName').innerText = m.name || 'Identified Saree';
      document.getElementById('verdictConfidence').innerHTML = `
        <span class="status-dot"></span>
        <span>${m.confidence || 96}% Match Confidence</span>
      `;
      document.getElementById('compCustomerImg').src = currentScreenshotBase64;
      document.getElementById('compKeyframeImg').src = m.matched_keyframe || m.saree_image || 'https://placehold.co/400x300?text=Keyframe';
      document.getElementById('verdictCode').innerText = m.product_code || '—';
      document.getElementById('verdictReasoning').innerText = m.visual_reasoning || 'Visual match against saree video keyframe.';

      const stockNum = m.stock_quantity || 0;
      document.getElementById('verdictStock').innerHTML = stockNum > 0
        ? `<strong style="color:var(--status-emerald);">${stockNum} Pcs Available (Online Godown)</strong>`
        : `<strong style="color:var(--status-rose);">Out of Stock (Online Godown)</strong>`;

      document.getElementById('verdictPricing').innerText = `₹${Number(m.price || 0).toLocaleString('en-IN')}${m.mrp ? ` (MRP ₹${Number(m.mrp).toLocaleString('en-IN')})` : ''}`;
      document.getElementById('verdictDescription').innerText = m.video_description || 'No video description attached.';
      document.getElementById('whatsappReplyText').value = m.whatsapp_reply || '';

      loadingState.style.display = 'none';
      verdictCard.style.display = 'flex';
      showToast(`Identified product: [${m.product_code}] ${m.name}`);
    } catch (err) {
      loadingState.style.display = 'none';
      emptyState.style.display = 'flex';
      alert(`Identification failed: ${err.message}`);
    } finally {
      btnIdentify.disabled = false;
    }
  });
}

  // Copy WhatsApp reply
  const btnCopyWA = document.getElementById('btnCopyWhatsApp');
  if (btnCopyWA) {
    btnCopyWA.addEventListener('click', () => {
      const text = document.getElementById('whatsappReplyText')?.value;
      if (text) {
        navigator.clipboard.writeText(text);
        showToast('Customer response copied to clipboard.');
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 6. Video Knowledge Registry & Keyframe Capture
// -----------------------------------------------------------------------------
function populateTargetSareeSelect() {
  const sel = document.getElementById('vTargetSareeSelect');
  if (!sel) return;
  sel.innerHTML = storedProducts.map(p => {
    const code = p.canonical_code;
    return `<option value="${code}">${code} — ${p.name?.slice(0, 40) || 'Untitled'}</option>`;
  }).join('');
}

async function loadVideoRecords() {
  const grid = document.getElementById('videoGrid');
  try {
    const res = await fetch('/api/videos');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    videoRecords = data.records || [];
    document.getElementById('badgeVideoCount').innerText = videoRecords.length;

    if (videoRecords.length === 0) {
      grid.innerHTML = `<div style="padding:40px; text-align:center; color:var(--text-muted); grid-column:1/-1;">No video records attached yet. Click "+ Attach Saree Video & Description" above.</div>`;
      return;
    }

    grid.innerHTML = videoRecords.map(v => {
      const code = v.product_code;
      const saree = storedProducts.find(p => p.canonical_code === code) || {};
      const frames = v.reference_frames || [];
      const firstFrame = frames.length > 0 ? frames[0].base64 : (saree.image_urls?.[0] || null);

      return `
        <div class="inventory-card">
          <div class="card-media">
            ${firstFrame ? `<img src="${firstFrame}" alt="Video Keyframe">` : `
              <div class="card-media-placeholder">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                <span>Video Keyframe</span>
              </div>
            `}
            <div class="stock-tag in-stock">${frames.length} Keyframes</div>
          </div>

          <div class="card-body">
            <div class="sku-line">
              <span class="sku-code">${code}</span>
              <span class="video-status-indicator attached">Active Record</span>
            </div>

            <h3 class="card-title">${saree.name || code}</h3>

            <div class="card-video-snippet">
              ${v.saree?.stylist_summary || v.review_notes || 'No description provided.'}
            </div>

            <div class="card-actions">
              <button class="btn btn-sm btn-outline" onclick="openVideoModalForSaree('${code}')">Edit Video</button>
              <button class="btn btn-sm btn-outline" onclick="deleteVideoRecord('${v.id}')" style="color:var(--status-rose);">Delete</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div style="padding:40px; color:var(--status-rose);">Failed to load video records: ${err.message}</div>`;
  }
}

function setupVideoRegistry() {
  const modal = document.getElementById('videoModal');
  if (!modal) return;
  const closeBtn = document.getElementById('closeVideoModalBtn');
  const cancelBtn = document.getElementById('btnCancelVideoModal');
  const btnOpen = document.getElementById('btnOpenVideoModal');
  const btnChooseVideo = document.getElementById('btnChooseVideoFile');
  const videoFileInput = document.getElementById('videoFileInput');
  const modalVideoPlayer = document.getElementById('modalVideoPlayer');
  const videoPlayerBox = document.getElementById('videoPlayerBox');
  const btnCaptureFrame = document.getElementById('btnCaptureCurrentFrame');
  const btnAutoSample = document.getElementById('btnAutoSampleFrames');
  const btnAddFrameFile = document.getElementById('btnAddFrameFileBtn');
  const frameFileInput = document.getElementById('frameFileInput');
  const btnSaveVideo = document.getElementById('btnSaveVideo') || document.getElementById('btnSaveVideoRecord');

  const closeModal = () => modal.classList.remove('active');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      openVideoModalForSaree(null);
    });
  }

  // Video File Upload
  if (btnChooseVideo && videoFileInput) {
    btnChooseVideo.addEventListener('click', () => videoFileInput.click());
    videoFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && modalVideoPlayer) {
        const url = URL.createObjectURL(file);
        modalVideoPlayer.src = url;
        modalVideoPlayer.load();
        if (videoPlayerBox) videoPlayerBox.style.display = 'block';
        showToast('Video ready for playback.');
      }
    });
  }

  // Capture current video frame
  function captureCurrentVideoFrame(label) {
    if (!modalVideoPlayer || !modalVideoPlayer.videoWidth) {
      alert("Please wait for video to load or press play.");
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = modalVideoPlayer.videoWidth;
    canvas.height = modalVideoPlayer.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(modalVideoPlayer, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL('image/jpeg', 0.85);

    capturedKeyframes.push({
      base64,
      mimeType: 'image/jpeg',
      timestamp_sec: modalVideoPlayer.currentTime || 0
    });
    renderKeyframesFilmstrip();
    showToast(`Keyframe captured at ${modalVideoPlayer.currentTime.toFixed(1)}s.`);
  }

  if (btnCaptureFrame) btnCaptureFrame.addEventListener('click', () => captureCurrentVideoFrame());

  // Auto-Sample 3 Keyframes (20%, 50%, 80%)
  if (btnAutoSample) {
    btnAutoSample.addEventListener('click', async () => {
      if (!modalVideoPlayer || !modalVideoPlayer.duration || isNaN(modalVideoPlayer.duration)) {
        alert("Video file must be loaded to auto-sample frames.");
        return;
      }
      const dur = modalVideoPlayer.duration;
      const times = [dur * 0.2, dur * 0.5, dur * 0.8];
      showToast("Extracting 3 keyframes across video duration...");

      for (const t of times) {
        await new Promise(resolve => {
          modalVideoPlayer.currentTime = t;
          modalVideoPlayer.onseeked = () => {
            captureCurrentVideoFrame(`Sample @ ${t.toFixed(1)}s`);
            modalVideoPlayer.onseeked = null;
            resolve();
          };
        });
      }
      showToast("3 keyframes extracted from video.");
    });
  }

  // Upload frame image
  if (btnAddFrameFile && frameFileInput) {
    btnAddFrameFile.addEventListener('click', () => frameFileInput.click());
    frameFileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      files.forEach(file => {
        const reader = new FileReader();
        reader.onload = (event) => {
          capturedKeyframes.push({
            base64: event.target.result,
            mimeType: file.type || 'image/jpeg',
            timestamp_sec: 0
          });
          renderKeyframesFilmstrip();
        };
        reader.readAsDataURL(file);
      });
      frameFileInput.value = '';
    });
  }

  // Save video
  if (btnSaveVideo) {
    btnSaveVideo.addEventListener('click', async () => {
      const product_code = document.getElementById('vTargetSareeSelect')?.value;
      const description = document.getElementById('vDescriptionInput')?.value?.trim();
      const source_url = document.getElementById('vSourceUrlInput')?.value?.trim() || '';

      if (!product_code) {
        alert("Please select a target saree.");
        return;
      }

      if (!description) {
        alert("Please enter a craftsmanship video description. This is essential for matching customer screenshots.");
        return;
      }

      if (capturedKeyframes.length === 0) {
        alert("Please capture or upload at least one video keyframe to enable visual identification.");
        return;
      }

      btnSaveVideo.disabled = true;
      btnSaveVideo.innerText = "Indexing & Generating Embeddings...";

      try {
        const res = await fetch('/api/videos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_code,
            video_description: description,
            source_url,
            craft_attributes: {
              fabric: document.getElementById('vFabricInput')?.value?.trim() || '',
              weave_style: document.getElementById('vWeaveInput')?.value?.trim() || '',
              zari_type: document.getElementById('vZariInput')?.value?.trim() || ''
            },
            reference_frames: capturedKeyframes
          })
        });

        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        showToast(`Video and embeddings indexed for [${product_code}].`);
        closeModal();
        await loadStoredProducts();
        await loadVideoRecords();
      } catch (err) {
        alert(`Save failed: ${err.message}`);
      } finally {
        btnSaveVideo.disabled = false;
        btnSaveVideo.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Save Video & Generate Embeddings
        `;
      }
    });
  }
}

function renderKeyframesFilmstrip() {
  const container = document.getElementById('frameFilmstrip');
  if (!container) return;
  if (capturedKeyframes.length === 0) {
    container.innerHTML = `<span style="font-size:11px; color:var(--text-muted);">No keyframes captured yet. Play video above and click "Capture Frame", or upload.</span>`;
    return;
  }

  container.innerHTML = capturedKeyframes.map((f, idx) => `
    <div style="position:relative; width:64px; height:64px; border-radius:4px; overflow:hidden; border:1px solid var(--border); flex-shrink:0;">
      <img src="${f.base64}" alt="Frame ${idx + 1}" style="width:100%; height:100%; object-fit:cover;">
      <button onclick="removeCapturedKeyframe(${idx})" style="position:absolute; top:2px; right:2px; background:rgba(0,0,0,0.7); color:#fff; border:none; border-radius:50%; width:16px; height:16px; font-size:10px; cursor:pointer; display:flex; align-items:center; justify-content:center;">&times;</button>
    </div>
  `).join('');
}

window.removeCapturedKeyframe = function(idx) {
  capturedKeyframes.splice(idx, 1);
  renderKeyframesFilmstrip();
};

window.openVideoModalForSaree = function(code) {
  capturedKeyframes = [];
  const modal = document.getElementById('videoModal');
  const sel = document.getElementById('vTargetSareeSelect');
  populateTargetSareeSelect();

  if (code) sel.value = code;

  // Prefill if existing video record exists
  const existing = videoRecords.find(v => v.product_code === (code || sel.value));
  if (existing) {
    document.getElementById('vDescriptionInput').value = existing.saree?.stylist_summary || existing.review_notes || '';
    document.getElementById('vFabricInput').value = existing.saree?.fabric || '';
    document.getElementById('vWeaveInput').value = existing.saree?.weave_style || '';
    document.getElementById('vZariInput').value = existing.saree?.zari_type || '';
    document.getElementById('vSourceUrlInput').value = existing.source_url || '';
    capturedKeyframes = (existing.reference_frames || []).map(f => ({ ...f }));
  } else {
    document.getElementById('vDescriptionInput').value = '';
    document.getElementById('vFabricInput').value = '';
    document.getElementById('vWeaveInput').value = '';
    document.getElementById('vZariInput').value = '';
    document.getElementById('vSourceUrlInput').value = '';
  }

  renderKeyframesFilmstrip();
  modal.classList.add('active');
};

window.deleteVideoRecord = async function(id) {
  if (!confirm("Are you sure you want to delete this video record and its indexed embeddings?")) return;
  try {
    const res = await fetch(`/api/videos/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast("Video record removed.");
    await loadStoredProducts();
    await loadVideoRecords();
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
};

// -----------------------------------------------------------------------------
// 7. Photo Manager Modal
// -----------------------------------------------------------------------------
function setupPhotoManager() {
  const modal = document.getElementById('photoModal');
  if (!modal) return;
  const closeBtn = document.getElementById('closePhotoModalBtn');
  const closeBtn2 = document.getElementById('btnClosePhotoModal');
  const btnBrowse = document.getElementById('btnBrowsePhotoFile');
  const fileInput = document.getElementById('photoFileInput');
  const btnAssign = document.getElementById('btnAssignPhotoUrl');

  const closeModal = () => modal.classList.remove('active');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (closeBtn2) closeBtn2.addEventListener('click', closeModal);

  if (btnBrowse && fileInput) {
    btnBrowse.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const sku = document.getElementById('photoModalSku').value;
      const reader = new FileReader();
      reader.onload = async (event) => {
        showToast("Uploading photo asset...");
        try {
          const res = await fetch('/api/upload-photo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sku,
              base64Image: event.target.result,
              fileName: file.name
            })
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error);
          showToast("Photo uploaded and assigned.");
          await loadStoredProducts();
          openPhotoModal(sku);
        } catch (err) {
          alert("Photo upload failed: " + err.message);
        }
      };
      reader.readAsDataURL(file);
    }
  });
}

  if (btnAssign) {
    btnAssign.addEventListener('click', async () => {
      const sku = document.getElementById('photoModalSku').value;
      const url = document.getElementById('photoUrlInput').value.trim();
      if (!url) return;

      try {
        const p = storedProducts.find(x => x.canonical_code === sku);
        const existing = p?.image_urls || [];
        const updated = [...existing, url];

        await fetch(`${SUPABASE_URL}/rest/v1/saree_catalog?id=eq.${p.id}`, {
          method: "PATCH",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ image_urls: updated })
        });

        document.getElementById('photoUrlInput').value = '';
        showToast("Photo URL assigned.");
        await loadStoredProducts();
        openPhotoModal(sku);
      } catch (err) {
        alert("Assign failed: " + err.message);
      }
    });
  }
}

window.openPhotoModal = function(code) {
  const modal = document.getElementById('photoModal');
  const p = storedProducts.find(x => x.canonical_code === code);
  if (!p) return;

  document.getElementById('photoModalSku').value = code;
  document.getElementById('photoModalTitle').innerText = `Manage Photos: [${code}] — ${p.name || ''}`;

  const grid = document.getElementById('photoModalGrid');
  const urls = p.image_urls || [];

  if (urls.length === 0) {
    grid.innerHTML = `<span style="font-size:11px; color:var(--text-muted); padding:20px; text-align:center; width:100%;">No photos assigned to this saree. Upload or paste URL below.</span>`;
  } else {
    grid.innerHTML = urls.map(url => `
      <div style="position:relative; width:80px; height:80px; border-radius:4px; overflow:hidden; border:1px solid var(--border);">
        <img src="${url}" style="width:100%; height:100%; object-fit:cover;">
        <button onclick="removePhotoFromSaree('${code}', '${encodeURIComponent(url)}')" style="position:absolute; top:2px; right:2px; background:rgba(0,0,0,0.7); color:#fff; border:none; border-radius:50%; width:18px; height:18px; font-size:10px; cursor:pointer; display:flex; align-items:center; justify-content:center;">&times;</button>
      </div>
    `).join('');
  }

  modal.classList.add('active');
};

window.removePhotoFromSaree = async function(sku, encodedUrl) {
  const photoUrl = decodeURIComponent(encodedUrl);
  if (!confirm("Remove this photo from saree?")) return;
  try {
    const res = await fetch('/api/remove-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku, photoUrl })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast("Photo removed.");
    await loadStoredProducts();
    openPhotoModal(sku);
  } catch (err) {
    alert("Remove photo failed: " + err.message);
  }
};

// -----------------------------------------------------------------------------
// 7. Live Stock Auto-Update (Real-Time Poller for Completed Transactions)
// -----------------------------------------------------------------------------
let isPollingLiveStock = false;

function setupLiveStockPoller() {
  // Check live stock status every 3.5 seconds
  setInterval(async () => {
    if (isPollingLiveStock) return;
    isPollingLiveStock = true;
    try {
      const res = await fetch('/api/live-stock');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success || !Array.isArray(data.products)) return;

      data.products.forEach(p => {
        const code = p.canonical_code || p.sku;
        const newQty = Number(p.stock_quantity) || 0;

        if (knownStockMap.has(code)) {
          const oldQty = knownStockMap.get(code);
          if (oldQty !== newQty) {
            console.log(`[LiveStock] Stock change detected for ${code}: ${oldQty} -> ${newQty}`);
            handleLiveStockChange(code, oldQty, newQty, p);
          }
        }
        knownStockMap.set(code, newQty);
      });
    } catch (_err) {
      // Silent catch for background poll
    } finally {
      isPollingLiveStock = false;
    }
  }, 3500);
}

function handleLiveStockChange(code, oldQty, newQty, prodData) {
  // Update in-memory storedProducts
  const existing = storedProducts.find(p => (p.canonical_code || p.sku) === code);
  if (existing) {
    existing.stock_quantity = newQty;
  }

  const cardEl = document.getElementById(`card-${code}`);
  const tagEl = document.getElementById(`stock-tag-${code}`);
  const isNos = /mysore|paithani|0021|0022/i.test((prodData.name || '') + code);
  const unitLabel = isNos ? 'Nos' : 'Pcs';

  if (tagEl) {
    tagEl.className = `stock-tag ${newQty > 0 ? 'in-stock' : 'out-of-stock'} stock-live-flash`;
    tagEl.innerText = newQty > 0 ? `${newQty} ${unitLabel} (${activeGodownName || 'Sarees'})` : 'Out of Stock';
    setTimeout(() => {
      tagEl.classList.remove('stock-live-flash');
    }, 3800);
  }

  if (cardEl) {
    cardEl.classList.add('card-live-flash');
    setTimeout(() => {
      cardEl.classList.remove('card-live-flash');
    }, 2800);
  }

  const direction = newQty < oldQty ? 'Stock deducted' : 'Inward stock added';
  showToast(`${direction}: ${prodData.name || code} stock is now ${newQty} ${unitLabel} in Online Godown.`);

  loadSystemStatus();
}

// -----------------------------------------------------------------------------
// 8. Card-Level Tally Synchronization
// -----------------------------------------------------------------------------
window.syncTallyForCard = async function(code, btn) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="status-dot"></span> Syncing...`;
  }
  try {
    const res = await fetch(`/api/sync-product-stock/${encodeURIComponent(code)}`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const msg = data.message || `Tally stock synced: ${code} has ${data.item?.currentStock ?? 0} units.`;
    showToast(msg);
    
    await loadStoredProducts();
    await loadSystemStatus();

    // Trigger visual pulse highlight on the updated card
    const cardEl = document.getElementById(`card-${code}`);
    const tagEl = document.getElementById(`stock-tag-${code}`);
    if (tagEl) {
      tagEl.classList.add('stock-live-flash');
      setTimeout(() => tagEl.classList.remove('stock-live-flash'), 2500);
    }
    if (cardEl) {
      cardEl.classList.add('card-live-flash');
      setTimeout(() => cardEl.classList.remove('card-live-flash'), 2500);
    }
  } catch (err) {
    showToast(`Sync failed: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg class="sync-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
        Sync Tally Stock
      `;
    }
  }
};

window.deleteProductCard = function(id, code, event) {
  if (event) event.stopPropagation();
  window.pendingDeleteTarget = { id, code };
  const msg = document.getElementById('deleteConfirmMessage');
  if (msg) msg.innerText = `Permanently delete [${code}] from the catalog and zero out its stock in Tally ERP?`;
  const modal = document.getElementById('deleteConfirmModal');
  if (modal) {
    modal.classList.add('active');
  } else {
    // Fallback if modal DOM element is somehow missing
    if (confirm(`Permanently delete [${code}] from the catalog and zero out its stock in Tally ERP?`)) {
      window.executeConfirmedDelete();
    }
  }
};

window.executeConfirmedDelete = async function() {
  if (!window.pendingDeleteTarget) return;
  const { id, code } = window.pendingDeleteTarget;
  if (typeof window.closeDeleteModal === 'function') {
    window.closeDeleteModal();
  } else {
    const modal = document.getElementById('deleteConfirmModal');
    if (modal) modal.classList.remove('active');
    window.pendingDeleteTarget = null;
  }

  const card = document.getElementById(`card-${code}`);
  if (card) {
    card.style.opacity = '0.4';
    card.style.pointerEvents = 'none';
  }

  try {
    const res = await fetch(`/api/products/${encodeURIComponent(id || code)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to delete');
    showToast(`Product [${code}] deleted from catalog & Tally stock zeroed.`);
    if (card) {
      card.style.transition = 'all 0.3s ease';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.8)';
      setTimeout(() => card.remove(), 300);
    }
    if (typeof loadStoredProducts === 'function') await loadStoredProducts();
    if (typeof loadSystemStatus === 'function') await loadSystemStatus();
  } catch (err) {
    if (card) {
      card.style.opacity = '1';
      card.style.pointerEvents = 'auto';
    }
    showToast(`Could not delete: ${err.message}`);
  }
};

// -----------------------------------------------------------------------------
// 9. Adjust / Update Stock Modal in Tally ERP
// -----------------------------------------------------------------------------
window.openAdjustStockModal = function(code, encodedName, currentStock) {
  const name = decodeURIComponent(encodedName);
  document.getElementById('adjustStockSku').value = code;
  document.getElementById('adjustModalSareeName').innerText = `${name} (${code})`;
  document.getElementById('adjustModalCurrentStock').innerText = `${currentStock} Nos`;
  document.getElementById('adjustTargetQuantityInput').value = currentStock;
  document.getElementById('adjustReasonInput').value = '';
  document.getElementById('adjustStockModal').classList.add('active');
};

function setupAdjustStockModal() {
  const modal = document.getElementById('adjustStockModal');
  const closeBtn = document.getElementById('closeAdjustStockModalBtn');
  const cancelBtn = document.getElementById('btnCancelAdjustModal');
  const confirmBtn = document.getElementById('btnConfirmAdjustStock');

  const closeModal = () => modal.classList.remove('active');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const code = document.getElementById('adjustStockSku').value;
      const targetQty = document.getElementById('adjustTargetQuantityInput').value;
      const reason = document.getElementById('adjustReasonInput').value;

      if (targetQty === '' || isNaN(targetQty)) {
        alert('Please enter a valid stock quantity');
        return;
      }

      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Updating Tally ERP...';

      try {
        const res = await fetch('/api/adjust-tally-stock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, targetQuantity: parseInt(targetQty, 10), reason })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        closeModal();
        showToast(`Stock updated in Tally ERP: ${code} is now ${data.newQuantity} Nos.`);
        
        await loadStoredProducts();
        await loadSystemStatus();

        const cardEl = document.getElementById(`card-${code}`);
        const tagEl = document.getElementById(`stock-tag-${code}`);
        if (tagEl) {
          tagEl.classList.add('stock-live-flash');
          setTimeout(() => tagEl.classList.remove('stock-live-flash'), 2500);
        }
        if (cardEl) {
          cardEl.classList.add('card-live-flash');
          setTimeout(() => cardEl.classList.remove('card-live-flash'), 2500);
        }
      } catch (err) {
        alert(`Failed to update stock in Tally: ${err.message}`);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Update in Tally ERP
        `;
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 10. Add Saree Modal (Catalog Creation & Embedding Indexing)
// -----------------------------------------------------------------------------
function setupAddSareeModal() {
  const modal = document.getElementById('addSareeModal');
  const openBtn = document.getElementById('btnOpenAddSareeModal');
  const closeBtn = document.getElementById('closeAddSareeModalBtn');
  const cancelBtn = document.getElementById('btnCancelAddSareeModal');
  const confirmBtn = document.getElementById('btnConfirmAddSaree');
  const browseBtn = document.getElementById('asBtnBrowsePhoto');
  const fileInput = document.getElementById('asPhotoFileInput');
  const previewContainer = document.getElementById('asPhotoPreviewContainer');
  const previewImg = document.getElementById('asPhotoPreviewImg');
  const urlInput = document.getElementById('asPhotoUrlInput');
  const asHasVariants = document.getElementById('asHasVariants');
  const asVariantsSection = document.getElementById('asVariantsSection');
  const asSingleStockGroup = document.getElementById('asSingleStockGroup');
  const asVariantsList = document.getElementById('asVariantsList');
  const btnAddVariantRow = document.getElementById('btnAddVariantRow');

  let uploadedBase64 = null;

  const addVariantRow = (defaultColor = '', defaultStock = 5, defaultSuffix = '') => {
    if (!asVariantsList) return;
    const row = document.createElement('div');
    row.className = 'variant-row';
    row.innerHTML = `
      <input type="text" class="form-input v-color" placeholder="Color (e.g. Peacock Blue)" value="${defaultColor}">
      <input type="number" class="form-input v-stock" placeholder="Stock" min="0" value="${defaultStock}">
      <input type="text" class="form-input v-suffix" placeholder="Suffix (BLU)" value="${defaultSuffix}" style="text-transform:uppercase;">
      <button type="button" class="btn btn-sm btn-outline" style="color:var(--status-rose); border-color:transparent; padding:2px 6px;" title="Remove this variant">✕</button>
    `;
    row.querySelector('button').addEventListener('click', () => row.remove());
    asVariantsList.appendChild(row);
  };

  const closeModal = () => {
    if (modal) modal.classList.remove('active');
    uploadedBase64 = null;
    if (previewContainer) previewContainer.style.display = 'none';
  };

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (asHasVariants) {
    asHasVariants.addEventListener('change', () => {
      if (asHasVariants.checked) {
        if (asSingleStockGroup) asSingleStockGroup.style.display = 'none';
        if (asVariantsSection) asVariantsSection.style.display = 'block';
        if (asVariantsList && asVariantsList.children.length === 0) {
          addVariantRow('Royal Blue', 5, 'BLU');
          addVariantRow('Maroon Red', 5, 'RED');
        }
      } else {
        if (asSingleStockGroup) asSingleStockGroup.style.display = 'block';
        if (asVariantsSection) asVariantsSection.style.display = 'none';
      }
    });
  }

  if (btnAddVariantRow) {
    btnAddVariantRow.addEventListener('click', () => addVariantRow('', 5, ''));
  }

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      document.getElementById('asSkuInput').value = '';
      document.getElementById('asNameInput').value = '';
      document.getElementById('asPriceInput').value = '';
      document.getElementById('asMrpInput').value = '';
      document.getElementById('asStockInput').value = '5';
      document.getElementById('asFabricInput').value = '';
      document.getElementById('asWeaveInput').value = '';
      document.getElementById('asDescriptionInput').value = '';
      if (asHasVariants) asHasVariants.checked = false;
      if (asSingleStockGroup) asSingleStockGroup.style.display = 'block';
      if (asVariantsSection) asVariantsSection.style.display = 'none';
      if (asVariantsList) asVariantsList.innerHTML = '';
      if (urlInput) urlInput.value = '';
      if (previewContainer) previewContainer.style.display = 'none';
      uploadedBase64 = null;
      if (modal) modal.classList.add('active');
    });
  }

  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          uploadedBase64 = event.target.result;
          if (previewImg) previewImg.src = uploadedBase64;
          if (previewContainer) previewContainer.style.display = 'block';
          if (urlInput) urlInput.value = '';
        };
        reader.readAsDataURL(file);
      }
    });
  }

  if (urlInput) {
    urlInput.addEventListener('input', () => {
      const url = urlInput.value.trim();
      if (url.startsWith('http')) {
        uploadedBase64 = null;
        if (previewImg) previewImg.src = url;
        if (previewContainer) previewContainer.style.display = 'block';
      }
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const sku = document.getElementById('asSkuInput').value.trim();
      const name = document.getElementById('asNameInput').value.trim();
      const price = document.getElementById('asPriceInput').value.trim();
      const mrp = document.getElementById('asMrpInput').value.trim();
      const stock = document.getElementById('asStockInput').value.trim();
      const fabric = document.getElementById('asFabricInput').value.trim();
      const weave = document.getElementById('asWeaveInput').value.trim();
      const description = document.getElementById('asDescriptionInput').value.trim();
      const photoUrl = urlInput ? urlInput.value.trim() : '';

      if (!sku) return alert('Please enter a SKU / Product code (e.g. SAI-0023).');
      if (!name) return alert('Please enter the Saree title / name.');
      if (!price) return alert('Please enter the selling price.');

      let variants = null;
      let totalStock = parseInt(stock, 10) || 0;

      if (asHasVariants && asHasVariants.checked) {
        const variantRows = asVariantsList ? asVariantsList.querySelectorAll('.variant-row') : [];
        variants = [];
        totalStock = 0;
        variantRows.forEach(r => {
          const c = r.querySelector('.v-color').value.trim();
          const s = parseInt(r.querySelector('.v-stock').value, 10) || 0;
          const sfx = r.querySelector('.v-suffix').value.trim().toUpperCase();
          if (c) {
            variants.push({ color: c, stock: s, sku_suffix: sfx });
            totalStock += s;
          }
        });
        if (variants.length === 0) {
          return alert('Please enter at least one color variant with a color name.');
        }
      }

      confirmBtn.disabled = true;
      confirmBtn.innerText = 'Publishing & Indexing...';

      try {
        const syncTallyBox = document.getElementById('asSyncTallyCheckbox');
        const syncTally = syncTallyBox ? syncTallyBox.checked : true;

        const payload = {
          sku,
          name,
          price,
          mrp: mrp || price,
          stock_quantity: totalStock,
          fabric,
          weave_style: weave,
          description,
          image_base64: uploadedBase64,
          image_url: photoUrl,
          sync_tally: syncTally
        };

        if (variants && variants.length > 0) {
          payload.variants = variants;
        }

        const res = await fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to add saree');

        showToast(data.message || `Saree [${sku.toUpperCase()}] added and published.`);
        closeModal();
        await loadStoredProducts();
        await loadSystemStatus();
      } catch (err) {
        alert(`Error adding saree: ${err.message}`);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerText = 'Save & Publish Saree';
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 10. SaaS Godown Management & Strict Isolation Controller
// -----------------------------------------------------------------------------
let activeGodownName = 'Sarees';

async function loadGodownStatus() {
  try {
    const res = await fetch('/api/admin/godowns/list');
    const data = await res.json();
    if (data.success) {
      activeGodownName = data.activeGodown || 'Sarees';
      updateGodownBadgesUI(activeGodownName);

      // Populate select dropdown in modal
      const select = document.getElementById('selectSaaSTargetGodown');
      if (select && Array.isArray(data.godowns)) {
        select.innerHTML = '';
        data.godowns.forEach(g => {
          const opt = document.createElement('option');
          opt.value = g;
          opt.textContent = g;
          if (g.toLowerCase() === activeGodownName.toLowerCase()) {
            opt.selected = true;
          }
          select.appendChild(opt);
        });
      }

      // If this tenant has never completed initial setup, display wizard modal automatically!
      if (!data.isConfigured) {
        openGodownSetupModal();
      }
    }
  } catch (err) {
    console.warn('[loadGodownStatus] Error:', err.message);
  }
}

function updateGodownBadgesUI(name) {
  const badge = document.getElementById('activeGodownBadge');
  if (badge) badge.textContent = name;

  const adjLabel = document.getElementById('adjustModalGodownLabel');
  if (adjLabel) adjLabel.textContent = name;

  const asBadge = document.getElementById('asGodownBadge');
  if (asBadge) asBadge.textContent = name;

  const pillInStock = document.getElementById('pillInStock');
  if (pillInStock) pillInStock.textContent = `In Stock (${name})`;
}

function openGodownSetupModal() {
  const modal = document.getElementById('modalGodownSetup');
  if (modal) modal.classList.add('active');
}

function closeGodownSetupModal() {
  const modal = document.getElementById('modalGodownSetup');
  if (modal) modal.classList.remove('active');
}

function setupSaaSSpecificGodown() {
  const btnTrigger = document.getElementById('btnGodownSetup');
  const btnClose = document.getElementById('btnCloseGodownSetup');
  const btnCancel = document.getElementById('btnCancelGodownSetup');
  const btnSave = document.getElementById('btnSaveGodownSetup');
  const select = document.getElementById('selectSaaSTargetGodown');

  if (btnTrigger) {
    btnTrigger.addEventListener('click', () => {
      openGodownSetupModal();
    });
  }

  if (btnClose) btnClose.addEventListener('click', closeGodownSetupModal);
  if (btnCancel) btnCancel.addEventListener('click', closeGodownSetupModal);

  if (btnSave && select) {
    btnSave.addEventListener('click', async () => {
      const chosenGodown = select.value.trim();
      if (!chosenGodown) return;

      btnSave.disabled = true;
      btnSave.textContent = 'Locking Godown...';

      try {
        const res = await fetch('/api/admin/godowns/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ godown: chosenGodown })
        });
        const data = await res.json();
        if (data.success) {
          activeGodownName = data.activeGodown;
          updateGodownBadgesUI(activeGodownName);
          closeGodownSetupModal();
          showToast(`SaaS Godown locked to "${activeGodownName}". Strict isolation active.`);
          // Reload inventory & analytics
          loadStoredProducts();
          loadSalesAnalytics(currentAnalyticsPeriod);
        } else {
          alert('Failed to configure godown: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Error configuring godown: ' + err.message);
      } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Save & Lock Godown`;
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 11. Separate Sales Analytics Controller
// -----------------------------------------------------------------------------
let currentAnalyticsPeriod = '7d';

function setupSalesAnalytics() {
  const periodContainer = document.getElementById('analyticsPeriodFilter');
  if (periodContainer) {
    const pills = periodContainer.querySelectorAll('.filter-pill');
    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const period = pill.getAttribute('data-period');
        currentAnalyticsPeriod = period;
        loadSalesAnalytics(period);
      });
    });
  }

  const btnRefresh = document.getElementById('btnRefreshAnalytics');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      loadSalesAnalytics(currentAnalyticsPeriod);
      showToast('Sales analytics refreshed.');
    });
  }

  const btnSyncSheets = document.getElementById('btnSyncGoogleSheets');
  if (btnSyncSheets) {
    btnSyncSheets.addEventListener('click', async () => {
      btnSyncSheets.disabled = true;
      const oldHtml = btnSyncSheets.innerHTML;
      btnSyncSheets.innerHTML = `<span>Syncing...</span>`;
      try {
        const res = await fetch('/api/admin/sync-sheets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ period: currentAnalyticsPeriod || 'all' })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Sync failed');
        showToast(`✅ Synced ${data.count} sales records to Google Sheets!`);
      } catch (err) {
        alert('Google Sheets Sync Failed: ' + err.message);
      } finally {
        btnSyncSheets.disabled = false;
        btnSyncSheets.innerHTML = oldHtml;
      }
    });
  }
}

async function loadSalesAnalytics(period = '7d') {
  const tbody = document.getElementById('analyticsOrdersTbody');
  const kpiRev = document.getElementById('kpiRevenue');
  const kpiOrd = document.getElementById('kpiOrders');
  const kpiAOV = document.getElementById('kpiAOV');
  const kpiUnits = document.getElementById('kpiUnits');
  const topList = document.getElementById('topSareesList');
  const distList = document.getElementById('channelStatusDistribution');
  const recordBadge = document.getElementById('ordersRecordCount');

  try {
    const res = await fetch(`/api/admin/analytics/sales?period=${period}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to load sales analytics');

    const m = data.metrics || {};

    // 1. Update KPIs
    if (kpiRev) kpiRev.textContent = `₹${(m.totalRevenue || 0).toLocaleString('en-IN')}`;
    if (kpiOrd) kpiOrd.textContent = `${m.completedOrders || 0} / ${m.totalOrders || 0}`;
    if (kpiAOV) kpiAOV.textContent = `₹${(m.averageOrderValue || 0).toLocaleString('en-IN')}`;
    if (kpiUnits) kpiUnits.textContent = `${m.totalUnitsSold || 0} Pcs`;
    if (recordBadge) recordBadge.textContent = `${data.orders?.length || 0} orders`;

    // 2. Top-Selling Sarees
    if (topList) {
      const topItems = m.topSarees || [];
      if (topItems.length === 0) {
        topList.innerHTML = `<div style="color:var(--text-muted); font-size:12px; text-align:center; padding:16px;">No saree sales in this period.</div>`;
      } else {
        topList.innerHTML = topItems.map((item, idx) => `
          <div class="top-seller-item">
            <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
              <span style="font-size:11px; font-weight:700; color:var(--text-muted); width:18px;">#${idx + 1}</span>
              <span class="top-seller-name" title="${item.name}">${item.name}</span>
            </div>
            <span class="top-seller-units">${item.units} Units</span>
          </div>
        `).join('');
      }
    }

    // 3. Channels & Status Distribution
    if (distList) {
      const sBreakdown = m.statusBreakdown || {};
      const cBreakdown = m.channelBreakdown || {};
      const statusPills = Object.entries(sBreakdown).map(([st, cnt]) => `
        <span style="display:inline-flex; align-items:center; gap:6px; padding:4px 9px; background:var(--bg-canvas); border:1px solid var(--border); border-radius:var(--radius-xs); font-size:11px;">
          <span style="text-transform:capitalize; color:var(--text-secondary);">${st}:</span>
          <strong style="color:var(--text-primary); font-family:var(--font-mono);">${cnt}</strong>
        </span>
      `).join('');

      const channelPills = Object.entries(cBreakdown).map(([ch, cnt]) => `
        <span style="display:inline-flex; align-items:center; gap:6px; padding:4px 9px; background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.25); border-radius:var(--radius-xs); font-size:11px;">
          <span style="text-transform:capitalize; color:#818cf8;">${ch}:</span>
          <strong style="color:var(--text-primary); font-family:var(--font-mono);">${cnt}</strong>
        </span>
      `).join('');

      distList.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:8px;">
          <div>
            <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px;">By Channel</div>
            <div style="display:flex; flex-wrap:wrap; gap:6px;">${channelPills || '<span style="font-size:11px; color:var(--text-muted);">None</span>'}</div>
          </div>
          <div style="margin-top:4px;">
            <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px;">By Order Status</div>
            <div style="display:flex; flex-wrap:wrap; gap:6px;">${statusPills || '<span style="font-size:11px; color:var(--text-muted);">None</span>'}</div>
          </div>
        </div>
      `;
    }

    // 4. Orders Ledger Table
    if (tbody) {
      const orders = data.orders || [];
      if (orders.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="9" style="text-align:center; padding:32px; color:var(--text-muted);">
              No customer orders found in the selected timeframe.
            </td>
          </tr>
        `;
      } else {
        tbody.innerHTML = orders.map(ord => {
          const formattedDate = ord.date ? new Date(ord.date).toLocaleDateString('en-IN', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
          }) : '-';
          const badgeClass = `order-badge order-badge-${(ord.status || 'pending').toLowerCase()}`;
          return `
            <tr>
              <td style="font-family:var(--font-mono); font-weight:700; color:var(--text-primary);">${ord.order_number}</td>
              <td>
                <div style="font-weight:600; color:var(--text-primary);">${ord.customer_name}</div>
                <div style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono);">${ord.customer_phone}</div>
              </td>
              <td style="font-size:11px; color:var(--text-secondary); white-space:nowrap;">${formattedDate}</td>
              <td style="max-width:240px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${ord.items_desc}">
                ${ord.items_desc}
              </td>
              <td style="font-family:var(--font-mono); text-align:center;">${ord.item_count}</td>
              <td style="font-family:var(--font-mono); font-weight:700; color:var(--text-primary);">₹${ord.total_amount.toLocaleString('en-IN')}</td>
              <td>
                <span style="font-size:11px; text-transform:capitalize; font-weight:600; color:${ord.payment_status === 'paid' ? 'var(--status-emerald)' : 'var(--status-amber)'};">
                  ${ord.payment_status}
                </span>
              </td>
              <td>
                <span style="font-size:11px; text-transform:uppercase; font-family:var(--font-mono); color:var(--text-secondary);">
                  ${ord.channel}
                </span>
              </td>
              <td>
                <span class="${badgeClass}">${ord.status}</span>
              </td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align:center; padding:32px; color:var(--status-rose);">
            Error loading sales analytics: ${err.message}
          </td>
        </tr>
      `;
    }
  }
}


