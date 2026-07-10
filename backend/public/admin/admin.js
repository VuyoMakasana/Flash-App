'use strict';
// Minimal standalone admin page for the returns queue — no framework, no
// build step, same-origin fetch() calls against the existing /api/admin
// and /api/returns endpoints. Token kept in sessionStorage only (cleared
// when the tab closes), not localStorage — this is an internal tool, not
// something that needs to survive a browser restart.

const TOKEN_KEY = 'flash_admin_token';

const loginCard  = document.getElementById('loginCard');
const dashboard  = document.getElementById('dashboard');
const loginForm  = document.getElementById('loginForm');
const loginBtn   = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');
const tableWrap  = document.getElementById('tableWrap');
const toast      = document.getElementById('toast');
const refreshBtn = document.getElementById('refreshBtn');
const logoutBtn  = document.getElementById('logoutBtn');

const modalOverlay    = document.getElementById('modalOverlay');
const modalTitle      = document.getElementById('modalTitle');
const modalMessage    = document.getElementById('modalMessage');
const modalInput      = document.getElementById('modalInput');
const modalCancelBtn  = document.getElementById('modalCancelBtn');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');

function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
function setToken(t) { sessionStorage.setItem(TOKEN_KEY, t); }
function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

function showToast(message) {
  toast.textContent = message;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3500);
}

// In-page modal replacing window.prompt()/confirm() — those native dialogs
// aren't supported in every embedded-browser context (e.g. VS Code's Simple
// Browser), where calling them silently no-ops or throws. Resolves with
// { confirmed, value } — value is the textarea content when showInput is
// true, otherwise ''.
let modalResolve = null;

function showModal({ title, message, showInput = false, confirmLabel = 'Confirm' }) {
  modalTitle.textContent = title;
  modalMessage.textContent = message;
  modalInput.value = '';
  modalInput.classList.toggle('hidden', !showInput);
  modalConfirmBtn.textContent = confirmLabel;
  modalOverlay.style.display = 'flex';
  if (showInput) modalInput.focus();

  return new Promise((resolve) => { modalResolve = resolve; });
}

function closeModal(confirmed) {
  modalOverlay.style.display = 'none';
  if (modalResolve) {
    modalResolve({ confirmed, value: modalInput.value.trim() });
    modalResolve = null;
  }
}

modalCancelBtn.addEventListener('click', () => closeModal(false));
modalConfirmBtn.addEventListener('click', () => closeModal(true));
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal(false);
});

function showLogin() {
  loginCard.style.display = 'block';
  dashboard.style.display = 'none';
}

function showDashboard() {
  loginCard.style.display = 'none';
  dashboard.style.display = 'block';
  loadReturns();
}

async function apiCall(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearToken();
    showLogin();
    throw new Error('Session expired — please log in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// ─── Login ──────────────────────────────────────────────────────────────────

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.style.display = 'none';
  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in…';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    setToken(data.token);
    document.getElementById('password').value = '';
    showDashboard();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.style.display = 'block';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Log in';
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await apiCall('/api/admin/logout', { method: 'POST' });
  } catch (_) { /* already logging out either way */ }
  clearToken();
  showLogin();
});

refreshBtn.addEventListener('click', loadReturns);

// ─── Returns queue ──────────────────────────────────────────────────────────

function statusBadge(row) {
  if (row.status === 'requested') {
    return '<span class="badge badge-requested">Awaiting dispatch</span>';
  }
  if (row.return_order_status === 'completed') {
    return '<span class="badge badge-ready">Ready for final review</span>';
  }
  return `<span class="badge badge-transit">${row.return_order_status || 'dispatched'}</span>`;
}

function actionsFor(row) {
  const parts = [];
  if (row.status === 'requested') {
    parts.push(`<button type="button" class="btn-approve" data-action="approve" data-id="${row.id}">Approve (dispatch)</button>`);
    parts.push(`<button type="button" class="btn-reject" data-action="reject" data-id="${row.id}">Reject</button>`);
  } else if (row.status === 'approved' && row.return_order_status === 'completed') {
    parts.push(`<button type="button" class="btn-finalize" data-action="finalize" data-id="${row.id}">Finalize refund</button>`);
    parts.push(`<button type="button" class="btn-reject" data-action="reject" data-id="${row.id}">Reject</button>`);
  } else if (row.status === 'approved') {
    parts.push(`<button type="button" class="btn-reject" data-action="reject" data-id="${row.id}">Reject</button>`);
  }
  return parts.join('');
}

function renderReturns(returns) {
  if (!returns.length) {
    tableWrap.innerHTML = '<div id="empty">Nothing needs attention right now.</div>';
    return;
  }

  const rows = returns.map((row) => `
    <tr>
      <td>${row.order_number}</td>
      <td>${statusBadge(row)}</td>
      <td>R${parseFloat(row.fee_amount || 0).toFixed(2)}</td>
      <td>R${parseFloat(row.refund_amount || 0).toFixed(2)}</td>
      <td>${row.reason ? escapeHtml(row.reason) : '<span style="color:#9ca3af">—</span>'}</td>
      <td><div class="actions">${actionsFor(row)}</div></td>
    </tr>
  `).join('');

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Order</th><th>Status</th><th>Fee</th><th>Refund</th><th>Reason</th><th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadReturns() {
  tableWrap.innerHTML = '<div id="empty">Loading…</div>';
  try {
    const data = await apiCall('/api/returns/admin/pending');
    renderReturns(data.returns || []);
  } catch (err) {
    tableWrap.innerHTML = `<div id="empty">${escapeHtml(err.message)}</div>`;
  }
}

tableWrap.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;

  const { action, id } = btn.dataset;
  btn.disabled = true;

  try {
    if (action === 'approve') {
      await apiCall(`/api/returns/${id}/approve`, { method: 'POST' });
      showToast('Return dispatched — reverse-delivery order created.');
    } else if (action === 'reject') {
      const { confirmed, value } = await showModal({
        title: 'Reject this return?',
        message: 'Reason for rejecting this return (optional):',
        showInput: true,
        confirmLabel: 'Reject',
      });
      if (!confirmed) { btn.disabled = false; return; }
      await apiCall(`/api/returns/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ rejectionReason: value }),
      });
      showToast('Return rejected.');
    } else if (action === 'finalize') {
      const { confirmed } = await showModal({
        title: 'Finalize this refund?',
        message: "This will charge the refund to the customer's original payment method.",
        confirmLabel: 'Finalize refund',
      });
      if (!confirmed) { btn.disabled = false; return; }
      await apiCall(`/api/returns/${id}/finalize-refund`, { method: 'POST' });
      showToast('Refund finalized.');
    }
    loadReturns();
  } catch (err) {
    showToast(err.message);
    btn.disabled = false;
  }
});

// ─── Boot ───────────────────────────────────────────────────────────────────

if (getToken()) {
  showDashboard();
} else {
  showLogin();
}
