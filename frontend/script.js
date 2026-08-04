// -----------------------------------------------------------------------
// Point this at wherever the backend from /backend/server.js is running.
// -----------------------------------------------------------------------
const API_BASE = 'http://localhost:4000';

const TIERS = {
  'First Sip':            { price: 5000,   shares: 50 },
  'Bottle Backer':        { price: 20000,  shares: 250 },
  'Crate Founder':        { price: 50000,  shares: 700 },
  "Distributor's Circle": { price: 150000, shares: 2500 }
};

const PERKS = {
  'First Sip': ['Name on the backer wall', 'Backer dashboard access'],
  'Bottle Backer': [
    'Everything in First Sip',
    'Chance to receive free bottles per run',
    'Early look at new flavours'
  ],
  'Crate Founder': [
    'Everything in Bottle Backer',
    'Founder badge on dashboard',
    'Opportunity to join select bottling events'
  ],
  "Distributor's Circle": [
    'Everything in Crate Founder',
    'First look at future revenue-share terms, if offered',
    'Chance at a quarterly 1:1 with the founder'
  ]
};

let authToken = localStorage.getItem('keloToken');
let currentUser = null;      // last user object we got back from the API
let pendingAction = null;    // 'dash' or 'back'
let pendingTier = null;      // tier name, only set when pendingAction === 'back'
let withdrawalTimer = null;
let withdrawalData = null;
let selectedBackingId = null;

/* ------------------------- generic small helpers ------------------------- */

function money(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setLoading(button, loading, loadingText) {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText || 'Please wait…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function showError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
}
function hideError(el) {
  if (!el) return;
  el.textContent = '';
  el.classList.remove('show');
}

async function apiRequest(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && authToken) headers.Authorization = `Bearer ${authToken}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (networkErr) {
    return { ok: false, status: 0, data: { success: false, message: "Couldn't reach the server. Check your connection and try again." } };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    data = { success: false, message: 'Unexpected response from the server.' };
  }

  return { ok: response.ok, status: response.status, data };
}

/* ------------------------------ modal control ------------------------------ */

function openAuth(action, tierName) {
  pendingAction = action;
  pendingTier = tierName || null;

  if (authToken) {
    proceedAfterAuth();
    return;
  }
  openSignup();
}

function openSignup() {
  closeLogin();
  closePayment();
  document.getElementById('signupOverlay').classList.add('open');
}
function closeSignup() {
  document.getElementById('signupOverlay').classList.remove('open');
  hideError(document.getElementById('signupError'));
}
function openLogin() {
  closeSignup();
  closePayment();
  document.getElementById('loginOverlay').classList.add('open');
}
function closeLogin() {
  document.getElementById('loginOverlay').classList.remove('open');
  hideError(document.getElementById('loginError'));
}
function switchToLogin() { openLogin(); }
function switchToSignup() { openSignup(); }

/* --------------------------------- sign up --------------------------------- */

async function submitSignup(e) {
  e.preventDefault();
  const errorEl = document.getElementById('signupError');
  hideError(errorEl);

  const payload = {
    name: document.getElementById('signupName').value.trim(),
    email: document.getElementById('signupEmail').value.trim(),
    phone: document.getElementById('signupPhone').value.trim(),
    password: document.getElementById('signupPassword').value
  };

  const btn = document.getElementById('signupSubmitBtn');
  setLoading(btn, true, 'Creating account…');
  const { ok, data } = await apiRequest('/api/signup', { method: 'POST', body: payload });
  setLoading(btn, false);

  if (!ok || !data.success) {
    showError(errorEl, data.message || 'Something went wrong creating your account.');
    return;
  }

  authToken = data.token;
  localStorage.setItem('keloToken', authToken);
  currentUser = data.user;
  document.getElementById('signupForm').reset();
  closeSignup();
  await proceedAfterAuth();
}

/* --------------------------------- log in --------------------------------- */

async function submitLogin(e) {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  hideError(errorEl);

  const payload = {
    email: document.getElementById('loginEmail').value.trim(),
    password: document.getElementById('loginPassword').value
  };

  const btn = document.getElementById('loginSubmitBtn');
  setLoading(btn, true, 'Logging in…');
  const { ok, data } = await apiRequest('/api/login', { method: 'POST', body: payload });
  setLoading(btn, false);

  if (!ok || !data.success) {
    showError(errorEl, data.message || 'Could not log you in.');
    return;
  }

  authToken = data.token;
  localStorage.setItem('keloToken', authToken);
  currentUser = data.user;
  document.getElementById('loginForm').reset();
  closeLogin();
  await proceedAfterAuth();
}

function logout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('keloToken');
  showSite();
}

/* --------------------- logged-in redirection --------------------- */

async function proceedAfterAuth() {
  if (pendingAction === 'back' && pendingTier) {
    openPayment(pendingTier);
    return;
  }

  const { ok, data } = await apiRequest('/api/dashboard', { auth: true });
  if (!ok || !data.success) {
    logout();
    openLogin();
    return;
  }
  currentUser = data.user;
  renderDashboard(currentUser);
  showDash();
}

/* ------------------------------------------------------------------------- */
/* PAYMENT MODAL                                                            */
/* ------------------------------------------------------------------------- */

function openPayment(tierName) {
  const tier = TIERS[tierName];
  if (!tier) return;

  closeSignup();
  closeLogin();

  document.getElementById('paySummaryTier').textContent = `Back ${tierName}`;
  document.getElementById('paySummarySub').textContent = 'Simulated checkout — enter your card details to continue.';
  document.getElementById('paySummaryBox').innerHTML = `
    <div>
      <div class="ps-tier">${tierName}</div>
      <div class="ps-shares">${tier.shares.toLocaleString('en-NG')} backer shares</div>
    </div>
    <div class="ps-price">${money(tier.price)}</div>
  `;

  resetPaymentModal();
  document.getElementById('paymentOverlay').classList.add('open');
}

function closePayment() {
  document.getElementById('paymentOverlay').classList.remove('open');
  resetPaymentModal();
}

function resetPaymentModal() {
  document.getElementById('paymentForm').reset();
  hideError(document.getElementById('payError'));
  document.getElementById('payFormStage').style.display = 'block';
  document.getElementById('payProcessingStage').style.display = 'none';
  document.getElementById('paySuccessStage').style.display = 'none';
  const btn = document.getElementById('paySubmitBtn');
  setLoading(btn, false, 'Pay now (simulated)');
}

document.addEventListener('DOMContentLoaded', () => {
  const cardInput = document.getElementById('payCardNumber');
  if (cardInput) {
    cardInput.addEventListener('input', () => {
      const digits = cardInput.value.replace(/\D/g, '').slice(0, 19);
      cardInput.value = digits.replace(/(.{4})/g, '$1 ').trim();
    });
  }
  const expiryInput = document.getElementById('payExpiry');
  if (expiryInput) {
    expiryInput.addEventListener('input', () => {
      let digits = expiryInput.value.replace(/\D/g, '').slice(0, 4);
      if (digits.length > 2) digits = digits.slice(0, 2) + '/' + digits.slice(2);
      expiryInput.value = digits;
    });
  }
  const cvcInput = document.getElementById('payCvc');
  if (cvcInput) {
    cvcInput.addEventListener('input', () => {
      cvcInput.value = cvcInput.value.replace(/\D/g, '').slice(0, 4);
    });
  }
});

function validatePaymentForm() {
  const payName = document.getElementById('payName').value.trim();
  let cardDigits = document.getElementById('payCardNumber').value.replace(/\D/g, '');
  let expiry = document.getElementById('payExpiry').value.trim();
  let cvc = document.getElementById('payCvc').value.trim();

  if (!payName) return { error: 'Enter the name on the card.' };
  if (cardDigits.length < 13 || cardDigits.length > 19) return { error: 'Enter a valid card number.' };

  const expiryMatch = /^(\d{2})\/(\d{2})$/.exec(expiry);
  if (!expiryMatch) return { error: 'Enter the expiry as MM/YY.' };
  const month = Number(expiryMatch[1]);
  if (month < 1 || month > 12) return { error: 'Enter a valid expiry month.' };

  if (cvc.length < 3 || cvc.length > 4) return { error: 'Enter a valid CVC.' };

  return { error: null, payName, cardDigits, expiry, cvc };
}

async function submitPayment(e) {
  e.preventDefault();
  const errorEl = document.getElementById('payError');
  hideError(errorEl);

  const { error: validationError, payName, cardDigits, expiry, cvc } = validatePaymentForm();
  if (validationError) {
    showError(errorEl, validationError);
    return;
  }

  document.getElementById('payFormStage').style.display = 'none';
  document.getElementById('payProcessingStage').style.display = 'flex';
  await sleep(1400);

  document.getElementById('payProcessingStage').style.display = 'none';
  document.getElementById('paySuccessStage').style.display = 'flex';
  document.getElementById('paySuccessSub').textContent = 'Adding your shares to your dashboard…';

  const simulatedPaymentRef = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const { ok, data } = await apiRequest('/api/back', {
    method: 'POST',
    auth: true,
    body: { tierName: pendingTier, simulatedPaymentRef, payName, cardDigits, expiry, cvc }
  });

  if (!ok || !data.success) {
    document.getElementById('paySuccessStage').style.display = 'none';
    document.getElementById('payFormStage').style.display = 'block';
    showError(errorEl, data.message || 'Could not record your backing right now. Please try again.');
    return;
  }

  currentUser = data.user;
  await sleep(600);
  pendingAction = null;
  pendingTier = null;
  closePayment();
  renderDashboard(currentUser);
  showDash();
  refreshStats();
}

/* ------------------------------ dashboard render ------------------------------ */

function renderDashboard(user) {
  document.getElementById('dashName').textContent = user.name ? `Welcome back, ${user.name.split(' ')[0]}` : 'Welcome back';

  const backings = user.backings || [];
  const hasTier = backings.length > 0;
  document.getElementById('dashNoTier').style.display = hasTier ? 'none' : 'block';
  document.getElementById('dashHasTier').style.display = hasTier ? 'contents' : 'none';

  if (!hasTier) {
    document.getElementById('dashSub').textContent = `BACKER #${user.backerNumber ?? '—'} · NOT YET BACKING A TIER`;
    return;
  }

  document.getElementById('dashSub').textContent =
    `BACKER #${user.backerNumber} · ${backings.length} BACKING${backings.length > 1 ? 'S' : ''}`;

  const totals = user.totals || { shares: 0, amountBacked: 0, projected7: 0, projected30: 0 };
  document.getElementById('totShares').textContent = totals.shares.toLocaleString('en-NG');
  document.getElementById('totAmount').textContent = money(totals.amountBacked);
  document.getElementById('totProjected7').textContent = money(totals.projected7);
  document.getElementById('totProjected30').textContent = money(totals.projected30);

  const grid = document.getElementById('backingGrid');
  grid.innerHTML = '';
  backings.forEach(b => {
    const date = new Date(b.createdAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
    const tile = document.createElement('div');
    tile.className = 'backing-tile';
    tile.innerHTML = `
      <div class="bt-head">
        <div class="bt-tier">${b.tier}</div>
        <div class="bt-date">${date}</div>
      </div>
      <div class="bt-shares">${b.shares.toLocaleString('en-NG')}</div>
      <div class="bt-shares-label">Backer shares</div>
      <div class="bt-row">
        <div><b>${money(b.amount)}</b><span>Backed</span></div>
        <div><b>${money(b.projected7)}</b><span>7-day proj.</span></div>
        <div><b>${money(b.projected30)}</b><span>30-day proj.</span></div>
      </div>
    `;
    grid.appendChild(tile);
  });
}

/* ------------------------------ navigation ------------------------------ */

function showDash() {
  document.getElementById('site').style.display = 'none';
  document.getElementById('dash').style.display = 'block';
  window.scrollTo(0, 0);
}
function showSite() {
  document.getElementById('dash').style.display = 'none';
  document.getElementById('site').style.display = 'block';
  window.scrollTo(0, 0);
}

/* ------------------------------ site stats ------------------------------ */

async function refreshStats() {
  const { ok, data } = await apiRequest('/api/stats');
  if (!ok || !data.success) return;

  document.getElementById('statTotalBackers').textContent = data.totalBackers.toLocaleString('en-NG');
  document.getElementById('catTotal').textContent = data.totalBackers.toLocaleString('en-NG');
  document.getElementById('bottleCaption').textContent = `${data.totalBackers.toLocaleString('en-NG')} BACKERS AND COUNTING`;

  document.getElementById('catFirstSip').textContent = data.categories['First Sip'] ?? 0;
  document.getElementById('catBottleBacker').textContent = data.categories['Bottle Backer'] ?? 0;
  document.getElementById('catCrateFounder').textContent = data.categories["Distributor's Circle"] ?? 0;
  document.getElementById('catDistributorsCircle').textContent = data.categories["Distributor's Circle"] ?? 0;
}

window.addEventListener('load', () => {
  requestAnimationFrame(() => {
    const fillRect = document.querySelector('.fill-rect');
    if (fillRect) fillRect.style.transform = 'translateY(60px)';
  });
  refreshStats();
});

/* ==========================================================================
   WITHDRAWAL SYSTEM
   ========================================================================== */

async function openWithdrawalModal() {
  const overlay = document.getElementById('withdrawalOverlay');
  overlay.classList.add('open');

  const message = document.getElementById('withdrawModalMessage');
  if (message) message.textContent = 'Loading your withdrawal information…';

  await loadWithdrawalStatus();
  await loadTransactionHistory();
}

function closeWithdrawalModal() {
  const overlay = document.getElementById('withdrawalOverlay');
  overlay.classList.remove('open');

  if (withdrawalTimer) {
    clearInterval(withdrawalTimer);
    withdrawalTimer = null;
  }
}

async function loadWithdrawalStatus() {
  const { ok, data } = await apiRequest('/api/withdrawal-status', { auth: true });

  if (!ok || !data.success) {
    const message = document.getElementById('withdrawModalMessage');
    if (message) message.textContent = data.message || 'Could not load withdrawal information.';
    return;
  }

  withdrawalData = data;
  renderWithdrawalModal(data);
}

function renderWithdrawalModal(data) {
  const currentBalance = document.getElementById('withdrawCurrentBalance');
  const originalAmount = document.getElementById('withdrawOriginalAmount');
  const growthAmount = document.getElementById('withdrawGrowthAmount');
  const button = document.getElementById('withdrawConfirmButton');
  const countdownBox = document.getElementById('withdrawCountdownBox');
  const availableBox = document.getElementById('withdrawAvailableBox');
  const message = document.getElementById('withdrawModalMessage');

  if (currentBalance) currentBalance.textContent = money(data.currentBalance || 0);
  if (originalAmount) originalAmount.textContent = money(data.originalAmount || 0);
  if (growthAmount) growthAmount.textContent = money(data.growthAmount || 0);

  if (withdrawalTimer) {
    clearInterval(withdrawalTimer);
    withdrawalTimer = null;
  }

  const backings = data.backings || [];
  renderWithdrawalBackings(backings);

  if (backings.length === 0) {
    if (countdownBox) countdownBox.style.display = 'none';
    if (availableBox) availableBox.style.display = 'none';
    if (button) {
      button.disabled = true;
      button.textContent = 'No Active Backings';
    }
    if (message) message.textContent = 'You have no active backings.';
    return;
  }

  // Find the selected backing or the first eligible backing
  const selected = backings.find(b => b.id == selectedBackingId) || backings[0];

  if (selected && !selected.eligible) {
    if (countdownBox) countdownBox.style.display = 'block';
    if (availableBox) availableBox.style.display = 'none';
    if (button) {
      button.disabled = true;
      button.textContent = 'Backing Locked';
    }
    if (message) message.textContent = 'Selected backing is still in its holding period.';
    startWithdrawalCountdown(selected.remainingMs);
  } else {
    if (countdownBox) countdownBox.style.display = 'none';
    if (availableBox) availableBox.style.display = 'flex';
    if (button) {
      button.disabled = !selected;
      button.textContent = 'Request Withdrawal';
    }
    if (message) message.textContent = 'Select an eligible backing to request a withdrawal.';
  }
}

window.selectBacking = function(id) {
  selectedBackingId = id;
  if (withdrawalData) {
    renderWithdrawalModal(withdrawalData);
  }
};

function renderWithdrawalBackings(backings) {
  const container = document.getElementById('withdrawalBackingsContainer');
  if (!container) return;

  if (!backings || backings.length === 0) {
    container.innerHTML = '<p class="no-backings">No active backings available.</p>';
    return;
  }

  container.innerHTML = backings.map(b => {
    const isSelected = selectedBackingId == b.id;
    const isLocked = !b.eligible;

    return `
      <div 
        class="backing-card ${isSelected ? 'selected' : ''} ${isLocked ? 'locked' : ''}" 
        data-backing-id="${b.id}"
        onclick="window.selectBacking('${b.id}')"
        style="opacity: ${isLocked ? '0.6' : '1'}; cursor: pointer;"
      >
        <div class="backing-header">
          <h3>${b.tier} ${isLocked ? '🔒' : ''}</h3>
          <span>₦${Number(b.currentValue || b.amount).toLocaleString()}</span>
        </div>
        <small>Backed ${new Date(b.createdAt).toLocaleDateString()} ${isLocked ? ' (Locked)' : ' (Ready)'}</small>
      </div>
    `;
  }).join('');
}

async function loadTransactionHistory() {
  const container = document.getElementById('transactionHistoryContainer');
  if (!container) return;

  const res = await apiRequest('/api/transactions', { auth: true });
  if (res.ok && res.data.success) {
    const txs = res.data.transactions;
    if (txs.length === 0) {
      container.innerHTML = '<p>No transactions found.</p>';
      return;
    }

    container.innerHTML = txs.map(tx => `
      <div class="tx-row ${tx.type.toLowerCase()}">
        <div class="tx-info">
          <span class="tx-badge ${tx.type.toLowerCase()}">${tx.type}</span>
          <span class="tx-title">${tx.tier_name || 'Transfer'}</span>
        </div>
        <div class="tx-details">
          <span class="tx-amount ${tx.type === 'IN' ? 'in-val' : 'out-val'}">
            ${tx.type === 'IN' ? '+' : '-'}₦${Number(tx.amount).toLocaleString()}
          </span>
          <small class="tx-date">${new Date(tx.created_at).toLocaleString()}</small>
        </div>
      </div>
    `).join('');
  }
}

async function refreshWithdrawalModal() {
  selectedBackingId = null;
  await loadWithdrawalStatus();
  await loadTransactionHistory();

  const dashRes = await apiRequest('/api/dashboard', { auth: true });
  if (dashRes.ok && dashRes.data.success) {
    currentUser = dashRes.data.user;
    renderDashboard(currentUser);
  }
}

async function withdrawFunds() {
  if (!selectedBackingId) {
    alert('Please select an available backing card first.');
    return;
  }

  const confirmBtn = document.getElementById('withdrawConfirmButton');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerText = 'Processing...';
  }

  try {
    const res = await apiRequest('/api/withdraw', {
      method: 'POST',
      body: { backingId: selectedBackingId },
      auth: true
    });

    if (res.ok && res.data.success) {
      alert('Withdrawal request successful!');
      await refreshWithdrawalModal();
    } else {
      alert(res.data?.message || 'Withdrawal failed.');
    }
  } catch (err) {
    console.error('Withdrawal error:', err);
    alert('An error occurred during withdrawal.');
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerText = 'Request Withdrawal';
    }
  }
}

function startWithdrawalCountdown(initialMs) {
  let remaining = Math.max(0, initialMs);
  const timer = document.getElementById('withdrawCountdown');

  function update() {
    if (remaining <= 0) {
      if (timer) timer.textContent = 'Withdrawal available';
      if (withdrawalTimer) clearInterval(withdrawalTimer);
      withdrawalTimer = null;
      loadWithdrawalStatus();
      return;
    }

    const totalSeconds = Math.floor(remaining / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (timer) {
      timer.textContent = `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
    }

    remaining -= 1000;
  }

  update();
  withdrawalTimer = setInterval(update, 1000);
}




/* =========================================
   WITHDRAWAL MODAL
========================================= */

async function openWithdrawalModal() {
  document.getElementById('transactionOverlay')?.classList.remove('open');
  document.getElementById('withdrawalOverlay').classList.add('open');

  await loadWithdrawalStatus();
}

function closeWithdrawalModal() {
  document.getElementById('withdrawalOverlay').classList.remove('open');
}

/* =========================================
   TRANSACTION HISTORY MODAL
========================================= */

function openTransactionModal() {
  document.getElementById('withdrawalOverlay')?.classList.remove('open');
  document.getElementById('transactionOverlay').classList.add('open');

  // Fetch/render on open rather than on page load, so the data is
  // fresh whenever someone jumps in from any trigger button.
  if (typeof loadTransactionHistory === 'function') {
    loadTransactionHistory();
  }
}

function closeTransactionModal() {
  document.getElementById('transactionOverlay').classList.remove('open');
}

/* =========================================
   SWITCHING BETWEEN THE TWO
========================================= */

function goToTransactionHistory() {
  openTransactionModal();
}

function goToWithdrawal() {
  openWithdrawalModal();
}

/* =========================================
   EXAMPLE RENDERER
   Adjust field names to match whatever shape your
   transaction data actually comes back in — this is
   just scaffolding so tx-item styling has something
   to hook into. Wire this into your real fetch call.
========================================= */

function renderTransactionHistory(transactions) {
  const container = document.getElementById('transactionHistoryContainer');

  if (!transactions || transactions.length === 0) {
    container.innerHTML = '<p class="tx-empty">No transactions yet.</p>';
    return;
  }

  container.innerHTML = transactions.map(tx => {
    const isPositive = tx.amount >= 0;
    const sign = isPositive ? '+' : '−';
    const amountClass = isPositive ? 'positive' : 'negative';

    return `
      <div class="tx-item">
        <div>
          <div class="tx-item-type">${tx.type}</div>
          <div class="tx-item-date">${tx.date}</div>
        </div>
        <div class="tx-item-amount ${amountClass}">${sign}₦${Math.abs(tx.amount).toLocaleString()}</div>
      </div>
    `;
  }).join('');
}
// for when i am putting in a ne place
/* Example — replace with your real fetch:
function loadTransactionHistory() {
  fetch('/api/transactions')
    .then(res => res.json())
    .then(data => renderTransactionHistory(data))
    .catch(() => {
      document.getElementById('transactionHistoryContainer').innerHTML =
        '<p class="tx-empty">Couldn\'t load history — try again.</p>';
    });
}
*/