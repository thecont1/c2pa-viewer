// API Dashboard — key-authenticated self-service for the c2pa-verify API.
// No account layer: the API key IS the credential, stored in localStorage.

const API = 'https://api.c2pa.thecontrarian.in';
// Cloudflare Turnstile sitekey — production widget 'c2pa-verify-dashboard'
// (managed mode, domains: c2pa.thecontrarian.in + pages.dev previews + localhost).
const TURNSTILE_SITEKEY = '0x4AAAAAAGTefC4DoXlf2sZ7';

const TIERS = [
    { id: 'free', name: 'Free', price: 0, quota: '1,000', blurb: 'Evaluate and integrate' },
    { id: 'pro', name: 'Pro', price: 19, quota: '25,000', blurb: 'Production workloads', featured: true },
    { id: 'scale', name: 'Scale', price: 99, quota: '250,000', blurb: 'High-volume pipelines' },
];

const app = document.getElementById('app');
const navSignout = document.getElementById('nav-signout');

function getKey() { return localStorage.getItem('c2pa_api_key') || null; }
function setKey(k) { k ? localStorage.setItem('c2pa_api_key', k) : localStorage.removeItem('c2pa_api_key'); }

async function api(path, { method = 'GET', key, body } = {}) {
    const headers = {};
    if (key) headers.authorization = `Bearer ${key}`;
    if (body) headers['content-type'] = 'application/json';
    const resp = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await resp.json(); } catch { }
    return { status: resp.status, json };
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
    return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

function fmtInt(n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); }

function render(html) { app.innerHTML = html; }

function errorBox(msg) { return `<div class="dash-error">${esc(msg)}</div>`; }

// ---------------------------------------------------------- welcome ----

function welcomeView() {
    navSignout.hidden = true;
    render(`
    <div class="dash-card">
      <h2>Verify content authenticity programmatically</h2>
      <p class="dash-muted">C2PA manifest verification, trust-chain validation, provenance extraction and nutritional-label data — as an API, an async job pipeline, or an MCP server. Pick a tier to get a key in under a minute.</p>
      <div class="tier-grid">
        ${TIERS.map((t) => `
        <div class="tier-card ${t.featured ? 'tier-featured' : ''}">
          <div class="tier-name">${t.name}</div>
          <div class="tier-price">$${t.price}<span>/mo</span></div>
          <div class="tier-quota">${t.quota} verifications / month</div>
          <p class="dash-muted">${t.blurb}</p>
          ${t.id === 'free'
            ? `<button class="btn" data-signup-free>Get a free key</button>`
            : `<button class="btn" data-checkout="${t.id}">Subscribe — $${t.price}/mo</button>`}
        </div>`).join('')}
      </div>
      <div id="signup-zone"></div>
    </div>
    <div class="dash-card">
      <h2>Already have a key?</h2>
      <label class="dash-label" for="key-input">Paste your API key</label>
      <input id="key-input" class="dash-input mono" type="password" placeholder="c2pa_live_…" autocomplete="off">
      <div class="dash-row" style="margin-top: var(--space-4)">
        <button class="btn" id="key-submit">Open dashboard</button>
        <span class="dash-muted">The key is stored only in this browser's localStorage.</span>
      </div>
      <div id="key-error"></div>
    </div>`);

    document.getElementById('key-submit').onclick = async () => {
        const k = document.getElementById('key-input').value.trim();
        if (!k) return;
        const r = await api('/v1/key', { key: k });
        if (r.status === 200) { setKey(k); dashboardView(); }
        else document.getElementById('key-error').innerHTML = errorBox((r.json && r.json.detail) || 'This key is not valid.');
    };

    for (const btn of document.querySelectorAll('[data-signup-free]')) {
        btn.onclick = () => freeSignupView();
    }
    for (const btn of document.querySelectorAll('[data-checkout]')) {
        btn.onclick = () => paidCheckout(btn.dataset.checkout, btn);
    }
}

// ---------------------------------------------------------- signup ----

function freeSignupView() {
    const zone = document.getElementById('signup-zone');
    zone.innerHTML = `
      <h3>Free tier signup</h3>
      <p class="dash-muted">One verification below — your key appears immediately.</p>
      <div id="turnstile-box"></div>
      <div id="signup-status"></div>`;
    const renderWidget = () => {
        if (!window.turnstile) { setTimeout(renderWidget, 200); return; }
        window.turnstile.render('#turnstile-box', {
            sitekey: TURNSTILE_SITEKEY,
            callback: async (token) => {
                document.getElementById('signup-status').innerHTML = '<p class="dash-muted">Creating your key…</p>';
                const r = await api('/v1/signup/free', { method: 'POST', body: { turnstile_token: token } });
                if (r.status === 201) keyRevealView(r.json);
                else document.getElementById('signup-status').innerHTML = errorBox((r.json && r.json.detail) || 'Signup failed — retry.');
            },
        });
    };
    renderWidget();
}

async function paidCheckout(tier, btn) {
    btn.disabled = true;
    const zone = document.getElementById('signup-zone');
    zone.innerHTML = `<h3>${esc(tier)} checkout</h3><div id="turnstile-box"></div><div id="signup-status"></div>`;
    const renderWidget = () => {
        if (!window.turnstile) { setTimeout(renderWidget, 200); return; }
        window.turnstile.render('#turnstile-box', {
            sitekey: TURNSTILE_SITEKEY,
            callback: async (token) => {
                document.getElementById('signup-status').innerHTML = '<p class="dash-muted">Opening secure checkout…</p>';
                const r = await api('/v1/billing/checkout', { method: 'POST', body: { tier, turnstile_token: token } });
                if (r.status === 201 && r.json && r.json.checkout_url) {
                    window.location.href = r.json.checkout_url;
                } else {
                    document.getElementById('signup-status').innerHTML = errorBox((r.json && r.json.detail) || 'Checkout unavailable.');
                    btn.disabled = false;
                }
            },
        });
    };
    renderWidget();
}

// ------------------------------------------------------ key reveal ----

function keyRevealView(data) {
    render(`
    <div class="dash-card">
      <h2>Your API key</h2>
      <div class="key-reveal-box">
        <div class="mono">${esc(data.key)}</div>
        <div class="key-reveal-warn">Shown exactly once — copy it now and store it somewhere safe. It cannot be recovered.</div>
      </div>
      <div class="dash-row">
        <button class="btn" id="reveal-copy">Copy key</button>
        <button class="btn btn-quiet" id="reveal-open">Open dashboard</button>
      </div>
    </div>`);
    document.getElementById('reveal-copy').onclick = async (e) => {
        await navigator.clipboard.writeText(data.key);
        e.target.textContent = 'Copied';
    };
    document.getElementById('reveal-open').onclick = () => { setKey(data.key); dashboardView(); };
}

// ---------------------------------------------------- checkout return ----

async function checkoutSuccessView(sessionId) {
    render(`<div class="dash-card"><h2>Provisioning your key…</h2><p class="dash-muted">Payment confirmed — creating your key. This takes a few seconds.</p><div id="reveal-status"></div></div>`);
    for (let attempt = 0; attempt < 20; attempt++) {
        const r = await api(`/v1/billing/reveal?session_id=${encodeURIComponent(sessionId)}`);
        if (r.status === 201) { keyRevealView(r.json); return; }
        if (r.status === 410) {
            document.getElementById('reveal-status').innerHTML = errorBox('This key was already revealed. If you lost it, rotate it from the dashboard of any copy you still hold — otherwise contact support.');
            return;
        }
        await new Promise((res) => setTimeout(res, 2500));
    }
    document.getElementById('reveal-status').innerHTML = errorBox('Provisioning is taking longer than expected — your payment is confirmed. Refresh this page in a minute or contact support.');
}

// -------------------------------------------------------- dashboard ----

async function dashboardView() {
    const key = getKey();
    if (!key) { welcomeView(); return; }
    navSignout.hidden = false;
    render('<div class="dash-loading">Loading your dashboard…</div>');

    const [keyInfo, usage, jobs] = await Promise.all([
        api('/v1/key', { key }),
        api('/v1/usage', { key }),
        api('/v1/jobs?limit=20', { key }),
    ]);
    if (keyInfo.status !== 200) {
        setKey(null);
        welcomeView();
        return;
    }
    const k = keyInfo.json;
    const u = k.usage || { verify_count: 0, bytes_total: 0 };
    const pct = k.quota_monthly ? Math.min(100, (u.verify_count / k.quota_monthly) * 100) : 0;
    const meterClass = pct >= 95 ? 'usage-crit' : pct >= 80 ? 'usage-warn' : '';
    const months = (usage.json && usage.json.months) || [];
    const jobRows = (jobs.json && jobs.json.jobs) || [];

    render(`
    <div class="dash-card">
      <div class="dash-row">
        <h2 style="margin:0">Usage</h2>
        <span class="badge badge-${esc(k.tier)}">${esc(k.tier)}</span>
        ${k.billing_status && k.billing_status !== 'none' && k.billing_status !== 'active' ? `<span class="badge badge-${esc(k.billing_status)}">${esc(k.billing_status.replace('_', ' '))}</span>` : ''}
        <div class="dash-spacer"></div>
        <span class="mono dash-muted">${esc(k.display_prefix)}…</span>
      </div>
      <div class="usage-meter"><div class="usage-meter-fill ${meterClass}" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="usage-figures">
        <span><strong>${fmtInt(u.verify_count)}</strong> of ${k.quota_monthly ? fmtInt(k.quota_monthly) : 'unlimited'} verifications this month</span>
        <span>${fmtBytes(u.bytes_total)} processed</span>
      </div>
      ${k.quota_monthly && u.verify_count >= k.quota_monthly ? errorBox('Monthly quota exhausted — upgrade for more, or wait for the month to roll over.') : ''}
    </div>

    <div class="dash-card">
      <h2>Plan &amp; billing</h2>
      <div class="dash-row">
        ${k.tier === 'free' ? `
          <button class="btn" data-upgrade="pro">Upgrade to Pro — $19/mo</button>
          <button class="btn btn-quiet" data-upgrade="scale">Scale — $99/mo</button>`
        : `<button class="btn" id="portal-btn">Manage billing</button>
           ${k.tier === 'pro' ? '<button class="btn btn-quiet" data-upgrade="scale">Upgrade to Scale — $99/mo</button>' : ''}`}
      </div>
      <div id="billing-status"></div>
    </div>

    <div class="dash-card">
      <h2>Monthly history</h2>
      ${months.length ? `<table class="kv-table">
        <tr><th>Month</th><th>Verifications</th><th>Bytes processed</th></tr>
        ${months.map((m) => `<tr><td class="mono">${esc(m.month)}</td><td>${fmtInt(m.verify_count)}</td><td>${fmtBytes(m.bytes_total)}</td></tr>`).join('')}
      </table>` : '<p class="dash-muted">No usage yet.</p>'}
    </div>

    <div class="dash-card">
      <h2>Recent jobs</h2>
      ${jobRows.length ? `<table class="kv-table">
        <tr><th>Job</th><th>File</th><th>Status</th><th>Created</th></tr>
        ${jobRows.map((j) => `<tr>
          <td class="mono">${esc(j.job_id.slice(0, 16))}…</td>
          <td>${esc(j.filename || '—')}</td>
          <td><span class="badge badge-${esc(j.status)}">${esc(j.status)}</span></td>
          <td class="dash-muted">${esc((j.created_at || '').slice(0, 16).replace('T', ' '))}</td>
        </tr>`).join('')}
      </table>` : '<p class="dash-muted">No async jobs yet — use POST /v1/jobs for large files.</p>'}
    </div>

    <div class="dash-card">
      <h2>Key management</h2>
      <div class="dash-row">
        <button class="btn btn-quiet" id="rotate-btn">Rotate key</button>
        <button class="btn btn-danger" id="revoke-btn">Revoke key</button>
        <div class="dash-spacer"></div>
        <span class="dash-muted">Rotation revokes this key immediately and issues its successor.</span>
      </div>
      <div id="keyman-status"></div>
    </div>`);

    for (const btn of document.querySelectorAll('[data-upgrade]')) {
        btn.onclick = () => upgradeFlow(btn.dataset.upgrade, key);
    }
    const portalBtn = document.getElementById('portal-btn');
    if (portalBtn) portalBtn.onclick = async () => {
        portalBtn.disabled = true;
        const r = await api('/v1/billing/portal', { method: 'POST', key });
        if (r.status === 200 && r.json && r.json.portal_url) window.location.href = r.json.portal_url;
        else {
            document.getElementById('billing-status').innerHTML = errorBox((r.json && r.json.detail) || 'Billing portal unavailable.');
            portalBtn.disabled = false;
        }
    };
    document.getElementById('rotate-btn').onclick = () => rotateFlow(key);
    document.getElementById('revoke-btn').onclick = () => revokeFlow(key);
}

async function upgradeFlow(tier, key) {
    const zone = document.getElementById('billing-status');
    zone.innerHTML = '<p class="dash-muted">Opening secure checkout…</p>';
    const r = await api('/v1/billing/checkout', { method: 'POST', key, body: { tier } });
    if (r.status === 201 && r.json && r.json.checkout_url) window.location.href = r.json.checkout_url;
    else zone.innerHTML = errorBox((r.json && r.json.detail) || 'Checkout unavailable.');
}

function rotateFlow(key) {
    const zone = document.getElementById('keyman-status');
    if (!confirm('Rotate this key? The current key stops working immediately.')) return;
    (async () => {
        const r = await api('/v1/key/rotate', { method: 'POST', key });
        if (r.status === 200 && r.json && r.json.key) keyRevealView(r.json);
        else zone.innerHTML = errorBox((r.json && r.json.detail) || 'Rotation failed.');
    })();
}

function revokeFlow(key) {
    if (!confirm('Revoke this key permanently? This cannot be undone.')) return;
    (async () => {
        await api('/v1/key/revoke', { method: 'POST', key });
        setKey(null);
        welcomeView();
    })();
}

// ------------------------------------------------------------- boot ----

navSignout.onclick = () => { setKey(null); welcomeView(); };

(function boot() {
    const hash = window.location.hash || '';
    const m = hash.match(/#\/checkout\/success\?session_id=([^&]+)/);
    if (m) { checkoutSuccessView(decodeURIComponent(m[1])); return; }
    if (hash.startsWith('#/checkout/cancel')) { welcomeView(); return; }
    if (getKey()) dashboardView();
    else welcomeView();
})();
