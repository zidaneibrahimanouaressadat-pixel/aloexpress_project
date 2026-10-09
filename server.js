require('dotenv').config();
const express = require('express'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const multer = require('multer'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const { BOT_TOKEN, ADMIN_CHAT_ID, JWT_SECRET, PORT = 3000 } = process.env;
if (!BOT_TOKEN || !ADMIN_CHAT_ID || !JWT_SECRET) { console.error('املأ ملف .env أولاً'); process.exit(1); }
const RATE = 290, WELCOME = 50, REWARD = 100;

// ---- قاعدة بيانات: MongoDB إن وُجد MONGODB_URI، وإلا ملف محلي ----
const DB_FILE = path.join(__dirname, 'data.json');
let db = { users: {}, orders: {}, reviews: [], offset: 0 };
let col = null, chain = Promise.resolve();
const save = () => {
  if (col) { chain = chain.then(() => col.replaceOne({ _id: 'db' }, { _id: 'db', ...db }, { upsert: true })).catch(e => console.error('save:', e.message)); return; }
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE);
};
async function initDb() {
  if (process.env.MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    col = client.db('aloexpress').collection('store');
    const doc = await col.findOne({ _id: 'db' });
    if (doc) { delete doc._id; db = { ...db, ...doc }; }
  } else { try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {} }
}

// ---- تيليغرام ----
async function tg(method, body) {
  const isForm = body instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? body : JSON.stringify(body)
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.description || 'Telegram error');
  return d;
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function affiliate(url) {
  if (/temu\.(co|com)/.test(url) && !url.includes('_x_ads_sub_tracking_id'))
    return url + (url.includes('?') ? '&' : '?') + '_x_ads_sub_tracking_id=aloexpress';
  if (/aliexpress\.com/.test(url) && !url.includes('aff_track='))
    return `https://s.click.aliexpress.com/_c3vvPY5L?aff_track=aloexpress&orig_url=${encodeURIComponent(url)}`;
  return url;
}

async function handleCallback(cq) {
  const ok = txt => tg('answerCallbackQuery', { callback_query_id: cq.id, text: txt }).catch(() => {});
  if (String(cq.from.id) !== String(ADMIN_CHAT_ID)) return ok('غير مصرح');
  const [action, id] = (cq.data || '').split(':');
  const order = db.orders[id];
  if (!order) return ok('الطلب غير موجود');
  if (order.status !== 'pending') return ok('تمت معالجته سابقاً');
  if (action === 'a') {
    order.status = 'approved';
    const u = db.users[order.user];
    if (u) u.coins += REWARD;
  } else if (action === 'r') order.status = 'rejected';
  else return ok('إجراء غير معروف');
  save();
  await ok(order.status === 'approved' ? `تم منح ${REWARD} عملة` : 'تم الرفض');
  const m = cq.message;
  tg('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [[{ text: order.status === 'approved' ? '✅ تم القبول' : '❌ تم الرفض', callback_data: 'x' }]] } }).catch(() => {});
}

const WH_SECRET = crypto.createHash('sha256').update(String(BOT_TOKEN)).digest('hex').slice(0, 32);
async function startTelegram() {
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (base) { await tg('setWebhook', { url: `${base}/tg/${WH_SECRET}`, allowed_updates: ['callback_query'] }); console.log('webhook set'); return; }
  await tg('deleteWebhook', {}).catch(() => {});
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset: db.offset, timeout: 30, allowed_updates: ['callback_query'] });
      for (const u of r.result) { db.offset = u.update_id + 1; if (u.callback_query) await handleCallback(u.callback_query); }
      if (r.result.length) save();
    } catch (e) { console.error('poll:', e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}

// ---- الخادم ----
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
  fontSrc: ['https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'], imgSrc: ["'self'", 'data:']
} } }));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.post('/tg/:s', async (req, res) => {
  if (req.params.s !== WH_SECRET) return res.sendStatus(404);
  try { if (req.body.callback_query) await handleCallback(req.body.callback_query); } catch (e) { console.error(e.message); }
  res.sendStatus(200);
});
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'محاولات كثيرة، حاول لاحقاً' } });
const orderLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'طلبات كثيرة، حاول لاحقاً' } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const setCookie = (res, username) => res.cookie('tok', jwt.sign({ u: username }, JWT_SECRET, { expiresIn: '7d' }),
  { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 });
const pub = u => ({ username: u.username, fullName: u.fullName, coins: u.coins });

function auth(req, res, next) {
  try { const { u } = jwt.verify(req.cookies.tok, JWT_SECRET); req.user = db.users[u]; } catch {}
  if (!req.user) return res.status(401).json({ error: 'سجّل الدخول أولاً' });
  next();
}

app.post('/api/register', authLimiter, async (req, res) => {
  const { fullName, username, password } = req.body || {};
  if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.length > 50) return res.status(400).json({ error: 'الاسم غير صالح' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ error: 'اسم المستخدم: 3-20 حرفاً إنجليزياً أو أرقاماً' });
  if (typeof password !== 'string' || password.length < 6 || password.length > 100) return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
  const key = username.toLowerCase();
  if (db.users[key]) return res.status(409).json({ error: 'اسم المستخدم مستخدم' });
  db.users[key] = { username: key, fullName: fullName.trim(), hash: await bcrypt.hash(password, 10), coins: WELCOME };
  save(); setCookie(res, key); res.json(pub(db.users[key]));
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const u = db.users[String(username || '').toLowerCase()];
  if (!u || !(await bcrypt.compare(String(password || ''), u.hash))) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  setCookie(res, u.username); res.json(pub(u));
});

app.post('/api/logout', (req, res) => res.clearCookie('tok').json({ ok: true }));
app.get('/api/me', auth, (req, res) => res.json(pub(req.user)));

app.post('/api/orders', auth, orderLimiter, upload.single('receipt'), async (req, res) => {
  try {
    const b = req.body, f = req.file;
    const name = String(b.name || '').trim(), phone = String(b.phone || '').trim(), state = String(b.state || '').trim();
    const address = String(b.address || '').trim(), notes = String(b.notes || '').trim().slice(0, 300) || 'لا توجد';
    const usd = parseFloat(b.usd);
    if (name.length < 2 || name.length > 60 || state.length < 2 || state.length > 40 || address.length < 5 || address.length > 150) return res.status(400).json({ error: 'تحقق من معلومات الشحن' });
    if (!/^0[5-7]\d{8}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف غير صالح (مثال: 0555123456)' });
    if (!(usd > 0 && usd <= 5000)) return res.status(400).json({ error: 'السعر بالدولار غير صالح' });
    if (!f || !['image/jpeg', 'image/png', 'image/webp'].includes(f.mimetype)) return res.status(400).json({ error: 'أرفق صورة الحوالة (JPG/PNG/WEBP، حتى 5MB)' });
    const links = String(b.links || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!links.length || links.length > 10 || links.some(l => l.length > 500 || !/^https?:\/\//i.test(l))) return res.status(400).json({ error: 'ضع من 1 إلى 10 روابط صحيحة (تبدأ بـ http)' });

    const id = crypto.randomBytes(6).toString('hex'), dzd = Math.round(usd * RATE);
    const caption = `🛒 <b>طلب جديد #${id}</b>\n\n👤 المستخدم: ${esc(req.user.username)}\n📍 الاسم: ${esc(name)}\n📞 الهاتف: ${esc(phone)}\n📍 الولاية: ${esc(state)}\n🏠 العنوان: ${esc(address)}\n📝 ملاحظات: ${esc(notes)}\n💵 $${usd}\n💰 <b>${dzd} دج</b>\n🎁 مكافأة معلقة: +${REWARD} عملة`;
    const form = new FormData();
    form.append('chat_id', ADMIN_CHAT_ID);
    form.append('photo', new Blob([f.buffer], { type: f.mimetype }), 'receipt');
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: `✅ قبول ومنح ${REWARD} عملة`, callback_data: 'a:' + id }, { text: '❌ رفض', callback_data: 'r:' + id }]] }));
    const sent = await tg('sendPhoto', form);
    await tg('sendMessage', { chat_id: ADMIN_CHAT_ID, reply_to_message_id: sent.result.message_id, disable_web_page_preview: true,
      text: '🔗 روابط الطلب #' + id + ':\n\n' + links.map((l, i) => `${i + 1}. ${affiliate(l)}`).join('\n').slice(0, 4000) });

    db.orders[id] = { id, user: req.user.username, usd, dzd, status: 'pending', at: Date.now() };
    save();
    res.json({ ok: true, id, dzd });
  } catch (e) { console.error('order:', e.message); res.status(502).json({ error: 'تعذر إرسال الطلب، حاول مجدداً' }); }
});

app.get('/api/orders', auth, (req, res) => res.json(Object.values(db.orders)
  .filter(o => o.user === req.user.username).sort((a, b) => b.at - a.at).slice(0, 20)
  .map(({ id, usd, dzd, status, at }) => ({ id, usd, dzd, status, at }))));
app.get('/api/stats', (req, res) => res.json({ users: Object.keys(db.users).length, orders: Object.keys(db.orders).length }));

app.get('/api/reviews', (req, res) => res.json(db.reviews.slice(-50).reverse()));
app.post('/api/reviews', auth, (req, res) => {
  const comment = String((req.body || {}).comment || '').trim(), rating = parseInt((req.body || {}).rating);
  if (comment.length < 3 || comment.length > 300 || !(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'اكتب رأياً (3-300 حرف) واختر تقييماً' });
  db.reviews.push({ name: req.user.fullName, rating, comment, at: Date.now() });
  save(); res.json({ ok: true });
});

initDb().then(() => app.listen(PORT, () => {
  console.log('يعمل على http://localhost:' + PORT);
  startTelegram().catch(e => console.error('tg:', e.message));
})).catch(e => { console.error('db:', e.message); process.exit(1); });