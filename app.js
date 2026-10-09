const $ = id => document.getElementById(id);
const RATE = 290;

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show';
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = 'toast'), 3500);
}
async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'حدث خطأ');
  return d;
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function showApp(user) {
  $('authView').style.display = 'none'; $('appView').style.display = 'block'; $('header').style.display = 'flex';
  if (user) $('wallet').textContent = `الرصيد: ${user.coins} عملة (${user.coins} دج)`;
  if (user) onEnter(user);
  if (user && !$('clientName').value) $('clientName').value = user.fullName;
}
function showAuth() {
  $('authView').style.display = 'flex'; $('appView').style.display = 'none'; $('header').style.display = 'none';
}
async function refreshWallet() { try { showApp(await api('/api/me')); } catch { showAuth(); } }

function guard(btn, fn) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message); }
    btn.disabled = false;
  });
}

$('toReg').onclick = () => { $('loginBox').style.display = 'none'; $('regBox').style.display = 'block'; };
$('toLogin').onclick = () => { $('regBox').style.display = 'none'; $('loginBox').style.display = 'block'; };

guard($('loginBtn'), async () => {
  const u = await post('/api/login', { username: $('loginUsername').value.trim(), password: $('loginPassword').value });
  $('loginPassword').value = ''; showApp(u); toast('تم تسجيل الدخول'); loadReviews();
});
guard($('regBtn'), async () => {
  const u = await post('/api/register', { fullName: $('regFullName').value, username: $('regUsername').value.trim(), password: $('regPassword').value });
  $('regPassword').value = ''; showApp(u); toast('تم إنشاء الحساب وإضافة 50 عملة!'); loadReviews();
});
$('logoutBtn').onclick = async () => { await post('/api/logout', {}).catch(() => {}); showAuth(); toast('تم تسجيل الخروج'); };

$('shareLink').onclick = e => { e.preventDefault(); navigator.clipboard.writeText(location.origin).then(() => toast('تم نسخ الرابط')); };

$('usd').oninput = () => { $('dzd').textContent = Math.round((parseFloat($('usd').value) || 0) * RATE).toLocaleString('en') + ' دج'; };
$('fileBox').onclick = () => $('receipt').click();
$('receipt').onchange = () => {
  const f = $('receipt').files[0];
  $('fname').textContent = f ? '📎 ' + f.name : '';
};

guard($('orderBtn'), async () => {
  const f = $('receipt').files[0];
  if (!f) throw new Error('أرفق صورة الحوالة (إجباري)');
  if (f.size > 5 * 1024 * 1024) throw new Error('الصورة أكبر من 5MB');
  const fd = new FormData();
  fd.append('name', $('clientName').value); fd.append('phone', $('clientPhone').value);
  fd.append('state', $('clientState').value); fd.append('address', $('clientAddress').value);
  fd.append('links', $('links').value); fd.append('notes', $('notes').value);
  fd.append('usd', $('usd').value); fd.append('receipt', f);
  const r = await api('/api/orders', { method: 'POST', body: fd });
  const box = $('okBox'); box.style.display = 'block';
  box.textContent = `✅ تم إرسال طلبك #${r.id} (${r.dzd} دج). سيُراجع من الإدارة وتُضاف مكافأتك عند القبول.`;
  ['links', 'notes', 'usd', 'receipt'].forEach(i => ($(i).value = ''));
  $('fname').textContent = ''; $('dzd').textContent = '0 دج';
  toast('تم إرسال الطلب بنجاح'); loadOrders();
});

function renderReviews(list) {
  const c = $('reviews'); c.replaceChildren();
  for (const r of list) {
    const d = document.createElement('div'); d.className = 'review';
    const n = document.createElement('b'); n.textContent = r.name;
    const s = document.createElement('div'); s.className = 'stars'; s.textContent = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
    const t = document.createElement('div'); t.textContent = r.comment;
    d.append(n, s, t); c.append(d);
  }
}
async function loadReviews() { try { renderReviews(await api('/api/reviews')); } catch {} }
guard($('reviewBtn'), async () => {
  await post('/api/reviews', { rating: $('rating').value, comment: $('comment').value });
  $('comment').value = ''; toast('شكراً! تمت إضافة تقييمك'); loadReviews();
});

refreshWallet(); loadReviews();
setInterval(() => { if ($('appView').style.display === 'block') { refreshWallet(); loadOrders(); } }, 30000);

// ---- ميزات جديدة ----
function onEnter(u) {
  $('hello').textContent = `أهلاً ${u.fullName} 👋`;
  $('stCoins').textContent = u.coins;
  loadOrders(); loadStats();
}
async function loadStats() {
  try { const d = await api('/api/stats'); $('stOrders').textContent = d.orders; $('stUsers').textContent = d.users; } catch {}
}
const LABELS = { pending: 'قيد المراجعة', approved: 'مقبول', rejected: 'مرفوض' };
async function loadOrders() {
  try {
    const list = await api('/api/orders'), c = $('myOrders');
    if (!list.length) return;
    c.replaceChildren();
    for (const o of list) {
      const d = document.createElement('div'); d.className = 'order';
      const t = document.createElement('span');
      t.textContent = `#${o.id} • $${o.usd} • ${o.dzd} دج • ${new Date(o.at).toLocaleDateString('ar-DZ')}`;
      const b = document.createElement('span'); b.className = 'badge ' + o.status; b.textContent = LABELS[o.status] || o.status;
      d.append(t, b); c.append(d);
    }
  } catch {}
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('themeBtn').firstElementChild.className = t === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
  try { localStorage.setItem('theme', t); } catch {}
}
$('themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
try { applyTheme(localStorage.getItem('theme') || 'light'); } catch { applyTheme('light'); }
