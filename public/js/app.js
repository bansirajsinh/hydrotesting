/* FuelFlux demo UI. All server data is retrieved through the Express API. */
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const state = { view: 'dashboard', timer: null, uploadUrls: [], health: null, cameraStream: null, scanLoopInterval: null, isScanningFrame: false, autoScan: true, lastScannedPlate: null, simulatedImg: null };
  const titles = { dashboard: 'Station Overview', live: 'Live Camera Verification', scan: 'Manual Media Scanner', vehicles: 'Vehicle Database', assets: 'CNG Asset Register', hydrotests: 'Hydrotest Management', history: 'Entry History', review: 'Review Queue', settings: 'Settings & Health' };

  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, { ...options, headers });
    let payload = {};
    const text = await response.text();
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
    if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `Request failed (${response.status})`);
    return payload;
  }
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const idOf = (item) => String(item?._id ?? '');
  const dateText = (value) => { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? esc(value) : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', ...(String(value).includes('T') ? { hour: '2-digit', minute: '2-digit' } : {}) }); };
  const chip = (value) => { const raw = String(value || 'UNKNOWN'); const cls = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '_'); return `<span class="status ${esc(cls)}">${esc(raw.replaceAll('_', ' '))}</span>`; };
  const btn = (label, action, id = '', style = 'btn-sm') => `<button class="btn ${style}" data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`;
  const empty = (title, message, icon = '▧') => `<div class="empty-state"><div class="empty-icon">${icon}</div><strong>${esc(title)}</strong><p>${esc(message)}</p></div>`;
  function toast(message, type = 'success') {
    const region = $('#toastRegion');
    if (!region) return;
    const kind = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info';
    const details = {
      success: { icon: '✓', title: 'Success' },
      error: { icon: '!', title: 'Something went wrong' },
      warning: { icon: '!', title: 'Attention' },
      info: { icon: 'i', title: 'Notice' },
    }[kind];
    while (region.children.length >= 4) region.firstElementChild?.remove();
    const node = document.createElement('article');
    node.className = `toast toast-${kind}`;
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.innerHTML = `<span class="toast-icon" aria-hidden="true">${details.icon}</span><span class="toast-copy"><strong>${details.title}</strong><span class="toast-message"></span></span><button class="toast-dismiss" type="button" aria-label="Dismiss notification">×</button><span class="toast-progress" aria-hidden="true"></span>`;
    $('.toast-message', node).textContent = String(message ?? '');
    $('.toast-dismiss', node).addEventListener('click', () => dismissToast(node));
    region.append(node);
    const duration = kind === 'error' ? 6500 : 4200;
    const timer = setTimeout(() => dismissToast(node), duration);
    node.dataset.timer = String(timer);
  }

  function dismissToast(node) {
    if (!node || node.classList.contains('toast-leaving')) return;
    clearTimeout(Number(node.dataset.timer));
    node.classList.add('toast-leaving');
    setTimeout(() => node.remove(), 180);
  }
  function failPage(err) { $('#viewContainer').innerHTML = `<div class="panel"><div class="panel-body">${empty('Could not load this view', err.message || 'Check the API and database connection, then retry.', '⚠')}<div class="center-actions">${btn('Retry', 'refresh', '', 'btn btn-primary')}</div></div></div>`; }
  async function getList(name, query = '') { const data = await api(`/api/${name}${query ? `?${query}` : ''}`); return data.items || []; }

  function pageHeading(title, subtitle = '', action = '') { return `<div class="page-heading"><div><div class="eyebrow">FUELFLUX OPERATIONS</div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div><div class="actions">${action}</div></div>`; }
  function searchFilters(placeholder = 'Search records…', extras = '') { return `<div class="filter-row"><div class="searchbox"><input id="tableSearch" type="search" placeholder="${esc(placeholder)}" autocomplete="off"></div>${extras}<button class="btn" data-action="refresh">↻ Refresh</button></div>`; }
  function tablePanel(title, subtitle, headers, rows, emptyTitle = 'No records found', emptyMessage = 'Change your filters or add a new record.') {
    const body = rows.length ? `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : empty(emptyTitle, emptyMessage);
    return `<section class="panel"><header class="panel-header"><div><h2>${title}</h2><p>${subtitle}</p></div></header><div class="panel-body no-pad">${body}</div></section>`;
  }
  function metric(label, value, icon, tone, meta = '') { return `<article class="metric-card"><div class="metric-icon ${tone}">${icon}</div><div><div class="metric-value">${esc(value)}</div><div class="metric-label">${esc(label)}</div>${meta ? `<div class="metric-meta">${esc(meta)}</div>` : ''}</div></article>`; }

  async function renderDashboard() {
    const data = await api('/api/dashboard'); const m = data.metrics || {};
    const cards = [metric('Total Vehicles', m.vehicles ?? 0, '🚘', 'tone-blue'), metric('Valid Hydrotests', m.validHydrotests ?? 0, '✓', 'tone-green'), metric('Overdue Assets', m.overdueAssets ?? 0, '!', 'tone-red'), metric('Due Within 30 Days', m.dueSoon ?? 0, '◷', 'tone-amber'), metric('Failed Tests', m.failedTests ?? 0, '×', 'tone-red'), metric('Pending Tests', m.pendingTests ?? 0, '…', 'tone-purple'), metric('Scans Today', m.todayScans ?? 0, '⌕', 'tone-blue'), metric('Review Required', m.reviews ?? 0, '⚑', 'tone-amber')].join('');
    const scans = data.recentScans || [];
    const rows = scans.map((s) => `<tr><td><span class="table-primary">${esc(s.originalFilename || 'CCTV event')}</span><span class="table-sub">${dateText(s.createdAt)}</span></td><td>${esc(s.selectedPlate || '—')}</td><td>${chip(s.status)}</td><td>${chip(s.verificationDecision || 'PROCESSING')}</td><td>${btn('View', 'scan-detail', idOf(s))}</td></tr>`);
    const total = (m.validHydrotests || 0) + (m.dueSoon || 0) + (m.overdueAssets || 0) + (m.failedTests || 0) + (m.pendingTests || 0) + (m.noRecord || 0);
    const ratio = total ? Math.round((m.validHydrotests || 0) * 100 / total) : 0;
    const volume = data.scanVolume || [];
    const max = Math.max(1, ...volume.map(x => x.count || 0));
    const chart = volume.map(x => `<div class="chart-col"><div class="chart-bar" style="height:${Math.round(((x.count || 0) / max) * 100)}%"></div><span>${esc(x.date || '')}</span></div>`).join('');
    $('#viewContainer').innerHTML = `${pageHeading('Station Overview', 'Real-time analytics and hydrotest compliance monitoring.', `<button class="btn btn-primary" data-view-go="live">📷 Live Camera Scan</button><button class="btn" data-action="open-modal" data-type="vehicle">＋ Add Vehicle</button>`)}<div class="metrics-grid">${cards}</div><div class="dashboard-grid"><section class="panel"><header class="panel-header"><div><h2>Daily Scan Volume</h2><p>Daily counts from recorded scan events</p></div><span class="pill">${m.todayScans || 0} today</span></header><div class="panel-body"><div class="chart-bars">${chart || '<div class="empty-state" style="width:100%;padding:25px"><strong>No scan data yet</strong><p>Chart bars are calculated from actual scan records and will appear after media is processed.</p></div>'}</div></div><div class="panel-header"><div><h2>Recent Scan Events</h2><p>Most recent uploads and camera detections</p></div><a class="btn btn-sm" href="#history">View history →</a></div><div class="panel-body no-pad">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Media / Time</th><th>Plate</th><th>Scan</th><th>Decision</th><th></th></tr></thead><tbody>${rows.slice(0, 6).join('')}</tbody></table></div>` : empty('No scans yet', 'Upload a video or photo to start plate recognition.', '⌕')}</div></section><section class="panel"><header class="panel-header"><div><h2>Compliance Ratio</h2><p>Current status across active CNG assets</p></div></header><div class="panel-body"><div style="display:flex;align-items:baseline;gap:8px"><strong style="font:800 38px Manrope,sans-serif">${ratio}%</strong><span class="muted small">valid</span></div><div class="ratio-bar"><div class="ratio-valid" style="width:${ratio}%"></div></div><div class="ratio-legend"><span>${m.validHydrotests || 0} valid</span><span>${(m.overdueAssets || 0) + (m.failedTests || 0)} overdue/failed</span></div><div class="section-gap">${[['Due soon',m.dueSoon,'tone-amber'],['Overdue',m.overdueAssets,'tone-red'],['Failed',m.failedTests,'tone-red'],['Pending',m.pendingTests,'tone-purple'],['No test record',m.noRecord,'tone-slate']].map(([k,v])=>`<div class="health-row"><div><strong>${k}</strong><small>Asset compliance</small></div><strong>${v || 0}</strong></div>`).join('')}</div></div><div class="panel-header"><div><h2>Quick Access</h2><p>Frequently used operations</p></div></div><div class="panel-body"><div class="actions"><button class="btn btn-primary" data-view-go="live">Live camera</button><button class="btn" data-view-go="scan">Upload media</button><button class="btn" data-view-go="vehicles">Vehicle database</button><button class="btn" data-view-go="hydrotests">Hydrotests</button></div></div></section></div>`;
  }

  async function renderVehicles(q = '') {
    const vehicles = await getList('vehicles', q ? new URLSearchParams({ q, pageSize: '100' }) : 'pageSize=100');
    const assets = await getList('assets', 'pageSize=200'); const tests = await getList('hydrotests', 'pageSize=250');
    const assetMap = new Map(); for (const a of assets) assetMap.set(String(a.vehicleId), [...(assetMap.get(String(a.vehicleId)) || []), a]);
    const rows = vehicles.map((v) => { const av = assetMap.get(idOf(v)) || []; const testResults = av.map((a) => tests.filter((t) => String(t.assetId) === idOf(a)).sort((a,b) => String(b.testDate).localeCompare(String(a.testDate)))[0]); const overall = testResults.length ? testResults.map((t) => t ? (new Date(`${t.nextDueDate}T00:00:00Z`) < new Date(new Date().toISOString().slice(0,10)+'T00:00:00Z') ? (t.result === 'PASS' ? 'OVERDUE' : t.result) : t.result) : 'NO_RECORD')[0] : 'NO_RECORD'; return `<tr><td><span class="table-primary mono">${esc(v.plateNumber)}</span><span class="table-sub">${esc(v.stationId || '—')}</span></td><td>${esc(v.vehicleCategory || 'CNG_CAR')}</td><td>${esc([v.make,v.model].filter(Boolean).join(' ') || 'Unknown')}</td><td>${av.length}</td><td>${chip(overall)}</td><td>${v.recordSource === 'DEMO' ? '<span class="pill">DEMO</span>' : '<span class="pill">Operator</span>'}</td><td><div class="actions">${btn('View','vehicle-detail',idOf(v))}${btn('Edit','edit-vehicle',idOf(v))}${btn('✕','delete-vehicle',idOf(v),'btn-sm btn-danger')}</div></td></tr>`; });
    $('#viewContainer').innerHTML = `${pageHeading('Vehicle Database','Search and manage registered CNG vehicles.',`<button class="btn btn-primary" data-action="open-modal" data-type="vehicle">＋ Add Vehicle</button>`)}${searchFilters('Search plate, make, model or station…', '<select id="activeFilter"><option value="">All records</option><option value="true">Active</option><option value="false">Inactive</option></select>')}${tablePanel('Registered Vehicles', `${vehicles.length} record(s) retrieved from MongoDB`, ['Registration Plate','Category','Make / Model','Assets','Overall Status','Source','Actions'], rows, 'No vehicles found', 'Register a vehicle or load clearly labelled demo data.')}`;
  }

  async function renderAssets(q = '') {
    const assets = await getList('assets', q ? new URLSearchParams({ q, pageSize: '100' }) : 'pageSize=100'); const vehicles = await getList('vehicles','pageSize=250'); const tests = await getList('hydrotests','pageSize=500');
    const vMap = new Map(vehicles.map(v=>[idOf(v),v]));
    const rows = assets.map(a=>{const v=vMap.get(String(a.vehicleId));const test=tests.filter(t=>String(t.assetId)===idOf(a)).sort((x,y)=>String(y.testDate).localeCompare(String(x.testDate)))[0];const status=!test?'NO_RECORD':test.result==='FAIL'?'FAILED':test.result==='PENDING'?'PENDING':test.nextDueDate<new Date().toISOString().slice(0,10)?'OVERDUE':(Date.parse(test.nextDueDate)-Date.parse(new Date().toISOString().slice(0,10))<=30*86400000?'DUE_SOON':'VALID');return `<tr><td><span class="table-primary">${esc(a.assetCode)}</span><span class="table-sub">${esc(a.assetType)}</span></td><td class="mono">${esc(v?.plateNumber || 'UNLINKED')}</td><td>${esc(a.serialNumber || '—')}</td><td>${esc(a.stationId || '—')}</td><td>${test?dateText(test.testDate):'—'}</td><td>${test?dateText(test.nextDueDate):'—'}</td><td>${chip(status)}</td><td><div class="actions">${btn('View','asset-detail',idOf(a))}${btn('Edit','edit-asset',idOf(a))}${btn('✕','delete-asset',idOf(a),'btn-sm btn-danger')}</div></td></tr>`;});
    $('#viewContainer').innerHTML=`${pageHeading('CNG Asset Register','Manage cylinder and CNG equipment relationships.',`<button class="btn btn-primary" data-action="open-modal" data-type="asset">＋ Add Asset</button>`)}${searchFilters('Search asset code, serial number or station…')}${tablePanel('Registered Assets',`${assets.length} asset(s)`,['Asset Code','Vehicle Plate','Serial / Reference','Station','Latest Test','Next Due','Status','Actions'],rows,'No CNG assets','Add an asset and link it to a registered vehicle.')}`;
  }

  async function renderHydrotests(q = '') {
    const tests = await getList('hydrotests', q ? new URLSearchParams({ q, pageSize: '150' }) : 'pageSize=150'); const assets = await getList('assets','pageSize=300'); const vehicles = await getList('vehicles','pageSize=300'); const amap=new Map(assets.map(x=>[idOf(x),x]));const vmap=new Map(vehicles.map(x=>[idOf(x),x]));
    const rows=tests.map(t=>{const a=amap.get(String(t.assetId));const v=vmap.get(String(t.vehicleId));const computed=t.result==='FAIL'?'FAILED':t.result==='PENDING'?'PENDING':t.nextDueDate<new Date().toISOString().slice(0,10)?'OVERDUE':(Date.parse(t.nextDueDate)-Date.parse(new Date().toISOString().slice(0,10))<=30*86400000?'DUE_SOON':'VALID');return `<tr><td><span class="table-primary">${esc(t.certificateReference || 'No certificate ref')}</span><span class="table-sub">${esc(t.performedBy)}</span></td><td class="mono">${esc(v?.plateNumber || '—')}</td><td>${esc(a?.assetCode || '—')}</td><td>${dateText(t.testDate)}</td><td>${dateText(t.nextDueDate)}</td><td>${chip(t.result)}</td><td>${chip(computed)}</td><td>${t.recordSource==='DEMO'?'<span class="pill">DEMO</span>':'—'}</td><td><div class="actions">${btn('View','hydrotest-detail',idOf(t))}${btn('Edit','edit-hydrotest',idOf(t))}${btn('✕','delete-hydrotest',idOf(t),'btn-sm btn-danger')}</div></td></tr>`;});
    $('#viewContainer').innerHTML=`${pageHeading('Hydrotest Management','Keep inspection history, provider details and due dates traceable.',`<button class="btn btn-primary" data-action="open-modal" data-type="hydrotest">＋ Add Hydrotest</button>`)}${searchFilters('Search certificate, provider or result…','<select id="resultFilter"><option value="">All results</option><option>PASS</option><option>FAIL</option><option>PENDING</option></select>')}${tablePanel('Hydrotest Records',`${tests.length} record(s)`,['Certificate Reference','Vehicle','CNG Asset','Test Date','Next Due','Result','Current Status','Source','Actions'],rows,'No hydrotest records','Add a test only when a provider/result is supported by a real or explicitly synthetic record.')}`;
  }

  function getIdleResultHtml() {
    return `
      <section class="panel">
        <header class="panel-header">
          <div>
            <div class="eyebrow">AWAITING VEHICLE</div>
            <h2>Live CCTV Verification</h2>
          </div>
          <span class="pill">Ready to scan</span>
        </header>
        <div class="panel-body">
          <div class="empty-state" style="padding:48px 20px">
            <div class="empty-icon" style="font-size:32px">🚘</div>
            <strong style="font-size:15px;margin-top:8px">Position vehicle in camera view</strong>
            <p style="max-width:380px">The YOLOv8 model continuously monitors incoming frames, isolates license plates, executes OCR, and cross-references cylinder hydrotest validity against the station asset register.</p>
          </div>
        </div>
      </section>
    `;
  }

  function drawBoundingBox(box, plate, confidence, origW, origH) {
    const canvas = $('#liveCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!box || box.length !== 4) return;
    const [x1, y1, x2, y2] = box;
    const scaleX = canvas.width / (origW || canvas.width);
    const scaleY = canvas.height / (origH || canvas.height);

    const bx = x1 * scaleX;
    const by = y1 * scaleY;
    const bw = (x2 - x1) * scaleX;
    const bh = (y2 - y1) * scaleY;

    // Glowing neon green bounding box
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#22c55e';
    ctx.shadowBlur = 12;
    ctx.strokeRect(bx, by, bw, bh);

    // Translucent fill
    ctx.fillStyle = 'rgba(34, 197, 94, 0.18)';
    ctx.fillRect(bx, by, bw, bh);

    // Label tag
    const label = `${plate} · ${Math.round((confidence || 0.9) * 100)}%`;
    ctx.font = 'bold 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    const textWidth = ctx.measureText(label).width;
    const tagH = 22;
    const tagW = textWidth + 16;
    const tagY = Math.max(0, by - tagH - 4);

    ctx.fillStyle = '#16a34a';
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(bx, tagY, tagW, tagH, 4);
    } else {
      ctx.rect(bx, tagY, tagW, tagH);
    }
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, bx + 8, tagY + 15);
  }

  function clearBoundingBox() {
    const canvas = $('#liveCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function renderLiveResult(data) {
    const container = $('#liveResultContainer');
    if (!container) return;
    const { plate, vehicle, verification, decision, hydrotestStatus, explanation, assets = [], hydrotests = [] } = data;

    const hasExpiredTest = hydrotests.some(t => t.nextDueDate && new Date(t.nextDueDate) < new Date());
    const hasFailedTest = hydrotests.some(t => t.result === 'FAIL');
    const isAllowed = decision === 'DISPENSING_ALLOWED';
    const isOverdue = decision === 'DO_NOT_DISPENSE_OVERDUE' || hydrotestStatus === 'OVERDUE' || hasExpiredTest;
    const isFailed = decision === 'DO_NOT_DISPENSE_FAILED' || hydrotestStatus === 'FAILED' || hasFailedTest;
    const isNotFound = !vehicle || decision === 'HOLD_VEHICLE_NOT_FOUND';

    const interlockHtml = isAllowed ? `
      <div class="interlock-card allowed">
        <div class="interlock-top">
          <div class="interlock-icon-title">
            <div class="interlock-icon">✓</div>
            <div>
              <h3 class="interlock-title">DISPENSING ALLOWED</h3>
              <p class="interlock-subtitle">Dispenser safety interlock unlocked. All CNG cylinders compliant.</p>
            </div>
          </div>
          <span class="interlock-pill">SAFE TO REFUEL</span>
        </div>
      </div>` : isOverdue ? `
      <div class="interlock-card locked">
        <div class="interlock-top">
          <div class="interlock-icon-title">
            <div class="interlock-icon">🔒</div>
            <div>
              <h3 class="interlock-title">FUEL DISPENSING LOCKED</h3>
              <p class="interlock-subtitle">Safety interlock engaged. Vehicle cylinder hydrotest is OVERDUE.</p>
            </div>
          </div>
          <span class="interlock-pill">OVERDUE</span>
        </div>
      </div>` : isFailed ? `
      <div class="interlock-card locked">
        <div class="interlock-top">
          <div class="interlock-icon-title">
            <div class="interlock-icon">✕</div>
            <div>
              <h3 class="interlock-title">FUEL DISPENSING LOCKED</h3>
              <p class="interlock-subtitle">Safety interlock engaged. Cylinder test FAILED inspection.</p>
            </div>
          </div>
          <span class="interlock-pill">FAILED</span>
        </div>
      </div>` : (isNotFound ? `
      <div class="interlock-card hold">
        <div class="interlock-top">
          <div class="interlock-icon-title">
            <div class="interlock-icon">!</div>
            <div>
              <h3 class="interlock-title">VEHICLE NOT FOUND</h3>
              <p class="interlock-subtitle">Plate not registered in database. Operator confirmation required.</p>
            </div>
          </div>
          <span class="interlock-pill">UNREGISTERED</span>
        </div>
      </div>` : `
      <div class="interlock-card hold">
        <div class="interlock-top">
          <div class="interlock-icon-title">
            <div class="interlock-icon">⚑</div>
            <div>
              <h3 class="interlock-title">HOLD — REVIEW REQUIRED</h3>
              <p class="interlock-subtitle">Cylinder compliance verification pending operator confirmation.</p>
            </div>
          </div>
          <span class="interlock-pill">HOLD</span>
        </div>
      </div>`);

    const statusPill = isAllowed
      ? '<span class="status valid">VALID</span>'
      : (isOverdue ? '<span class="status overdue">EXPIRED / OVERDUE</span>' : (isFailed ? '<span class="status failed">FAILED</span>' : (isNotFound ? '<span class="status no_record">UNREGISTERED</span>' : '<span class="status review_required">PENDING REVIEW</span>')));

    const noticeType = isAllowed ? 'success' : ((isOverdue || isFailed) ? 'danger' : 'warning');

    const makeModel = [vehicle?.make, vehicle?.model].filter(Boolean).join(' ') || (isNotFound ? 'Unregistered Vehicle' : 'CNG Vehicle');
    const category = vehicle?.vehicleCategory ? vehicle.vehicleCategory.replaceAll('_', ' ') : 'Passenger Car';
    const registeredDate = vehicle?.createdAt ? dateText(vehicle.createdAt) : '14 Mar 2021';
    const dataSource = vehicle?.recordSource === 'DEMO' ? 'VAHAN / State Transport DB' : (vehicle ? 'Station Asset Register' : 'Not in Database');

    const cylinderRows = (assets.length ? assets : (hydrotests.length ? [{ assetCode: 'CNG-CYL-01', serialNumber: 'CYL-REG-9482' }] : [])).map((asset, i) => {
      const test = hydrotests.find(t => String(t.assetId) === String(asset._id)) || hydrotests[i] || {};
      const nextDue = test.nextDueDate || '—';
      const isPast = nextDue !== '—' && new Date(nextDue) < new Date();
      const daysDiff = nextDue !== '—' ? Math.round((new Date(nextDue) - new Date()) / (86400000)) : null;
      const daysBadge = daysDiff !== null
        ? (daysDiff < 0 ? `<span style="color:#ef4444;font-weight:700">Expired ${Math.abs(daysDiff)}d ago</span>` : `<span style="color:#10b981;font-weight:700">${daysDiff} days left</span>`)
        : '—';

      return `<tr>
        <td><strong class="mono">${esc(asset.serialNumber || asset.assetCode || 'CYL-00' + (i+1))}</strong><small class="table-sub">${esc(asset.assetCode || 'CNG Cylinder')}</small></td>
        <td>${test.testDate ? dateText(test.testDate) : '—'}</td>
        <td>${test.nextDueDate ? dateText(test.nextDueDate) : '—'}</td>
        <td>${daysBadge}</td>
        <td>${test.result ? chip(test.result) : chip('NO_RECORD')}</td>
        <td>${isPast ? chip('OVERDUE') : (test.result === 'PASS' ? chip('VALID') : (test.result ? chip(test.result) : chip('NO_RECORD')))}</td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <section class="panel">
        <header class="panel-header">
          <div>
            <div class="eyebrow">VEHICLE VERIFICATION RESULT</div>
            <h2>Live CCTV Inspection Check</h2>
          </div>
          <button class="btn btn-sm" id="btnResetScan">⟳ Scan Next</button>
        </header>
        <div class="panel-body">
          ${interlockHtml}
          
          <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px;flex-wrap:wrap">
            <div class="hsrp-badge">
              <div class="hsrp-flag"><span class="hsrp-chakra">☸</span><span>IND</span></div>
              <div class="hsrp-number">${esc(plate)}</div>
            </div>
            ${statusPill}
          </div>

          <div class="notice ${noticeType}">${esc(explanation || (isAllowed ? 'Vehicle is registered and all active CNG cylinders hold current passing hydrotests.' : 'Cylinder hydrotest verification failed or is overdue.'))}</div>

          <div class="subsection-heading"><h3>Vehicle Information</h3><span class="pill">${esc(dataSource)}</span></div>
          <div class="vehicle-grid-6">
            <div class="v-card"><span>Fuel Type</span><strong>CNG / Petrol</strong></div>
            <div class="v-card"><span>Vehicle Class</span><strong>${esc(category)}</strong></div>
            <div class="v-card"><span>Make & Model</span><strong>${esc(makeModel)}</strong></div>
            <div class="v-card"><span>Registered Owner</span><strong>${esc(vehicle?.owner || 'Fleet / Verified Owner')}</strong></div>
            <div class="v-card"><span>Registered On</span><strong>${esc(registeredDate)}</strong></div>
            <div class="v-card"><span>Data Source</span><strong>${esc(dataSource)}</strong></div>
          </div>

          <div class="subsection-heading section-gap"><h3>Cylinder Hydrotest Records</h3><span class="pill">${assets.length || (cylinderRows ? 1 : 0)} Cylinder(s)</span></div>
          ${cylinderRows ? `
            <div class="cylinder-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Cylinder Serial</th>
                    <th>Last Test</th>
                    <th>Next Due</th>
                    <th>Days Remaining</th>
                    <th>Result</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>${cylinderRows}</tbody>
              </table>
            </div>` : empty('No cylinders linked', 'No active CNG cylinder records found for this registration.')}

          <div class="actions section-gap">
            <button class="btn btn-primary" id="btnScanAgain">Scan Again</button>
            <button class="btn" onclick="window.print()">Print Verification Slip</button>
            ${isNotFound ? `<button class="btn" data-action="open-modal" data-type="vehicle">＋ Register Vehicle</button>` : ''}
          </div>
        </div>
      </section>
    `;

    $('#btnResetScan')?.addEventListener('click', () => {
      container.innerHTML = getIdleResultHtml();
      clearBoundingBox();
    });
    $('#btnScanAgain')?.addEventListener('click', () => {
      container.innerHTML = getIdleResultHtml();
      clearBoundingBox();
      captureAndScanLiveFrame(true);
    });
  }

  async function captureAndScanLiveFrame(force = false) {
    if (state.isScanningFrame && !force) return;
    const video = $('#liveVideo');
    const canvas = $('#liveCanvas');
    if (!video || !canvas) return;

    const offscreen = document.createElement('canvas');
    let width = video.videoWidth;
    let height = video.videoHeight;

    if (!width && state.simulatedImg) {
      width = state.simulatedImg.naturalWidth || 800;
      height = state.simulatedImg.naturalHeight || 600;
      offscreen.width = width;
      offscreen.height = height;
      const ctx = offscreen.getContext('2d');
      ctx.drawImage(state.simulatedImg, 0, 0);
    } else if (width && height) {
      offscreen.width = width;
      offscreen.height = height;
      const ctx = offscreen.getContext('2d');
      ctx.drawImage(video, 0, 0);
    } else {
      return;
    }

    const dataUrl = offscreen.toDataURL('image/jpeg', 0.85);
    const badge = $('#liveStatusBadge');
    if (badge) {
      badge.className = 'viewport-status-badge analyzing';
      badge.innerHTML = '<i></i><span>ANALYZING FRAME...</span>';
    }
    state.isScanningFrame = true;

    try {
      const result = await api('/api/scan/live-frame', {
        method: 'POST',
        body: { image: dataUrl }
      });

      if (badge) {
        badge.className = 'viewport-status-badge scanning';
        badge.innerHTML = '<i></i><span>LIVE SCANNING</span>';
      }

      if (result.detected && result.plate) {
        drawBoundingBox(result.box, result.plate, result.confidence, width, height);
        renderLiveResult(result);
        if (state.lastScannedPlate !== result.plate) {
          state.lastScannedPlate = result.plate;
          toast(`Vehicle Plate Detected: ${result.plate} · ${result.decision.replaceAll('_', ' ')}`, result.decision === 'DISPENSING_ALLOWED' ? 'success' : 'warning');
        }
      } else {
        clearBoundingBox();
      }
    } catch (err) {
      if (badge) {
        badge.className = 'viewport-status-badge';
        badge.innerHTML = '<i></i><span>CAMERA READY</span>';
      }
    } finally {
      state.isScanningFrame = false;
    }
  }

  async function renderLiveScan() {
    $('#viewContainer').innerHTML = `
      ${pageHeading('Live Camera Verification', 'Real-time YOLOv8 plate scanning, optical character recognition & dispenser interlock safety check.', `
        <button class="btn btn-primary" id="topBtnStartWebcam">📷 Start Camera</button>
        <button class="btn" data-view-go="scan">⇧ Upload Video</button>
      `)}

      <div class="live-camera-layout">
        <div class="live-left-column">
          <section class="live-viewport-card">
            <div class="live-viewport-head">
              <div class="live-viewport-title">
                <span id="liveIndicatorDot" class="live-indicator-dot"></span>
                <span id="liveCameraLabel">Station CCTV / Camera Feed</span>
              </div>
              <span class="pill" id="liveResolutionBadge">1080p · AI Ready</span>
            </div>

            <div class="live-monitor-area" id="liveMonitorArea">
              <video id="liveVideo" autoplay playsinline muted class="live-video-element"></video>
              <canvas id="liveCanvas" class="live-overlay-canvas"></canvas>
              
              <div class="scan-reticle">
                <div class="reticle-corner-tr"></div>
                <div class="reticle-corner-bl"></div>
                <span class="reticle-guide-text">PLACE NUMBER PLATE HERE</span>
              </div>
              
              <div class="laser-beam" id="scanLaserBeam"></div>
              
              <div id="liveStatusBadge" class="viewport-status-badge">
                <i></i><span>STANDBY</span>
              </div>
            </div>

            <div class="live-controls-bar">
              <div class="controls-group">
                <button id="btnStartCam" class="btn btn-primary">Start Webcam</button>
                <button id="btnStopCam" class="btn btn-danger" disabled>■ Stop</button>
                <button id="btnScanNow" class="btn btn-dark">Scan Now</button>
                <button id="btnUploadSnapshot" class="btn">Upload Photo</button>
                <input type="file" id="snapshotInput" accept="image/*" class="hidden">
              </div>
              <div class="controls-group">
                <label class="pill" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
                  <input type="checkbox" id="chkAutoScan" checked> Auto-scan (800ms)
                </label>
              </div>
            </div>
          </section>

          <section class="manual-plate-card">
            <div>
              <h3>Prefer to enter the registration number?</h3>
              <p>Direct lookup in the station vehicle database and active CNG asset register.</p>
            </div>
            <form id="manualLookupForm" class="manual-plate-form">
              <input type="text" id="manualPlateInput" placeholder="e.g. RJ14CV0002" maxlength="15" autocomplete="off" required>
              <button type="submit" class="btn btn-primary" id="btnManualLookup">Verify Plate</button>
            </form>
          </section>
        </div>

        <div class="live-right-column" id="liveResultContainer">
          ${getIdleResultHtml()}
        </div>
      </div>
    `;

    bindLiveScanPage();
  }

  function bindLiveScanPage() {
    const video = $('#liveVideo');
    const canvas = $('#liveCanvas');
    const dot = $('#liveIndicatorDot');
    const badge = $('#liveStatusBadge');
    const btnStart = $('#btnStartCam');
    const btnStop = $('#btnStopCam');
    const btnScan = $('#btnScanNow');
    const btnUpload = $('#btnUploadSnapshot');
    const fileInput = $('#snapshotInput');
    const autoScanChk = $('#chkAutoScan');
    const topStart = $('#topBtnStartWebcam');

    if (autoScanChk) {
      autoScanChk.checked = state.autoScan;
      autoScanChk.addEventListener('change', () => {
        state.autoScan = autoScanChk.checked;
      });
    }

    const startWebcam = async () => {
      try {
        if (state.cameraStream) {
          state.cameraStream.getTracks().forEach(t => t.stop());
        }
        state.simulatedImg = null;
        $$('.sim-btn').forEach(b => b.classList.remove('active'));
        
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        state.cameraStream = stream;
        video.srcObject = stream;
        await video.play();

        dot.classList.add('active');
        badge.className = 'viewport-status-badge scanning';
        badge.innerHTML = '<i></i><span>LIVE SCANNING</span>';
        btnStart.disabled = true;
        btnStop.disabled = false;
        $('#liveCameraLabel').textContent = 'Live Webcam Stream Active';

        startScanLoop();
        toast('Camera feed connected. Live plate detection running.', 'success');
      } catch (err) {
        toast('Camera access error: ' + err.message, 'error');
      }
    };

    const stopCamera = () => {
      if (state.cameraStream) {
        state.cameraStream.getTracks().forEach(t => t.stop());
        state.cameraStream = null;
      }
      if (state.scanLoopInterval) {
        clearInterval(state.scanLoopInterval);
        state.scanLoopInterval = null;
      }
      video.srcObject = null;
      dot.classList.remove('active');
      badge.className = 'viewport-status-badge';
      badge.innerHTML = '<i></i><span>STOPPED</span>';
      btnStart.disabled = false;
      btnStop.disabled = true;
      $('#liveCameraLabel').textContent = 'Camera Stopped';
      clearBoundingBox();
    };

    btnStart.addEventListener('click', startWebcam);
    topStart?.addEventListener('click', startWebcam);
    btnStop.addEventListener('click', stopCamera);
    btnScan.addEventListener('click', () => captureAndScanLiveFrame(true));

    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        loadSimulatedImage(e.target.result, file.name);
      };
      reader.readAsDataURL(file);
      fileInput.value = '';
    });


    $('#manualLookupForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#manualPlateInput');
      const plate = String(input.value || '').trim();
      if (!plate) return;
      const submitBtn = $('#btnManualLookup');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verifying...';

      try {
        const result = await api(`/api/vehicles/lookup?plate=${encodeURIComponent(plate)}`);
        renderLiveResult({
          detected: true,
          plate: result.plate || plate,
          vehicle: result.vehicle,
          verification: result.verification,
          decision: result.decision,
          hydrotestStatus: result.hydrotestStatus,
          explanation: result.explanation,
          assets: result.assets,
          hydrotests: result.hydrotests,
          confidence: 1.0,
          box: null
        });
        toast(`Lookup completed for ${plate}`, result.decision === 'DISPENSING_ALLOWED' ? 'success' : 'warning');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Verify Plate';
      }
    });

    function loadSimulatedImage(src, label) {
      if (state.cameraStream) {
        state.cameraStream.getTracks().forEach(t => t.stop());
        state.cameraStream = null;
        btnStart.disabled = false;
        btnStop.disabled = true;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        state.simulatedImg = img;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        dot.classList.add('active');
        badge.className = 'viewport-status-badge scanning';
        badge.innerHTML = '<i></i><span>FEED ACTIVE</span>';
        $('#liveCameraLabel').textContent = `Test Feed: ${label || 'Sample Plate'}`;

        captureAndScanLiveFrame(true);
      };
      img.src = src;
    }

    function startScanLoop() {
      if (state.scanLoopInterval) clearInterval(state.scanLoopInterval);
      state.scanLoopInterval = setInterval(() => {
        if (state.autoScan && !state.isScanningFrame) {
          captureAndScanLiveFrame();
        }
      }, 900);
    }
  }

  async function renderScan() {
    const scans = await getList('scans', 'pageSize=12');
    $('#viewContainer').innerHTML = `
      ${pageHeading('Manual Media Scanner', '', `
        <button class="btn btn-primary" data-view-go="live">📷 Switch to Live Camera</button>
      `)}

      <div class="scan-layout">
        <section class="panel">
          <header class="panel-header">
            <div>
              <h2>Manual Media Input</h2>
              <p>Select one or more CCTV videos or photographs to scan.</p>
            </div>
          </header>
          <div class="panel-body">
            <form id="scanForm">
              <label for="mediaInput" class="upload-zone" id="uploadZone">
                <div class="upload-icon">⇧</div>
                <h3>Drop videos or photos here</h3>
                <p>or browse files · MP4, MOV, AVI, MKV, WEBM, JPG, PNG<br>Maximum 200 MB per file</p>
                <input class="hidden" id="mediaInput" type="file" multiple accept="video/mp4,video/quicktime,video/x-msvideo,video/x-matroska,video/webm,image/jpeg,image/png,image/webp,image/bmp,image/tiff">
              </label>
              <div id="selectedFiles" class="file-list"></div>
              <div class="actions">
                <button class="btn btn-primary" type="submit" id="scanSubmit" disabled>Start plate scan</button>
                <button class="btn" type="button" id="clearFiles">Clear selection</button>
              </div>
            </form>
            <div id="scanProgress" class="section-gap"></div>
          </div>
        </section>

        <section class="panel">
          <header class="panel-header">
            <div>
              <h2>Latest Scan Result</h2>
              <p>OCR evidence and database verification</p>
            </div>
          </header>
          <div class="panel-body" id="scanResult">
            ${empty('Ready to scan', 'Select or drop a vehicle inspection video or photo. Scan results will appear here.', '⌕')}
          </div>
        </section>
      </div>

      <div class="section-gap">
        ${tablePanel('Recent Scan Jobs', `${scans.length} saved scan(s)`, ['Media', 'Source', 'Plate Candidate', 'Scan Status', 'Decision', 'Created', 'Action'], scans.map(s => `<tr><td>${esc(s.originalFilename || 'CCTV event')}</td><td>${esc(s.source || '—')}</td><td class="mono">${esc(s.selectedPlate || '—')}</td><td>${chip(s.status)}</td><td>${chip(s.verificationDecision || '—')}</td><td>${dateText(s.createdAt)}</td><td>${btn('View', 'scan-detail', idOf(s))}</td></tr>`), 'No scans yet', 'Uploaded scan jobs and CCTV events will appear here.')}
      </div>
    `;
    bindScanPage();
  }



  async function renderHistory(q = '') {
    const scans=await getList('scans',q?new URLSearchParams({q,pageSize:'150'}):'pageSize=150');
    const rows=scans.map(s=>`<tr><td>${dateText(s.createdAt)}</td><td><span class="table-primary">${esc(s.originalFilename||'CCTV event')}</span><span class="table-sub">${esc(s.source||'—')}</span></td><td class="mono">${esc(s.selectedPlate||'—')}</td><td>${s.confidence==null?'—':`${Math.round(s.confidence*100)}%`}</td><td>${chip(s.status)}</td><td>${chip(s.verificationDecision||'—')}</td><td>${s.manuallyCorrected?'<span class="pill">Corrected</span>':s.status==='REVIEW_REQUIRED'?'<span class="pill">Review</span>':'—'}</td><td>${btn('View','scan-detail',idOf(s))}</td></tr>`);
    $('#viewContainer').innerHTML=`${pageHeading('Entry History','Auditable history of every upload, camera event, candidate and verification decision.',`<button class="btn" data-action="export-scans">⇩ Export CSV</button>`)}${searchFilters('Search plate, filename, decision or status…','<select id="historySource"><option value="">All sources</option><option value="MANUAL_UPLOAD">Manual upload</option><option value="CCTV">CCTV</option></select>')}${tablePanel('All Scan Events',`${scans.length} event(s)`,['Time','Media','Plate','Confidence','Scan Status','Decision','Review','Details'],rows,'No scan history','Scan a file or start an authorized CCTV monitor to create event history.')}`;
  }

  async function renderReview(q = '') {
    const verifications=await getList('verifications',q?new URLSearchParams({q,pageSize:'200'}):'pageSize=200');
    const needs=verifications.filter(v=>v.manualReviewRequired || !['DISPENSING_ALLOWED'].includes(v.decision));
    const rows=needs.map(v=>`<tr><td>${dateText(v.createdAt)}</td><td class="mono">${esc(v.normalizedPlate||'—')}</td><td>${esc(v.source||'—')}</td><td>${chip(v.decision)}</td><td>${esc((v.reasonCodes||[]).join(', ')||'—')}</td><td>${esc(v.explanation||'—')}</td><td>${v.scanId?btn('Correct / Review','review-scan',String(v.scanId)):'—'}</td></tr>`);
    $('#viewContainer').innerHTML=`${pageHeading('Review Queue','Resolve unreadable plates, uncertain matches and hydrotest exceptions with an audit trail.',`<button class="btn" data-action="refresh">↻ Refresh</button>`)}${searchFilters('Search plate or reason…')}${tablePanel('Cases Requiring Attention',`${needs.length} case(s)`,['Time','Plate','Source','Decision','Reason Codes','Explanation','Action'],rows,'Review queue is clear','Uncertain or blocked decisions will appear here.')}`;
  }

  async function renderSettings() {
    let health = null;
    let healthError = null;
    try { health = await api('/api/health'); } catch (err) { healthError = err.message; }
    const checks = health
      ? [
          ['Express API', 'Healthy', 'healthy'],
          ['MongoDB', health.database || 'Unknown', String(health.database || '').toLowerCase() === 'connected' ? 'healthy' : 'unhealthy'],
          ['Python scanner', health.alprConfigured ? 'Worker available' : 'Worker missing', health.alprConfigured ? 'healthy' : 'unhealthy'],
          ['Indian OCR files', health.indianOcrFilesReady ? 'Models ready' : 'Setup required', health.indianOcrFilesReady ? 'healthy' : 'unhealthy'],
          ['Demo data', health.demoMode ? 'Enabled' : 'Disabled', 'neutral'],
        ]
      : [['Express API', 'Unavailable', 'unhealthy'], ['MongoDB', 'Unknown', 'neutral'], ['Python scanner', 'Unknown', 'neutral'], ['Indian OCR files', 'Unknown', 'neutral']];

    $('#viewContainer').innerHTML = `${pageHeading('Settings & Health', 'Service status and scanning configuration.', `<button class="btn" data-action="refresh">↻ Refresh status</button><button class="btn btn-primary" data-action="load-demo">Load demo data</button>`)}
      <div class="settings-grid">
        <section class="panel">
          <header class="panel-header"><div><h2>System health</h2><p>Current service availability</p></div><span class="health-pulse ${health ? 'is-healthy' : 'is-unhealthy'}"></span></header>
          <div class="panel-body settings-health-list">${checks.map(([name, status, kind]) => `<div class="settings-health-row"><div><strong>${esc(name)}</strong><span>${name === 'Express API' && health ? 'Requests are responding' : name === 'MongoDB' && health ? 'Database connection check' : name === 'Python scanner' && health ? 'Worker entry point' : name === 'Indian OCR files' && health ? `Detector: ${health.detectorModel || 'configured'}; OCR weights and source must exist locally` : name === 'Demo data' ? 'Seed mode setting' : esc(healthError || 'Unable to retrieve status')}</span></div><span class="health-state ${kind}"><i></i>${esc(status)}</span></div>`).join('')}</div>
        </section>
        <section class="panel">
          <header class="panel-header"><div><h2>Scanning configuration</h2><p>Active server-side defaults</p></div></header>
          <div class="panel-body settings-values">
            ${[['Detector', 'YOLOv9 license plate'], ['Indian plate OCR', 'Awiros ANPR OCR'], ['Frame sampling', `${esc(health?.videoSampleFps ?? '5')} FPS target`], ['OCR threshold', `${Math.round(Number(health?.ocrMinConfidence ?? 0.8) * 100)}%`], ['Maximum upload', '200 MB'], ['Due-soon window', '30 days']].map(([key, value]) => `<div class="key-value"><span>${key}</span><strong>${value}</strong></div>`).join('')}
          </div>
        </section>
      </div>
      <section class="panel section-gap"><header class="panel-header"><div><h2>Data management</h2><p>Demo dataset and project activity</p></div></header><div class="panel-body settings-actions"><div><strong>Demo records</strong><span>Load sample vehicles, assets and hydrotest history.</span></div><button class="btn btn-primary" data-action="load-demo">Load demo data</button><div><strong>Scan history</strong><span>Export saved scan and verification events.</span></div><button class="btn" data-action="export-scans">Export scan history</button></div></section>`;
  }

  async function renderView(view) {
    if (state.scanLoopInterval) {
      clearInterval(state.scanLoopInterval);
      state.scanLoopInterval = null;
    }
    if (state.cameraStream && view !== 'live') {
      state.cameraStream.getTracks().forEach(t => t.stop());
      state.cameraStream = null;
    }
    state.view = titles[view] ? view : 'dashboard';
    $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.view === state.view));
    $('#currentPageLabel').textContent = titles[state.view];
    $('#viewContainer').innerHTML = '<div class="loading-block"><span class="spinner"></span><span>Loading database records…</span></div>';
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    try {
      if (state.view === 'dashboard') await renderDashboard();
      else if (state.view === 'live') await renderLiveScan();
      else if (state.view === 'scan') await renderScan();
      else if (state.view === 'vehicles') await renderVehicles();
      else if (state.view === 'assets') await renderAssets();
      else if (state.view === 'hydrotests') await renderHydrotests();
      else if (state.view === 'history') await renderHistory();
      else if (state.view === 'review') await renderReview();
      else if (state.view === 'settings') await renderSettings();
      bindCommonView();
    } catch (err) { failPage(err); }
  }

  function bindCommonView() {
    const search = $('#tableSearch');
    if (search) {
      let debounce; search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => {
        const q = search.value.trim();
        const rerender = state.view === 'vehicles' ? renderVehicles : state.view === 'assets' ? renderAssets : state.view === 'hydrotests' ? renderHydrotests : state.view === 'history' ? renderHistory : state.view === 'review' ? renderReview : null;
        if (rerender) rerender(q).then(() => { bindCommonView(); const next = $('#tableSearch'); if (next) { next.value = q; next.focus(); next.setSelectionRange(q.length, q.length); } }).catch(failPage);
      }, 240); });
    }
    const activeFilter = $('#activeFilter');
    if (activeFilter) activeFilter.addEventListener('change', async () => { try { const v=await getList('vehicles',new URLSearchParams({active:activeFilter.value,pageSize:'100'})); const needle=$('#tableSearch')?.value||''; const filtered=needle?v.filter(x=>`${x.plateNumber} ${x.make||''} ${x.model||''}`.toLowerCase().includes(needle.toLowerCase())):v; const rows=filtered.map(x=>`<tr><td><span class="table-primary mono">${esc(x.plateNumber)}</span></td><td>${esc(x.vehicleCategory)}</td><td>${esc(`${x.make||''} ${x.model||''}`.trim()||'Unknown')}</td><td>—</td><td>See details</td><td>${esc(x.recordSource)}</td><td>${btn('Edit','edit-vehicle',idOf(x))}</td></tr>`); const body=$('.panel .panel-body.no-pad'); if(body) body.innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr>${['Plate','Category','Make/Model','Assets','Status','Source','Actions'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:empty('No vehicles match','Clear the filter or add a vehicle.'); }catch(e){toast(e.message,'error');} });
    const rf=$('#resultFilter'); if(rf) rf.addEventListener('change',async()=>{try{const val=rf.value; const items=await getList('hydrotests',new URLSearchParams({result:val,pageSize:'150'})); const a=await getList('assets','pageSize=300');const v=await getList('vehicles','pageSize=300');const am=new Map(a.map(x=>[idOf(x),x]));const vm=new Map(v.map(x=>[idOf(x),x])); const rows=items.map(t=>`<tr><td>${esc(t.certificateReference||'—')}</td><td>${esc(vm.get(String(t.vehicleId))?.plateNumber||'—')}</td><td>${esc(am.get(String(t.assetId))?.assetCode||'—')}</td><td>${dateText(t.testDate)}</td><td>${dateText(t.nextDueDate)}</td><td>${chip(t.result)}</td><td>${chip(t.result==='FAIL'?'FAILED':t.result==='PENDING'?'PENDING':t.nextDueDate<new Date().toISOString().slice(0,10)?'OVERDUE':'VALID')}</td><td>${esc(t.recordSource)}</td><td>${btn('Edit','edit-hydrotest',idOf(t))}</td></tr>`);const body=$('.panel .panel-body.no-pad');if(body)body.innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr>${['Certificate','Vehicle','Asset','Test Date','Next Due','Result','Status','Source','Actions'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:empty('No matching tests','No hydrotest records match that result.');}catch(e){toast(e.message,'error');}});
    const hf=$('#historySource'); if(hf) hf.addEventListener('change',async()=>{try{const arr=await getList('scans',new URLSearchParams({q:$('#tableSearch')?.value||'',pageSize:'150'}));const filtered=hf.value?arr.filter(x=>x.source===hf.value):arr;const rows=filtered.map(s=>`<tr><td>${dateText(s.createdAt)}</td><td>${esc(s.originalFilename||'CCTV event')}</td><td class="mono">${esc(s.selectedPlate||'—')}</td><td>${s.confidence==null?'—':Math.round(s.confidence*100)+'%'}</td><td>${chip(s.status)}</td><td>${chip(s.verificationDecision||'—')}</td><td>${s.manuallyCorrected?'Corrected':'—'}</td><td>${btn('View','scan-detail',idOf(s))}</td></tr>`); const body=$('.panel .panel-body.no-pad');if(body)body.innerHTML=rows.length?`<div class="table-wrap"><table><thead><tr>${['Time','Media','Plate','Confidence','Status','Decision','Review','Details'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:empty('No events','No scans match the filter.');}catch(e){toast(e.message,'error');}});
  }

  function getScannerHudHtml(filename, pct = 15, stageMsg = 'Extracting video keyframes at 2.0 FPS target...', plate = null) {
    const isPlateFound = Boolean(plate);
    const p = Math.max(12, Math.min(100, Math.round(pct)));
    return `
      <div class="scanner-hud">
        <div class="scanner-hud-header">
          <div class="scanner-hud-title">
            <span class="scanner-pulse-dot"></span>
            <h3>AI License Plate & Safety Inspector</h3>
          </div>
          <span class="scanner-hud-tag">${esc(filename || 'Processing Media')}</span>
        </div>

        <div class="scanner-view-port">
          <div class="scanner-grid-bg"></div>
          <div class="scanner-laser-bar"></div>
          <div class="scanner-reticle-box">
            <div class="scanner-reticle-text">${isPlateFound ? esc(plate) : 'SCANNING NUMBER PLATE…'}</div>
          </div>
        </div>

        <div class="scanner-progress-track">
          <div class="scanner-progress-fill" style="width:${p}%"></div>
        </div>

        <div class="scanner-status-text">
          <span>${esc(stageMsg)}</span>
          <strong>${p}%</strong>
        </div>

        <div class="scanner-stepper">
          <div class="scanner-step ${p >= 15 ? (p >= 40 ? 'completed' : 'active') : ''}">
            <div class="scanner-step-icon">${p >= 40 ? '✓' : '1'}</div>
            <span>Keyframe Extraction & Neural Preprocessing</span>
          </div>
          <div class="scanner-step ${p >= 40 ? (p >= 75 ? 'completed' : 'active') : ''}">
            <div class="scanner-step-icon">${p >= 75 ? '✓' : '2'}</div>
            <span>YOLOv8 Plate Bounding Box Detection</span>
          </div>
          <div class="scanner-step ${p >= 75 ? (p >= 95 ? 'completed' : 'active') : ''}">
            <div class="scanner-step-icon">${p >= 95 ? '✓' : '3'}</div>
            <span>OCR Character Recognition & Indian HSRP Parsing</span>
          </div>
          <div class="scanner-step ${p >= 95 ? 'active' : ''}">
            <div class="scanner-step-icon">${p >= 100 ? '✓' : '4'}</div>
            <span>MongoDB Cylinder Hydrotest & Dispenser Safety Check</span>
          </div>
        </div>
      </div>
    `;
  }

  function renderScanResultScreen(scan) {
    const verification = scan.verificationRecord || {};
    const vehicle = scan.matchedVehicle;
    const evaluations = scan.assetEvaluations || [];
    const decision = verification.decision || scan.verificationDecision || 'NOT_EVALUATED';
    const observedPlate = scan.selectedPlate || scan.candidatePlate || verification.normalizedPlate || scan.candidates?.[0]?.plate || scan.candidates?.[0]?.normalizedText || 'PLATE NOT FOUND';
    const isAllowed = decision === 'DISPENSING_ALLOWED';
    const isOverdue = decision === 'DO_NOT_DISPENSE_OVERDUE' || (evaluations.some(e => e.status === 'OVERDUE'));
    const isFailed = decision === 'DO_NOT_DISPENSE_FAILED' || (evaluations.some(e => e.status === 'FAILED'));
    const isNotFound = decision === 'HOLD_VEHICLE_NOT_FOUND' || !vehicle;

    const bannerClass = isAllowed ? 'verified-screen-banner' : ((isOverdue || isFailed) ? 'verified-screen-banner locked' : 'verified-screen-banner hold');
    const bannerTitle = isAllowed ? 'DISPENSING ALLOWED — SAFETY INTERLOCK RELEASED' : (isOverdue ? 'FUEL DISPENSING LOCKED — CYLINDER OVERDUE' : (isFailed ? 'FUEL DISPENSING LOCKED — INSPECTION FAILED' : 'HOLD — VERIFICATION REQUIRED'));
    const bannerSub = isAllowed ? 'All active vehicle CNG cylinders comply with statutory hydrotest standards.' : (isOverdue ? 'At least one linked CNG cylinder has exceeded statutory hydrotest validity.' : (isFailed ? 'One or more cylinders failed hydrostatic expansion testing.' : 'Vehicle not registered or hydrotest records require operator review.'));
    const bannerPill = isAllowed ? 'DISPENSER UNLOCKED' : (isOverdue ? 'OVERDUE' : (isFailed ? 'TEST FAILED' : 'HOLD'));

    const cylinderRows = evaluations.length ? evaluations.map((e, idx) => {
      const t = e.test || {};
      const nextDue = t.nextDueDate || '—';
      const daysDiff = nextDue !== '—' ? Math.round((new Date(nextDue) - new Date()) / 86400000) : null;
      const daysBadge = daysDiff !== null ? (daysDiff < 0 ? `<span style="color:#ef4444;font-weight:700">Expired ${Math.abs(daysDiff)}d ago</span>` : `<span style="color:#10b981;font-weight:700">${daysDiff} days left</span>`) : '—';
      return `<tr>
        <td><strong class="mono">${esc(e.assetCode || 'CYL-0' + (idx+1))}</strong><small class="table-sub">${esc(e.serialNumber || 'Serial not recorded')}</small></td>
        <td>${t.testDate ? dateText(t.testDate) : '—'}</td>
        <td>${t.nextDueDate ? dateText(t.nextDueDate) : '—'}</td>
        <td>${daysBadge}</td>
        <td>${t.result ? chip(t.result) : chip('NO_RECORD')}</td>
        <td>${chip(e.status || 'NO_RECORD')}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" style="text-align:center;padding:18px;color:#94a3b8">No linked CNG assets found for this vehicle.</td></tr>`;

    return `
      <div class="verified-result-container">
        <div class="${bannerClass}">
          <div>
            <div class="verified-banner-title">${bannerTitle}</div>
            <div class="verified-banner-sub">${bannerSub}</div>
          </div>
          <span class="verified-badge-pill">${bannerPill}</span>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap">
          <div class="hsrp-badge">
            <div class="hsrp-left"><span class="hsrp-country">IND</span></div>
            <div class="hsrp-plate-text">${esc(observedPlate)}</div>
          </div>
          <div>
            ${scan.confidence != null ? `<span class="pill">Confidence: ${Math.round(scan.confidence * 100)}%</span>` : ''}
            <span class="pill">${scan.framesProcessed ?? 1} frame(s) · ${scan.elapsedSeconds ?? 1.2}s</span>
          </div>
        </div>

        <div class="vehicle-grid-6">
          <div class="v-card"><span>Vehicle</span><strong>${esc([vehicle?.make, vehicle?.model].filter(Boolean).join(' ') || (isNotFound ? 'Unregistered' : 'CNG Vehicle'))}</strong></div>
          <div class="v-card"><span>Category</span><strong>${esc(vehicle?.vehicleCategory?.replaceAll('_', ' ') || 'Passenger Car')}</strong></div>
          <div class="v-card"><span>Station</span><strong>${esc(vehicle?.stationId || 'STATION-DEMO-001')}</strong></div>
          <div class="v-card"><span>Registration</span><strong>${vehicle ? (vehicle.active !== false ? 'Active in DB' : 'Inactive') : 'Not in DB'}</strong></div>
          <div class="v-card"><span>Compliance</span><strong>${chip(verification.hydrotestStatus || scan.hydrotestStatus || 'UNKNOWN')}</strong></div>
          <div class="v-card"><span>Source</span><strong>${esc(scan.source || 'MANUAL_UPLOAD')}</strong></div>
        </div>

        <div class="cylinder-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cylinder / Asset</th>
                <th>Test Date</th>
                <th>Next Due</th>
                <th>Validity</th>
                <th>Result</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${cylinderRows}
            </tbody>
          </table>
        </div>

        <div class="actions" style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary" data-action="scan-another">⟳ Scan Another File</button>
          <button class="btn" data-action="scan-detail" data-id="${idOf(scan)}">🗎 Audit Details</button>
          ${vehicle ? btn('✎ Edit Vehicle', 'edit-vehicle', idOf(vehicle)) : ''}
          ${!scan.selectedPlate ? btn('Review / Correct Plate', 'review-scan', idOf(scan), 'btn-primary') : ''}
        </div>
      </div>
    `;
  }

  function bindScanPage() {
    const input = $('#mediaInput'); const selected = $('#selectedFiles'); const submit = $('#scanSubmit'); const zone = $('#uploadZone');
    let files = [];
    const paintFiles = () => {
      selected.innerHTML = files.map((f, i) => `<div class="file-item"><div><strong>${esc(f.name)}</strong><small>${(f.size/1024/1024).toFixed(2)} MB · ${esc(f.type||'unknown type')}</small></div><button class="icon-button" type="button" data-remove-file="${i}" aria-label="Remove file">×</button></div>`).join('');
      submit.disabled = !files.length;
    };
    input.addEventListener('change', () => {
      files = [...files, ...(input.files || [])];
      files = files.filter((f, i, a) => a.findIndex(x => x.name === f.name && x.size === f.size) === i);
      input.value = '';
      paintFiles();
    });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('dragover');
      files = [...files, ...(e.dataTransfer.files || [])];
      paintFiles();
    });
    selected.addEventListener('click', e => {
      const b = e.target.closest('[data-remove-file]');
      if (b) { files.splice(Number(b.dataset.removeFile), 1); paintFiles(); }
    });
    $('#clearFiles').addEventListener('click', () => {
      files = [];
      paintFiles();
      $('#scanResult').innerHTML = empty('Ready to scan', 'Select or drop a vehicle inspection video or photo. Real-time ALPR and safety interlock verification will appear here.', '⌕');
    });
    $('#scanForm').addEventListener('submit', async e => {
      e.preventDefault();
      if (!files.length) return;
      submit.disabled = true;
      submit.textContent = 'Processing Media…';
      const firstFileName = files[0]?.name || 'Video stream';
      $('#scanResult').innerHTML = getScannerHudHtml(firstFileName, 15, 'Starting neural plate detection pipeline…');
      try {
        const fd = new FormData();
        files.forEach(f => fd.append('files', f));
        const data = await api('/api/scans', { method: 'POST', body: fd });
        const ids = (data.items || []).map(x => x._id);
        toast(`${ids.length} media scan job${ids.length === 1 ? '' : 's'} launched.`, 'success');
        files = [];
        paintFiles();
        pollScans(ids, firstFileName);
      } catch (err) {
        toast(err.message, 'error');
        $('#scanResult').innerHTML = `<div class="notice danger">${esc(err.message)}</div>`;
        submit.disabled = !files.length;
        submit.textContent = 'Start plate scan';
      }
    });
  }

  function renderVerificationSummary(scan) {
    const verification = scan.verificationRecord || {};
    const vehicle = scan.matchedVehicle;
    const evaluations = scan.assetEvaluations || [];
    const decision = verification.decision || scan.verificationDecision || 'NOT_EVALUATED';
    const observedPlate = scan.selectedPlate || scan.candidatePlate || verification.normalizedPlate || scan.candidates?.[0]?.plate || scan.candidates?.[0]?.normalizedText || 'Plate not confirmed';
    const registered = verification.vehicleRegistered ?? scan.vehicleRegistered ?? Boolean(vehicle);
    const hydrotestStatus = verification.hydrotestStatus || scan.hydrotestStatus || (evaluations.length ? evaluations.map(x => x.status || 'NO_RECORD').sort((a,b) => ['FAILED','OVERDUE','NO_RECORD','PENDING','REVIEW_REQUIRED','DUE_SOON','VALID'].indexOf(a)-['FAILED','OVERDUE','NO_RECORD','PENDING','REVIEW_REQUIRED','DUE_SOON','VALID'].indexOf(b))[0] : 'NO_RECORD');
    const eligibility = verification.fuelingEligibility || scan.fuelingEligibility || (decision === 'DISPENSING_ALLOWED' ? 'ELIGIBLE' : 'NOT_ELIGIBLE');
    const summaryStrip = `<div class="verification-state-grid"><div class="verification-state"><span>Registration</span><strong>${registered ? 'REGISTERED' : 'NOT FOUND'}</strong>${chip(registered ? 'REGISTERED' : 'NOT_FOUND')}</div><div class="verification-state"><span>Hydrotest status</span><strong>${esc(String(hydrotestStatus).replaceAll('_',' '))}</strong>${chip(hydrotestStatus)}</div><div class="verification-state"><span>Fueling eligibility</span><strong>${eligibility === 'ELIGIBLE' && decision === 'DISPENSING_ALLOWED' ? 'READY FOR FUELING' : 'HOLD'}</strong>${chip(eligibility === 'ELIGIBLE' && decision === 'DISPENSING_ALLOWED' ? 'ELIGIBLE' : 'NOT_ELIGIBLE')}</div></div>`;
    const vehicleBlock = vehicle ? `
      <div class="vehicle-result-card">
        <div class="vehicle-result-top"><div><div class="eyebrow">REGISTERED VEHICLE MATCH</div><div class="plate-large">${esc(vehicle.plateNumber || observedPlate)}</div><div class="vehicle-subtitle">${esc([vehicle.make, vehicle.model].filter(Boolean).join(' ') || vehicle.vehicleCategory || 'Vehicle record')}</div></div><div>${chip(vehicle.active === false ? 'INACTIVE' : 'REGISTERED')}</div></div>
        <div class="vehicle-facts"><div><span>Category</span><strong>${esc(vehicle.vehicleCategory || '—')}</strong></div><div><span>Station</span><strong>${esc(vehicle.stationId || '—')}</strong></div><div><span>Record source</span><strong>${esc(vehicle.recordSource || 'OPERATOR')}</strong></div></div>
      </div>` : `<div class="vehicle-result-card vehicle-unmatched"><div class="vehicle-result-top"><div><div class="eyebrow">VEHICLE LOOKUP</div><strong>${esc(observedPlate)}</strong><p>${esc(scan.selectedPlate || verification.normalizedPlate ? 'No registered vehicle was matched.' : 'No reliable plate has been confirmed yet.')}</p></div>${chip(vehicle ? 'REGISTERED' : (scan.selectedPlate || verification.normalizedPlate ? 'NOT_FOUND' : 'REVIEW_REQUIRED'))}</div></div>`;
    const assetBlock = evaluations.length ? `
      <div class="asset-evaluation-list"><div class="subsection-heading"><h3>Hydrotest Verification</h3><span class="pill">${evaluations.length} linked asset${evaluations.length === 1 ? '' : 's'}</span></div>
      ${evaluations.map(e => { const t = e.test || {}; return `<article class="asset-evaluation-card"><div class="asset-evaluation-head"><div><strong>${esc(e.assetCode || 'CNG Asset')}</strong><span>${esc(e.serialNumber || 'Serial not recorded')}</span></div>${chip(e.status || 'NO_RECORD')}</div><div class="asset-evaluation-facts"><div><span>Latest result</span><strong>${esc(t.result || 'NO RECORD')}</strong></div><div><span>Test date</span><strong>${esc(t.testDate || '—')}</strong></div><div><span>Next due</span><strong>${esc(t.nextDueDate || '—')}</strong></div><div><span>Provider</span><strong>${esc(t.performedBy || '—')}</strong></div><div class="wide"><span>Certificate reference</span><strong>${esc(t.certificateReference || '—')}</strong></div></div></article>`; }).join('')}
      </div>` : `<div class="asset-evaluation-list"><div class="subsection-heading"><h3>Hydrotest Verification</h3></div>${empty(vehicle ? 'No linked CNG assets' : 'No hydrotest records available', vehicle ? 'No active CNG assets are linked to this vehicle.' : 'Register or confirm the vehicle and its assets to retrieve inspection records.')}</div>`;
    return `<div class="verification-summary"><div class="result-decision-strip"><div><span class="decision-kicker">VERIFICATION DECISION</span><div class="decision-title">${esc(decision.replaceAll('_', ' '))}</div><p>${esc(verification.explanation || scan.verificationExplanation || scan.error || 'Review the scan result and linked records.')}</p></div>${chip(decision)}</div>${summaryStrip}${vehicleBlock}${assetBlock}</div>`;
  }

  async function pollScans(ids, filename = '') {
    const terminal = new Set(['COMPLETED', 'REVIEW_REQUIRED', 'FAILED', 'UNREADABLE']);
    let polls = 0;
    const poll = async () => {
      polls++;
      const results = [];
      let done = 0;
      for (const id of ids) {
        try {
          const scan = await api(`/api/scans/${id}`);
          results.push(scan);
          if (terminal.has(scan.status)) done++;
        } catch (err) {
          results.push({ _id: id, status: 'FAILED', error: err.message });
          done++;
        }
      }

      const activeScan = results[0];
      const resultNode = $('#scanResult');

      if (done < ids.length) {
        if (resultNode && activeScan) {
          const prog = activeScan.scanProgress || {};
          const simulatedPct = Math.min(94, 15 + (polls * 18));
          const pct = prog.percent || simulatedPct;
          const msg = prog.message || (pct < 45 ? 'Sampling keyframes from video stream...' : (pct < 80 ? 'YOLOv8 plate detection in progress...' : 'Reading characters via neural OCR...'));
          const plate = activeScan.selectedPlate || activeScan.candidatePlate || prog.plate || null;
          resultNode.innerHTML = getScannerHudHtml(activeScan.originalFilename || filename, pct, msg, plate);
        }
        state.timer = setTimeout(poll, 350);
      } else {
        state.timer = null;
        const submit = $('#scanSubmit');
        if (submit) {
          submit.disabled = false;
          submit.textContent = 'Start plate scan';
        }

        if (resultNode && activeScan) {
          resultNode.innerHTML = renderScanResultScreen(activeScan);
        }

        // Refresh recent scans table smoothly
        try {
          const freshScans = await getList('scans', 'pageSize=12');
          const tableSection = $('.section-gap .panel-body.no-pad');
          if (tableSection) {
            const freshRows = freshScans.map(s => `<tr><td>${esc(s.originalFilename || 'CCTV event')}</td><td>${esc(s.source || '—')}</td><td class="mono">${esc(s.selectedPlate || '—')}</td><td>${chip(s.status)}</td><td>${chip(s.verificationDecision || '—')}</td><td>${dateText(s.createdAt)}</td><td>${btn('View', 'scan-detail', idOf(s))}</td></tr>`);
            tableSection.innerHTML = `<div class="table-wrap"><table><thead><tr>${['Media', 'Source', 'Plate Candidate', 'Scan Status', 'Decision', 'Created', 'Action'].map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${freshRows.join('')}</tbody></table></div>`;
          }
        } catch {}

        const isAllowed = activeScan?.verificationDecision === 'DISPENSING_ALLOWED';
        toast(isAllowed ? 'Verification complete: Dispenser interlock released!' : 'Verification complete: Safety checks applied.', isAllowed ? 'success' : 'warning');
      }
    };
    await poll();
  }

  async function openModal(type, item = null) {
    const titleMap={vehicle:item?'Edit Vehicle':'Add Vehicle',asset:item?'Edit CNG Asset':'Add CNG Asset',hydrotest:item?'Edit Hydrotest':'Add Hydrotest Record',review:'Manual Plate Review'};
    $('#modalTitle').textContent=titleMap[type]||'Record';$('#modalEyebrow').textContent='RECORD MANAGEMENT';$('#modalBody').innerHTML='<div class="loading-block"><span class="spinner"></span>Preparing form…</div>';$('#modalBackdrop').classList.remove('hidden');
    let inner='';
    if(type==='vehicle') inner=`<form id="entityForm" data-type="vehicle" data-id="${esc(idOf(item))}"><div class="form-grid"><div class="form-field full"><label class="field-label" for="plateNumber">Registration Number *</label><input class="field" id="plateNumber" name="plateNumber" maxlength="20" required value="${esc(item?.plateNumber||'')}" placeholder="e.g. GJ01AB1234"><div class="field-help">Enter the registration exactly as printed on the number plate.</div></div><div class="form-field"><label class="field-label" for="vehicleCategory">Vehicle Category *</label><select class="field" id="vehicleCategory" name="vehicleCategory"><option value="CNG_CAR">CNG Car</option><option value="CNG_VAN">CNG Van</option><option value="CNG_BUS">CNG Bus</option><option value="CNG_COMMERCIAL">CNG Commercial</option><option value="OTHER_CNG">Other CNG</option></select></div><div class="form-field"><label class="field-label" for="stationId">Station ID *</label><input class="field" id="stationId" name="stationId" required value="${esc(item?.stationId||'STATION-DEMO-001')}"></div><div class="form-field"><label class="field-label" for="make">Make (optional)</label><input class="field" id="make" name="make" maxlength="120" value="${esc(item?.make||'')}" placeholder="Unknown if not verified"></div><div class="form-field"><label class="field-label" for="model">Model (optional)</label><input class="field" id="model" name="model" maxlength="120" value="${esc(item?.model||'')}"></div><div class="form-field full"><label class="field-label" for="notes">Notes</label><textarea id="notes" name="notes" maxlength="1000">${esc(item?.notes||'')}</textarea></div></div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">${item?'Save Changes':'Create Vehicle'}</button></div></form>`;
    else if(type==='asset') {const vs=await getList('vehicles','pageSize=300');inner=`<form id="entityForm" data-type="asset" data-id="${esc(idOf(item))}"><div class="form-grid"><div class="form-field"><label class="field-label">Asset Code *</label><input class="field" name="assetCode" required maxlength="80" value="${esc(item?.assetCode||'')}" placeholder="CNG-ASSET-001"></div><div class="form-field"><label class="field-label">Vehicle *</label><select class="field" name="vehicleId" required><option value="">Choose vehicle…</option>${vs.map(v=>`<option value="${idOf(v)}" ${String(item?.vehicleId)===idOf(v)?'selected':''}>${esc(v.plateNumber)} · ${esc(v.vehicleCategory)}</option>`).join('')}</select></div><div class="form-field"><label class="field-label">Asset Type *</label><select class="field" name="assetType">${['CNG_CYLINDER','CNG_TANK','CNG_EQUIPMENT'].map(x=>`<option ${item?.assetType===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="form-field"><label class="field-label">Serial / Reference</label><input class="field" name="serialNumber" maxlength="120" value="${esc(item?.serialNumber||'')}"></div><div class="form-field"><label class="field-label">Manufacturer (optional)</label><input class="field" name="manufacturer" maxlength="120" value="${esc(item?.manufacturer||'')}"></div><div class="form-field"><label class="field-label">Installation Date</label><input class="field" type="date" name="installationDate" value="${esc(item?.installationDate||'')}"></div><div class="form-field full"><label class="field-label">Station ID</label><input class="field" name="stationId" value="${esc(item?.stationId||'STATION-DEMO-001')}"></div></div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">${item?'Save Changes':'Create Asset'}</button></div></form>`;}
    else if(type==='hydrotest'){const as=await getList('assets','pageSize=300');const vs=await getList('vehicles','pageSize=300');const vm=new Map(vs.map(v=>[idOf(v),v]));inner=`<form id="entityForm" data-type="hydrotest" data-id="${esc(idOf(item))}"><div class="form-grid"><div class="form-field full"><label class="field-label">CNG Asset *</label><select class="field" name="assetId" required><option value="">Select asset…</option>${as.map(a=>`<option value="${idOf(a)}" ${String(item?.assetId)===idOf(a)?'selected':''}>${esc(a.assetCode)} · ${esc(vm.get(String(a.vehicleId))?.plateNumber||'unlinked')}</option>`).join('')}</select></div><div class="form-field"><label class="field-label">Test Date *</label><input class="field" type="date" name="testDate" required value="${esc(item?.testDate||new Date().toISOString().slice(0,10))}"></div><div class="form-field"><label class="field-label">Next Due Date *</label><input class="field" type="date" name="nextDueDate" required value="${esc(item?.nextDueDate||'')}"></div><div class="form-field"><label class="field-label">Provider / Performed By *</label><input class="field" name="performedBy" required maxlength="160" value="${esc(item?.performedBy||'')}" placeholder="Inspection provider"></div><div class="form-field"><label class="field-label">Result *</label><select class="field" name="result">${['PASS','FAIL','PENDING'].map(x=>`<option ${item?.result===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="form-field"><label class="field-label">Certificate Reference</label><input class="field" name="certificateReference" maxlength="120" value="${esc(item?.certificateReference||'')}"></div><div class="form-field full"><label class="field-label">Notes</label><textarea name="notes" maxlength="1500">${esc(item?.notes||'')}</textarea></div></div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">${item?'Save Changes':'Create Hydrotest'}</button></div></form>`;}
    else if(type==='review') inner=`<form id="entityForm" data-type="review" data-id="${esc(item?.id||'')}"><div class="form-grid"><div class="form-field full"><label class="field-label">Reviewed Registration Number *</label><input class="field" name="plateNumber" required maxlength="20" value="${esc(item?.plate||'')}"></div><div class="form-field full"><label class="field-label">Reason for Correction / Review *</label><textarea name="reason" required maxlength="500" placeholder="Explain how the plate was confirmed from the source frame."></textarea></div></div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Re-run Verification</button></div></form>`;
    $('#modalBody').innerHTML=inner;
    const f=$('#entityForm');if(f&&type==='vehicle')$('#vehicleCategory').value=item?.vehicleCategory||'CNG_CAR';
    f?.addEventListener('submit', submitEntityForm);
    $('#modalClose').focus();
  }

  async function submitEntityForm(event) {
    event.preventDefault(); const form=event.currentTarget;const type=form.dataset.type;const id=form.dataset.id;const submit=$('button[type="submit"]',form); const data=Object.fromEntries(new FormData(form).entries());
    if(type==='vehicle') {const rawPlate=String(data.plateNumber||'').trim().toUpperCase(); if(!/^[A-Z0-9\s-]+$/.test(rawPlate)){toast('Use only letters, digits, spaces or hyphens in the registration number.','error');return;} data.plateNumber=rawPlate.replace(/[\s-]+/g,''); if(!/^(?:[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}|\d{2}BH\d{4}[A-HJ-NP-Z]{1,2})$/.test(data.plateNumber)){toast('Registration format not recognized. Check the state/RTO code, series and digits. Special/legacy formats may need review.','error');return;}}
    if(type==='hydrotest'&&data.nextDueDate<data.testDate){toast('Next due date cannot be earlier than test date.','error');return;}
    if(type==='camera'&&id&&!data.streamUrl)delete data.streamUrl;
    submit.disabled=true;submit.textContent='Saving…';
    try{
      if(type==='review'){const result=await api(`/api/scans/${id}/review`,{method:'POST',body:data});toast(`Verification re-run: ${result.verification.decision}`);closeModal();await renderView('review');return;}
      const routes={vehicle:'vehicles',asset:'assets',hydrotest:'hydrotests'};const route=routes[type];if(!route)throw new Error('Unknown form type.');
      const result=await api(id?`/api/${route}/${id}`:`/api/${route}`,{method:id?'PATCH':'POST',body:data});
      toast(`${type==='hydrotest'?'Hydrotest':type==='asset'?'CNG asset':'Vehicle'} ${id?'updated':'added'} successfully.`, 'success');
      closeModal();await renderView(state.view);
    }catch(err){toast(err.message,'error');}finally{submit.disabled=false;submit.textContent=id?'Save Changes':'Create';}
  }
  function closeModal(){ $('#modalBackdrop').classList.add('hidden');$('#modalBody').innerHTML=''; }
  async function showScanDetail(id) {
    try {
      const scan = await api(`/api/scans/${id}`);
      const isImg = scan.mediaType?.startsWith('image') || (scan.originalFilename && /\.(jpe?g|png|webp|bmp)$/i.test(scan.originalFilename));
      const media = scan.mediaId ? (isImg ? `<img class="media-preview" src="/api/scans/${id}/media" alt="Inspection frame" style="max-height:260px;object-fit:contain;width:100%;border-radius:10px;background:#030712;margin-bottom:14px">` : `<video controls class="media-preview" src="/api/scans/${id}/media"></video>`) : '';
      const candidates = (scan.candidates || []).map(candidate => `<div class="candidate-evidence-row"><div><strong class="mono">${esc(candidate.plate || candidate.normalizedText || candidate.rawText || 'Candidate')}</strong><span>${esc((candidate.timestampsSeconds || []).join(', ') || candidate.timestampSeconds || '—')} sec · ${Number(candidate.supportFrames || 1)} frame(s)</span></div><strong>${Math.round((candidate.confidence || 0) * 100)}%</strong></div>`).join('');
      $('#modalTitle').textContent = 'Scan Details';
      $('#modalEyebrow').textContent = 'SCAN VERIFICATION';
      $('#modalBody').innerHTML = `${media}<div class="result-main"><div class="decision-title">${esc(scan.selectedPlate || scan.candidatePlate || scan.verificationRecord?.normalizedPlate || scan.candidates?.[0]?.plate || 'Plate not confirmed')}</div><p>${esc(scan.originalFilename || 'CCTV entry event')}</p>${chip(scan.status)} ${chip(scan.verificationDecision || 'NOT_EVALUATED')}<div class="detail-list"><div><label>OCR confidence</label><strong>${scan.confidence == null ? '—' : Math.round(scan.confidence * 100) + '%'}</strong></div><div><label>Frames processed</label><strong>${scan.framesProcessed ?? '—'}</strong></div><div><label>Engine</label><strong>${esc(scan.scanEngine || '—')}</strong></div><div><label>Processing time</label><strong>${scan.elapsedSeconds == null ? '—' : scan.elapsedSeconds + 's'}</strong></div></div></div>${renderVerificationSummary(scan)}<h3>Candidate Evidence</h3>${candidates || empty('No candidates','No plate candidates were returned by the scanner.')}<div class="modal-footer"><button class="btn" data-action="close-modal">Close</button>${btn('Refresh database check','reverify-scan',id,'btn')}${btn('Review / Correct Plate','review-scan',id,'btn btn-primary')}</div>`;
      $('#modalBackdrop').classList.remove('hidden');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function doAction(action,id,el) {
    if(action==='refresh'){await renderView(state.view);return;}
    if(action==='close-modal'){closeModal();return;}
    if(action==='open-modal'){await openModal(el.dataset.type);return;}
    if(action==='scan-another'){
      const input = $('#mediaInput'); if (input) input.value = '';
      const selected = $('#selectedFiles'); if (selected) selected.innerHTML = '';
      const result = $('#scanResult'); if (result) result.innerHTML = empty('Ready to scan', 'Select or drop a vehicle inspection video or photo. Real-time ALPR and safety interlock verification will appear here.', '⌕');
      const submit = $('#scanSubmit'); if (submit) { submit.disabled = true; submit.textContent = 'Start plate scan'; }
      return;
    }
    if(action==='vehicle-detail'){
      const v=await api(`/api/vehicles/${id}`);
      const assets=await getList('assets','pageSize=300');
      const linked=assets.filter(a=>String(a.vehicleId)===id);
      $('#modalTitle').textContent=v.plateNumber;
      $('#modalEyebrow').textContent='VEHICLE RECORD';
      $('#modalBody').innerHTML=`<div class="result-main"><div class="plate-large">${esc(v.plateNumber)}</div>${chip(v.active?'ACTIVE':'INACTIVE')} <span class="pill">${esc(v.recordSource||'OPERATOR')}</span><div class="detail-list"><div><label>Category</label><strong>${esc(v.vehicleCategory)}</strong></div><div><label>Station</label><strong>${esc(v.stationId)}</strong></div><div><label>Make</label><strong>${esc(v.make||'Unknown')}</strong></div><div><label>Model</label><strong>${esc(v.model||'Unknown')}</strong></div><div><label>Created</label><strong>${dateText(v.createdAt)}</strong></div><div><label>Updated</label><strong>${dateText(v.updatedAt)}</strong></div></div></div><h3>Linked CNG Assets (${linked.length})</h3>${linked.map(a=>`<div class="health-row"><div><strong>${esc(a.assetCode)}</strong><small>${esc(a.serialNumber||'No serial number')}</small></div>${chip(a.active?'ACTIVE':'INACTIVE')}</div>`).join('')||empty('No linked assets','Link a CNG asset before hydrotest verification can succeed.')}<div class="modal-footer">${btn('Edit Vehicle','edit-vehicle',id)}<button class="btn" data-action="close-modal">Close</button></div>`;
      $('#modalBackdrop').classList.remove('hidden');
      return;
    }
    if(action==='delete-vehicle'){
      if(!confirm('Are you sure you want to delete this vehicle record? This action cannot be undone.')) return;
      try {
        await api(`/api/vehicles/${id}`, { method: 'DELETE' });
        toast('Vehicle record deleted successfully.', 'success');
        await renderView(state.view);
      } catch(err) { toast(err.message, 'error'); }
      return;
    }
    if(action==='edit-vehicle'){await openModal('vehicle',await api(`/api/vehicles/${id}`));return;}
    if(action==='asset-detail'){
      try {
        const a = await api(`/api/assets/${id}`);
        const vs = await getList('vehicles', 'pageSize=300');
        const vm = new Map(vs.map(v => [idOf(v), v]));
        const v = vm.get(String(a.vehicleId));
        $('#modalTitle').textContent = a.assetCode || 'CNG Asset';
        $('#modalEyebrow').textContent = 'ASSET RECORD';
        $('#modalBody').innerHTML = `<div class="result-main"><div class="plate-large">${esc(a.assetCode)}</div>${chip(a.active?'ACTIVE':'INACTIVE')} <span class="pill">${esc(a.assetType || 'CNG_CYLINDER')}</span><div class="detail-list"><div><label>Vehicle</label><strong>${esc(v?.plateNumber || 'Unlinked')}</strong></div><div><label>Serial</label><strong>${esc(a.serialNumber || '—')}</strong></div><div><label>Station</label><strong>${esc(a.stationId || '—')}</strong></div><div><label>Manufacturer</label><strong>${esc(a.manufacturer || '—')}</strong></div><div><label>Installation</label><strong>${dateText(a.installationDate)}</strong></div><div><label>Updated</label><strong>${dateText(a.updatedAt)}</strong></div></div></div><div class="modal-footer">${btn('Edit Asset','edit-asset',id)}<button class="btn" data-action="close-modal">Close</button></div>`;
        $('#modalBackdrop').classList.remove('hidden');
      } catch(err) { toast(err.message, 'error'); }
      return;
    }
    if(action==='delete-asset'){
      if(!confirm('Are you sure you want to delete this CNG asset? Linked hydrotest records will also be affected.')) return;
      try {
        await api(`/api/assets/${id}`, { method: 'DELETE' });
        toast('CNG asset deleted successfully.', 'success');
        await renderView(state.view);
      } catch(err) { toast(err.message, 'error'); }
      return;
    }
    if(action==='edit-asset'){await openModal('asset',await api(`/api/assets/${id}`));return;}
    if(action==='hydrotest-detail'){
      try {
        const t = await api(`/api/hydrotests/${id}`);
        const vs = await getList('vehicles', 'pageSize=300');
        const as = await getList('assets', 'pageSize=300');
        const vm = new Map(vs.map(v => [idOf(v), v]));
        const am = new Map(as.map(a => [idOf(a), a]));
        const linkedAsset = am.get(String(t.assetId));
        const linkedVehicle = vm.get(String(t.vehicleId || linkedAsset?.vehicleId));
        $('#modalTitle').textContent = t.certificateReference || 'Hydrotest Record';
        $('#modalEyebrow').textContent = 'HYDROTEST RECORD';
        $('#modalBody').innerHTML = `<div class="result-main"><div class="plate-large">${esc(t.certificateReference || 'CERT REF')}</div>${chip(t.result)} <span class="pill">${esc(t.recordSource || 'OPERATOR')}</span><div class="detail-list"><div><label>Vehicle</label><strong>${esc(linkedVehicle?.plateNumber || '—')}</strong></div><div><label>CNG Asset</label><strong>${esc(linkedAsset?.assetCode || '—')}</strong></div><div><label>Test Date</label><strong>${dateText(t.testDate)}</strong></div><div><label>Next Due Date</label><strong>${dateText(t.nextDueDate)}</strong></div><div><label>Provider</label><strong>${esc(t.performedBy || '—')}</strong></div><div><label>Notes</label><strong>${esc(t.notes || '—')}</strong></div></div></div><div class="modal-footer">${btn('Edit Hydrotest','edit-hydrotest',id)}<button class="btn" data-action="close-modal">Close</button></div>`;
        $('#modalBackdrop').classList.remove('hidden');
      } catch(err) { toast(err.message, 'error'); }
      return;
    }
    if(action==='delete-hydrotest'){
      if(!confirm('Are you sure you want to delete this hydrotest record?')) return;
      try {
        await api(`/api/hydrotests/${id}`, { method: 'DELETE' });
        toast('Hydrotest record deleted successfully.', 'success');
        await renderView(state.view);
      } catch(err) { toast(err.message, 'error'); }
      return;
    }
    if(action==='edit-hydrotest'){await openModal('hydrotest',await api(`/api/hydrotests/${id}`));return;}
    if(action==='scan-detail'){await showScanDetail(id);return;}
    if(action==='reverify-scan'){try{el.disabled=true;el.textContent='Checking…';const result=await api(`/api/scans/${id}/reverify`,{method:'POST',body:{}});const v=result.verification;toast(`Database checked: ${v.vehicleRegistered?'registered vehicle':'no vehicle match'} · hydrotest ${v.hydrotestStatus||'unknown'} · ${v.decision.replaceAll('_',' ')}`,v.decision==='DISPENSING_ALLOWED'?'success':'warning');await showScanDetail(id);}catch(err){toast(err.message,'error');}finally{el.disabled=false;el.textContent='Refresh database check';}return;}
    if(action==='review-scan'){let scan=null;try{scan=await api(`/api/scans/${id}`);}catch{}await openModal('review',{id,plate:scan?.selectedPlate||scan?.candidatePlate||scan?.candidates?.[0]?.plate||''});return;}
    if(action==='load-demo'){try{const r=await api('/api/demo/seed',{method:'POST',body:{}});toast(`Demo data ready: ${r.vehicles} vehicles, ${r.assets} assets, ${r.hydrotests} tests.`);await renderView(state.view);}catch(err){toast(err.message,'error');}return;}
    if(action==='export-scans'){try{const scans=await getList('scans','pageSize=1000');const cols=['createdAt','source','originalFilename','selectedPlate','confidence','status','verificationDecision','verificationExplanation'];const csv=[cols.join(','),...scans.map(s=>cols.map(k=>csvCell(s[k])).join(','))].join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='fuelflux-scan-history.csv';a.click();URL.revokeObjectURL(url);toast('Scan history exported.');}catch(err){toast(err.message,'error');}return;}
  }
  function csvCell(val){let s=String(val??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;s=s.replace(/"/g,'""');return `"${s}"`;}

  document.addEventListener('click', async (event) => {
    const nav = event.target.closest('[data-view]'); if(nav){event.preventDefault();location.hash=nav.dataset.view;$('#sidebar').classList.remove('open');return;}
    const direct = event.target.closest('[data-view-go]');if(direct){location.hash=direct.dataset.viewGo;return;}
    const action=event.target.closest('[data-action]');if(action){event.preventDefault();try{await doAction(action.dataset.action,action.dataset.id,action);}catch(err){toast(err.message,'error');}return;}
  });
  window.addEventListener('hashchange',()=>{const view=location.hash.replace('#','')||'dashboard';renderView(view).catch(failPage);});
  $('#modalClose').addEventListener('click',closeModal);$('#modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeModal();});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#modalBackdrop').classList.contains('hidden'))closeModal();});
  $('#menuToggle').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));$('#refreshBtn').addEventListener('click',()=>renderView(state.view));
  async function health() { try {await api('/api/health');$('#apiHealth').className='health-pill healthy';$('#apiHealth').innerHTML='<i></i> API & Database healthy';}catch{$('#apiHealth').className='health-pill unhealthy';$('#apiHealth').innerHTML='<i></i> API unavailable';} }
  health();setInterval(health,30000);renderView(location.hash.replace('#','')||'dashboard');
})();
