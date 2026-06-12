'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const { v2: cloudinary } = require('cloudinary');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const CONFIG = Object.freeze({
  botToken: process.env.BOT_TOKEN || '',
  botUsername: String(process.env.BOT_USERNAME || '').replace(/^@/, ''),
  miniAppShortName: String(process.env.MINI_APP_SHORT_NAME || '').trim(),
  adminUsername: String(process.env.ADMIN_TELEGRAM_USERNAME || '').replace(/^@/, ''),
  adminIds: new Set(
    String(process.env.ADMIN_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  ),
  dailyBonus: Number(process.env.DAILY_BONUS || 0.5),
  referrerBonus: Number(process.env.REFERRER_BONUS || 1),
  referredBonus: Number(process.env.REFERRED_BONUS || 0.5),
  taskBonus: Number(process.env.TASK_BONUS || 0.5),
  minWithdraw: Number(process.env.MIN_WITHDRAW || 30),
  authMaxAgeSeconds: Number(process.env.AUTH_MAX_AGE_SECONDS || 86400),
  devMode: String(process.env.DEV_MODE || 'false').toLowerCase() === 'true',
  devTelegramId: String(process.env.DEV_TELEGRAM_ID || '8231044589'),
  mandatoryCacheSeconds: Number(process.env.MANDATORY_CACHE_SECONDS || 300),
});

const cloudinaryEnabled = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (cloudinaryEnabled) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '5m' }));

app.get('/health', (_req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;
  res.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? 'ok' : 'degraded',
    database: databaseConnected ? 'connected' : 'disconnected',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)) {
      return cb(new Error('Faqat JPG, PNG, WEBP yoki GIF rasm yuklash mumkin.'));
    }
    cb(null, true);
  },
});

mongoose.set('strictQuery', true);

const userSchema = new mongoose.Schema({
  telegramId: { type: String, unique: true, index: true, required: true },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  photoUrl: { type: String, default: '' },
  languageCode: { type: String, default: 'uz' },
  balance: { type: Number, default: 0, min: 0 },
  totalEarned: { type: Number, default: 0, min: 0 },
  totalWithdrawn: { type: Number, default: 0, min: 0 },
  referralCode: { type: String, unique: true, index: true, required: true },
  referredBy: { type: String, default: null, index: true },
  referralCount: { type: Number, default: 0, min: 0 },
  dailyBonusAt: { type: Date, default: null },
  blocked: { type: Boolean, default: false },
  lastSeenAt: { type: Date, default: Date.now },
  mandatoryVerifiedAt: { type: Date, default: null },
  mandatorySignature: { type: String, default: '' },
}, { timestamps: true, versionKey: false });

const requiredChatSchema = new mongoose.Schema({
  title: { type: String, trim: true, required: true, maxlength: 80 },
  type: { type: String, enum: ['channel', 'group'], default: 'channel' },
  chatId: { type: String, trim: true, required: true },
  inviteLink: { type: String, trim: true, required: true },
  active: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });

const appSettingSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'main' },
  logoUrl: { type: String, default: '' },
  logoPublicId: { type: String, default: '' },
}, { timestamps: true, versionKey: false });

const broadcastSchema = new mongoose.Schema({
  text: { type: String, trim: true, required: true, maxlength: 4000 },
  imageUrl: { type: String, default: '' },
  imagePublicId: { type: String, default: '' },
  buttonText: { type: String, trim: true, default: '', maxlength: 64 },
  buttonUrl: { type: String, trim: true, default: '', maxlength: 500 },
  sent: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  createdBy: { type: String, default: '' },
}, { timestamps: true, versionKey: false });

const taskSchema = new mongoose.Schema({
  title: { type: String, trim: true, required: true, maxlength: 80 },
  type: { type: String, enum: ['channel', 'group'], default: 'channel' },
  chatId: { type: String, trim: true, required: true },
  username: { type: String, trim: true, default: '' },
  inviteLink: { type: String, trim: true, required: true },
  reward: { type: Number, min: 0.5, default: CONFIG.taskBonus },
  active: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });

const taskClaimSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
  reward: { type: Number, required: true },
}, { timestamps: true, versionKey: false });
taskClaimSchema.index({ userId: 1, taskId: 1 }, { unique: true });

const shopItemSchema = new mongoose.Schema({
  title: { type: String, trim: true, required: true, maxlength: 100 },
  description: { type: String, trim: true, default: '', maxlength: 700 },
  ucAmount: { type: Number, min: 0, required: true },
  priceUZS: { type: Number, min: 0, required: true },
  imageUrl: { type: String, default: '' },
  imagePublicId: { type: String, default: '' },
  stock: { type: Number, default: -1 },
  active: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });

const withdrawalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount: { type: Number, min: CONFIG.minWithdraw, required: true },
  pubgId: { type: String, trim: true, required: true, maxlength: 40 },
  pubgNickname: { type: String, trim: true, default: '', maxlength: 50 },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  adminNote: { type: String, trim: true, default: '', maxlength: 500 },
  processedBy: { type: String, default: '' },
  processedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

const purchaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShopItem', required: true, index: true },
  itemTitle: { type: String, required: true },
  ucAmount: { type: Number, required: true },
  priceUZS: { type: Number, required: true },
  pubgId: { type: String, trim: true, required: true, maxlength: 40 },
  pubgNickname: { type: String, trim: true, default: '', maxlength: 50 },
  phone: { type: String, trim: true, default: '', maxlength: 30 },
  status: { type: String, enum: ['pending', 'paid', 'completed', 'rejected'], default: 'pending', index: true },
  adminNote: { type: String, trim: true, default: '', maxlength: 500 },
  processedBy: { type: String, default: '' },
  processedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

const ledgerSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: {
    type: String,
    enum: ['daily', 'referrer', 'referred', 'task', 'withdraw_hold', 'withdraw_refund', 'admin_adjust'],
    required: true,
    index: true,
  },
  amount: { type: Number, required: true },
  description: { type: String, trim: true, required: true },
  refId: { type: String, default: '' },
}, { timestamps: true, versionKey: false });

const User = mongoose.model('User', userSchema);
const RequiredChat = mongoose.model('RequiredChat', requiredChatSchema);
const AppSetting = mongoose.model('AppSetting', appSettingSchema);
const Broadcast = mongoose.model('Broadcast', broadcastSchema);
const Task = mongoose.model('Task', taskSchema);
const TaskClaim = mongoose.model('TaskClaim', taskClaimSchema);
const ShopItem = mongoose.model('ShopItem', shopItemSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const Purchase = mongoose.model('Purchase', purchaseSchema);
const Ledger = mongoose.model('Ledger', ledgerSchema);

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function normalizeHalf(value) {
  return Math.round(Number(value) * 2) / 2;
}

function safeText(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function makeReferralCode(telegramId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${telegramId}:${process.env.REFERRAL_SALT || CONFIG.botToken || 'uc-app'}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `UC${digest}`;
}

function parseTelegramInitData(initData) {
  if (!initData || !CONFIG.botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(CONFIG.botToken)
    .digest();
  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const hashA = Buffer.from(calculatedHash, 'hex');
  const hashB = Buffer.from(receivedHash, 'hex');
  if (hashA.length !== hashB.length || !crypto.timingSafeEqual(hashA, hashB)) return null;

  const authDate = Number(params.get('auth_date') || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || Math.abs(now - authDate) > CONFIG.authMaxAgeSeconds) return null;

  let telegramUser;
  try {
    telegramUser = JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
  if (!telegramUser?.id) return null;

  return {
    user: telegramUser,
    startParam: params.get('start_param') || '',
    queryId: params.get('query_id') || '',
  };
}

async function getOrCreateUser(telegramUser, startParam = '') {
  const telegramId = String(telegramUser.id);
  const referralCode = makeReferralCode(telegramId);

  let user = await User.findOneAndUpdate(
    { telegramId },
    {
      $set: {
        username: telegramUser.username || '',
        firstName: telegramUser.first_name || '',
        lastName: telegramUser.last_name || '',
        photoUrl: telegramUser.photo_url || '',
        languageCode: telegramUser.language_code || 'uz',
        lastSeenAt: new Date(),
      },
      $setOnInsert: { telegramId, referralCode },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const code = safeText(startParam, 80).replace(/^ref_/, '');
  if (code && !user.referredBy && code !== user.referralCode) {
    const referrer = await User.findOne({ referralCode: code, blocked: false });
    if (referrer && String(referrer._id) !== String(user._id)) {
      const claimed = await User.updateOne(
        { _id: user._id, referredBy: null },
        {
          $set: { referredBy: referrer.telegramId },
          $inc: { balance: CONFIG.referredBonus, totalEarned: CONFIG.referredBonus },
        }
      );

      if (claimed.modifiedCount === 1) {
        await Promise.all([
          User.updateOne(
            { _id: referrer._id },
            {
              $inc: {
                balance: CONFIG.referrerBonus,
                totalEarned: CONFIG.referrerBonus,
                referralCount: 1,
              },
            }
          ),
          Ledger.create([
            {
              userId: user._id,
              type: 'referred',
              amount: CONFIG.referredBonus,
              description: 'Referral orqali qo‘shilish bonusi',
              refId: String(referrer._id),
            },
            {
              userId: referrer._id,
              type: 'referrer',
              amount: CONFIG.referrerBonus,
              description: 'Yangi do‘st taklif qilish bonusi',
              refId: String(user._id),
            },
          ]),
        ]);
        user = await User.findById(user._id);
      }
    }
  }
  return user;
}

const auth = asyncHandler(async (req, res, next) => {
  let parsed = parseTelegramInitData(req.get('x-telegram-init-data'));

  if (!parsed && CONFIG.devMode) {
    const devId = String(req.get('x-dev-user-id') || CONFIG.devTelegramId);
    parsed = {
      user: {
        id: devId,
        first_name: req.get('x-dev-first-name') || 'Local Test',
        username: req.get('x-dev-username') || 'local_test',
        language_code: 'uz',
      },
      startParam: safeText(req.get('x-start-param'), 80),
    };
  }

  if (!parsed) return res.status(401).json({ error: 'Telegram autentifikatsiyasi tasdiqlanmadi.' });

  const user = await getOrCreateUser(parsed.user, parsed.startParam);
  if (user.blocked) return res.status(403).json({ error: 'Hisob administrator tomonidan bloklangan.' });

  req.telegram = parsed;
  req.userDoc = user;
  next();
});

function adminOnly(req, res, next) {
  if (!CONFIG.adminIds.has(String(req.userDoc.telegramId))) {
    return res.status(403).json({ error: 'Admin huquqi yo‘q.' });
  }
  next();
}

async function telegramApi(method, payload = {}) {
  if (!CONFIG.botToken) throw new Error('BOT_TOKEN sozlanmagan.');
  const response = await fetch(`https://api.telegram.org/bot${CONFIG.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || 'Telegram API xatosi.');
  return data.result;
}

async function isMember(chatId, telegramId) {
  const member = await telegramApi('getChatMember', {
    chat_id: chatId,
    user_id: Number(telegramId),
  });
  if (['creator', 'administrator', 'member'].includes(member.status)) return true;
  return member.status === 'restricted' && member.is_member === true;
}

function requiredChatPublic(chat, joined = false, checkError = '') {
  return {
    _id: chat._id,
    title: chat.title,
    type: chat.type,
    chatId: chat.chatId,
    inviteLink: chat.inviteLink,
    order: chat.order,
    joined,
    checkError,
  };
}

function requiredSignature(chats) {
  return crypto.createHash('sha256')
    .update(chats.map((c) => `${c._id}:${c.updatedAt?.getTime?.() || c.updatedAt}:${c.active}`).join('|'))
    .digest('hex');
}

async function checkMandatorySubscriptions(user, force = false) {
  const chats = await RequiredChat.find({ active: true }).sort({ order: 1, createdAt: 1 }).lean();
  if (CONFIG.adminIds.has(String(user.telegramId)) || chats.length === 0) {
    return { passed: true, subscriptions: chats.map((c) => requiredChatPublic(c, true)) };
  }

  const signature = requiredSignature(chats);
  const cacheValid = !force && user.mandatorySignature === signature && user.mandatoryVerifiedAt &&
    Date.now() - new Date(user.mandatoryVerifiedAt).getTime() < CONFIG.mandatoryCacheSeconds * 1000;
  if (cacheValid) return { passed: true, subscriptions: chats.map((c) => requiredChatPublic(c, true)) };

  const checked = await Promise.all(chats.map(async (chat) => {
    try {
      return requiredChatPublic(chat, await isMember(chat.chatId, user.telegramId));
    } catch (error) {
      return requiredChatPublic(chat, false, error.message);
    }
  }));
  const passed = checked.every((chat) => chat.joined);
  if (passed) {
    await User.updateOne({ _id: user._id }, {
      $set: { mandatoryVerifiedAt: new Date(), mandatorySignature: signature },
    });
    user.mandatoryVerifiedAt = new Date();
    user.mandatorySignature = signature;
  }
  return { passed, subscriptions: checked };
}

const requireMandatory = asyncHandler(async (req, res, next) => {
  const result = await checkMandatorySubscriptions(req.userDoc, false);
  if (!result.passed) {
    return res.status(428).json({
      error: 'Mini App’dan foydalanish uchun majburiy kanal va guruhlarga obuna bo‘ling.',
      code: 'SUBSCRIPTION_REQUIRED',
      ...result,
    });
  }
  next();
});

async function getMainSetting() {
  return AppSetting.findOneAndUpdate(
    { key: 'main' },
    { $setOnInsert: { key: 'main' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendBroadcastMessage(chatId, payload) {
  const replyMarkup = payload.buttonText && payload.buttonUrl
    ? { inline_keyboard: [[{ text: payload.buttonText, url: payload.buttonUrl }]] }
    : undefined;
  if (payload.imageUrl) {
    return telegramApi('sendPhoto', {
      chat_id: chatId,
      photo: payload.imageUrl,
      caption: payload.text.slice(0, 1024),
      reply_markup: replyMarkup,
    });
  }
  return telegramApi('sendMessage', {
    chat_id: chatId,
    text: payload.text.slice(0, 4000),
    disable_web_page_preview: false,
    reply_markup: replyMarkup,
  });
}

async function sendPurchasePaymentButton(user, purchase, item, link) {
  if (!link) return;
  const text = [
    '✅ UC Shop buyurtmangiz qabul qilindi.',
    `📦 ${item.title} — ${item.ucAmount} UC`,
    `💳 ${item.priceUZS.toLocaleString('uz-UZ')} so‘m`,
    `🎮 PUBG ID: ${purchase.pubgId}`,
    '',
    'To‘lov qilish uchun pastdagi tugma orqali @Qoryogdiyev ga yozing.',
  ].join('\n');
  await telegramApi('sendMessage', {
    chat_id: user.telegramId,
    text,
    reply_markup: {
      inline_keyboard: [[{ text: '💳 To‘lov uchun @Qoryogdiyev', url: link }]],
    },
  });
}

function publicUser(user) {
  return {
    id: user.telegramId,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    photoUrl: user.photoUrl,
    balance: normalizeHalf(user.balance),
    totalEarned: normalizeHalf(user.totalEarned),
    totalWithdrawn: normalizeHalf(user.totalWithdrawn),
    referralCode: user.referralCode,
    referralCount: user.referralCount,
    dailyBonusAt: user.dailyBonusAt,
    isAdmin: CONFIG.adminIds.has(String(user.telegramId)),
  };
}

function referralLink(code) {
  if (!CONFIG.botUsername) return '';
  const suffix = `startapp=ref_${encodeURIComponent(code)}`;
  if (CONFIG.miniAppShortName) {
    return `https://t.me/${CONFIG.botUsername}/${CONFIG.miniAppShortName}?${suffix}`;
  }
  return `https://t.me/${CONFIG.botUsername}?${suffix}`;
}

function adminChatLink(text) {
  if (!CONFIG.adminUsername) return '';
  return `https://t.me/${CONFIG.adminUsername}?text=${encodeURIComponent(text)}`;
}

app.get('/api/config', asyncHandler(async (_req, res) => {
  const setting = await getMainSetting();
  res.json({
    appName: process.env.APP_NAME || 'UC ARENA',
    botUsername: CONFIG.botUsername,
    adminUsername: CONFIG.adminUsername,
    adminDisplay: CONFIG.adminUsername ? `@${CONFIG.adminUsername}` : '',
    logoUrl: setting.logoUrl || '',
    dailyBonus: CONFIG.dailyBonus,
    referrerBonus: CONFIG.referrerBonus,
    referredBonus: CONFIG.referredBonus,
    taskBonus: CONFIG.taskBonus,
    minWithdraw: CONFIG.minWithdraw,
    devMode: CONFIG.devMode,
  });
}));

app.post('/api/auth', auth, asyncHandler(async (req, res) => {
  res.json({
    user: publicUser(req.userDoc),
    referralLink: referralLink(req.userDoc.referralCode),
  });
}));

app.get('/api/mandatory', auth, asyncHandler(async (req, res) => {
  res.json(await checkMandatorySubscriptions(req.userDoc, false));
}));

app.post('/api/mandatory/verify', auth, asyncHandler(async (req, res) => {
  const result = await checkMandatorySubscriptions(req.userDoc, true);
  res.status(result.passed ? 200 : 428).json({
    ...result,
    ...(result.passed ? { message: 'Majburiy obunalar tasdiqlandi.' } : {
      error: 'Barcha majburiy kanal va guruhlarga obuna bo‘ling.',
      code: 'SUBSCRIPTION_REQUIRED',
    }),
  });
}));

app.get('/api/me', auth, requireMandatory, asyncHandler(async (req, res) => {
  const [pendingWithdrawals, pendingPurchases] = await Promise.all([
    Withdrawal.countDocuments({ userId: req.userDoc._id, status: 'pending' }),
    Purchase.countDocuments({ userId: req.userDoc._id, status: { $in: ['pending', 'paid'] } }),
  ]);
  res.json({
    user: publicUser(req.userDoc),
    referralLink: referralLink(req.userDoc.referralCode),
    pendingWithdrawals,
    pendingPurchases,
  });
}));

app.post('/api/bonus/daily', auth, requireMandatory, asyncHandler(async (req, res) => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const updated = await User.findOneAndUpdate(
    {
      _id: req.userDoc._id,
      $or: [{ dailyBonusAt: null }, { dailyBonusAt: { $lte: cutoff } }],
    },
    {
      $set: { dailyBonusAt: new Date() },
      $inc: { balance: CONFIG.dailyBonus, totalEarned: CONFIG.dailyBonus },
    },
    { new: true }
  );

  if (!updated) {
    const current = await User.findById(req.userDoc._id);
    const nextAt = new Date(new Date(current.dailyBonusAt).getTime() + 24 * 60 * 60 * 1000);
    return res.status(409).json({ error: 'Kunlik bonus hali tayyor emas.', nextAt });
  }

  await Ledger.create({
    userId: updated._id,
    type: 'daily',
    amount: CONFIG.dailyBonus,
    description: 'Kunlik bonus',
  });

  res.json({ message: `+${CONFIG.dailyBonus} UC qo‘shildi.`, user: publicUser(updated) });
}));

app.get('/api/tasks', auth, requireMandatory, asyncHandler(async (req, res) => {
  const tasks = await Task.find({ active: true }).sort({ order: 1, createdAt: -1 }).lean();
  const claims = await TaskClaim.find({ userId: req.userDoc._id, taskId: { $in: tasks.map((t) => t._id) } })
    .select('taskId')
    .lean();
  const claimed = new Set(claims.map((c) => String(c.taskId)));
  res.json({
    tasks: tasks.map((task) => ({
      ...task,
      claimed: claimed.has(String(task._id)),
    })),
  });
}));

app.post('/api/tasks/:id/claim', auth, requireMandatory, asyncHandler(async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, active: true });
  if (!task) return res.status(404).json({ error: 'Vazifa topilmadi.' });

  const existing = await TaskClaim.exists({ userId: req.userDoc._id, taskId: task._id });
  if (existing) return res.status(409).json({ error: 'Bu vazifa bonusi avval olingan.' });

  let member = false;
  try {
    member = await isMember(task.chatId, req.userDoc.telegramId);
  } catch (error) {
    return res.status(502).json({
      error: `Obunani tekshirib bo‘lmadi: ${error.message}. Bot kanal/guruhda admin ekanini tekshiring.`,
    });
  }
  if (!member) return res.status(400).json({ error: 'Avval kanal yoki guruhga obuna bo‘ling.' });

  try {
    await TaskClaim.create({ userId: req.userDoc._id, taskId: task._id, reward: task.reward });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'Bonus avval olingan.' });
    throw error;
  }

  const user = await User.findByIdAndUpdate(
    req.userDoc._id,
    { $inc: { balance: task.reward, totalEarned: task.reward } },
    { new: true }
  );
  await Ledger.create({
    userId: user._id,
    type: 'task',
    amount: task.reward,
    description: `${task.title} obuna bonusi`,
    refId: String(task._id),
  });

  res.json({ message: `+${task.reward} UC qo‘shildi.`, user: publicUser(user) });
}));

app.get('/api/shop', auth, requireMandatory, asyncHandler(async (_req, res) => {
  const items = await ShopItem.find({ active: true }).sort({ order: 1, ucAmount: 1 }).lean();
  res.json({ items });
}));

app.post('/api/purchases', auth, requireMandatory, asyncHandler(async (req, res) => {
  const item = await ShopItem.findOne({ _id: req.body.itemId, active: true });
  if (!item) return res.status(404).json({ error: 'Mahsulot topilmadi.' });
  if (item.stock === 0) return res.status(409).json({ error: 'Mahsulot vaqtincha tugagan.' });

  const pubgId = safeText(req.body.pubgId, 40);
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(pubgId)) {
    return res.status(400).json({ error: 'PUBG ID noto‘g‘ri kiritildi.' });
  }

  const purchase = await Purchase.create({
    userId: req.userDoc._id,
    itemId: item._id,
    itemTitle: item.title,
    ucAmount: item.ucAmount,
    priceUZS: item.priceUZS,
    pubgId,
    pubgNickname: safeText(req.body.pubgNickname, 50),
    phone: safeText(req.body.phone, 30),
  });

  const orderText = [
    `UC Shop buyurtma #${String(purchase._id).slice(-8).toUpperCase()}`,
    `${item.title} — ${item.ucAmount} UC`,
    `Narx: ${item.priceUZS.toLocaleString('uz-UZ')} so‘m`,
    `PUBG ID: ${pubgId}`,
    `Telegram ID: ${req.userDoc.telegramId}`,
  ].join('\n');

  const paymentLink = adminChatLink(orderText);
  sendPurchasePaymentButton(req.userDoc, purchase, item, paymentLink).catch((error) => {
    console.error('Shop inline tugmasini yuborib bo‘lmadi:', error.message);
  });

  res.status(201).json({
    message: 'Buyurtma yaratildi. To‘lov uchun @Qoryogdiyev ga yozing.',
    purchase,
    adminChatLink: paymentLink,
    paymentButtonText: 'To‘lov uchun @Qoryogdiyev',
  });
}));

app.get('/api/purchases/my', auth, requireMandatory, asyncHandler(async (req, res) => {
  const purchases = await Purchase.find({ userId: req.userDoc._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json({ purchases });
}));

app.post('/api/withdrawals', auth, requireMandatory, asyncHandler(async (req, res) => {
  const amount = normalizeHalf(req.body.amount);
  const pubgId = safeText(req.body.pubgId, 40);
  const pubgNickname = safeText(req.body.pubgNickname, 50);

  if (!Number.isFinite(amount) || amount < CONFIG.minWithdraw) {
    return res.status(400).json({ error: `Minimum yechib olish ${CONFIG.minWithdraw} UC.` });
  }
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(pubgId)) {
    return res.status(400).json({ error: 'PUBG ID noto‘g‘ri kiritildi.' });
  }

  const user = await User.findOneAndUpdate(
    { _id: req.userDoc._id, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
    { new: true }
  );
  if (!user) return res.status(409).json({ error: 'Balans yetarli emas.' });

  try {
    const withdrawal = await Withdrawal.create({
      userId: user._id,
      amount,
      pubgId,
      pubgNickname,
    });
    await Ledger.create({
      userId: user._id,
      type: 'withdraw_hold',
      amount: -amount,
      description: 'UC yechib olish uchun rezerv qilindi',
      refId: String(withdrawal._id),
    });
    res.status(201).json({
      message: 'Yechib olish so‘rovi yuborildi.',
      withdrawal,
      user: publicUser(user),
    });
  } catch (error) {
    await User.updateOne({ _id: user._id }, { $inc: { balance: amount } });
    throw error;
  }
}));

app.get('/api/withdrawals/my', auth, requireMandatory, asyncHandler(async (req, res) => {
  const withdrawals = await Withdrawal.find({ userId: req.userDoc._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json({ withdrawals });
}));

app.get('/api/ledger', auth, requireMandatory, asyncHandler(async (req, res) => {
  const ledger = await Ledger.find({ userId: req.userDoc._id })
    .sort({ createdAt: -1 })
    .limit(80)
    .lean();
  res.json({ ledger });
}));

// -------------------- ADMIN API --------------------

app.get('/api/admin/stats', auth, adminOnly, asyncHandler(async (_req, res) => {
  const [users, activeUsers, balance, pendingWithdrawals, pendingPurchases, tasks, items, requiredChats, broadcasts] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ lastSeenAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
    User.aggregate([{ $group: { _id: null, value: { $sum: '$balance' } } }]),
    Withdrawal.countDocuments({ status: 'pending' }),
    Purchase.countDocuments({ status: { $in: ['pending', 'paid'] } }),
    Task.countDocuments({ active: true }),
    ShopItem.countDocuments({ active: true }),
    RequiredChat.countDocuments({ active: true }),
    Broadcast.countDocuments(),
  ]);
  res.json({
    users,
    activeUsers,
    totalBalance: normalizeHalf(balance[0]?.value || 0),
    pendingWithdrawals,
    pendingPurchases,
    tasks,
    items,
    requiredChats,
    broadcasts,
  });
}));

app.get('/api/admin/users', auth, adminOnly, asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(10, Number(req.query.limit || 30)));
  const q = safeText(req.query.q, 80);
  const filter = q ? {
    $or: [
      { telegramId: q },
      { username: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
      { firstName: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
    ],
  } : {};
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  res.json({ users, total, page, pages: Math.ceil(total / limit) });
}));

app.patch('/api/admin/users/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const update = {};
  if (typeof req.body.blocked === 'boolean') update.blocked = req.body.blocked;
  const user = await User.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
  if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi.' });
  res.json({ user });
}));

app.post('/api/admin/users/:id/adjust', auth, adminOnly, asyncHandler(async (req, res) => {
  const amount = normalizeHalf(req.body.amount);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) {
    return res.status(400).json({ error: 'Miqdor noto‘g‘ri.' });
  }
  const filter = amount < 0
    ? { _id: req.params.id, balance: { $gte: Math.abs(amount) } }
    : { _id: req.params.id };
  const update = { $inc: { balance: amount } };
  if (amount > 0) update.$inc.totalEarned = amount;
  const user = await User.findOneAndUpdate(filter, update, { new: true });
  if (!user) return res.status(409).json({ error: 'Balans yetarli emas yoki foydalanuvchi topilmadi.' });
  await Ledger.create({
    userId: user._id,
    type: 'admin_adjust',
    amount,
    description: safeText(req.body.note, 200) || 'Admin balans tuzatishi',
    refId: req.userDoc.telegramId,
  });
  res.json({ user });
}));

app.get('/api/admin/required-chats', auth, adminOnly, asyncHandler(async (_req, res) => {
  const chats = await RequiredChat.find().sort({ order: 1, createdAt: -1 }).lean();
  res.json({ chats });
}));

app.post('/api/admin/required-chats', auth, adminOnly, asyncHandler(async (req, res) => {
  const chat = await RequiredChat.create({
    title: safeText(req.body.title, 80),
    type: req.body.type === 'group' ? 'group' : 'channel',
    chatId: safeText(req.body.chatId, 80),
    inviteLink: safeText(req.body.inviteLink, 300),
    active: req.body.active !== false,
    order: Number(req.body.order || 0),
  });
  res.status(201).json({ chat });
}));

app.patch('/api/admin/required-chats/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const update = {};
  for (const key of ['title', 'type', 'chatId', 'inviteLink', 'active', 'order']) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  if (update.title !== undefined) update.title = safeText(update.title, 80);
  if (update.chatId !== undefined) update.chatId = safeText(update.chatId, 80);
  if (update.inviteLink !== undefined) update.inviteLink = safeText(update.inviteLink, 300);
  const chat = await RequiredChat.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
  if (!chat) return res.status(404).json({ error: 'Majburiy obuna topilmadi.' });
  res.json({ chat });
}));

app.delete('/api/admin/required-chats/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const chat = await RequiredChat.findByIdAndDelete(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Majburiy obuna topilmadi.' });
  res.json({ message: 'Majburiy obuna o‘chirildi.' });
}));

app.get('/api/admin/branding', auth, adminOnly, asyncHandler(async (_req, res) => {
  const setting = await getMainSetting();
  res.json({ setting });
}));

app.post('/api/admin/branding/logo', auth, adminOnly, upload.single('logo'), asyncHandler(async (req, res) => {
  const current = await getMainSetting();
  let logoUrl = safeText(req.body.logoUrl, 500);
  let logoPublicId = '';
  if (req.file) {
    const uploaded = await uploadToCloudinary(req.file.buffer, {
      folder: `${process.env.CLOUDINARY_FOLDER || 'uc-shop'}/branding`,
      transformation: [{ width: 512, height: 512, crop: 'fill', gravity: 'auto', quality: 'auto', fetch_format: 'auto' }],
    });
    logoUrl = uploaded.secure_url;
    logoPublicId = uploaded.public_id;
  }
  if (!logoUrl) return res.status(400).json({ error: 'Logo rasmi yoki URL kiriting.' });
  const setting = await AppSetting.findOneAndUpdate(
    { key: 'main' },
    { $set: { logoUrl, logoPublicId } },
    { upsert: true, new: true, runValidators: true }
  );
  if (current.logoPublicId && current.logoPublicId !== logoPublicId && cloudinaryEnabled) {
    cloudinary.uploader.destroy(current.logoPublicId).catch(() => {});
  }
  res.json({ setting, message: 'Mini App logosi yangilandi.' });
}));

app.delete('/api/admin/branding/logo', auth, adminOnly, asyncHandler(async (_req, res) => {
  const current = await getMainSetting();
  await AppSetting.updateOne({ key: 'main' }, { $set: { logoUrl: '', logoPublicId: '' } });
  if (current.logoPublicId && cloudinaryEnabled) cloudinary.uploader.destroy(current.logoPublicId).catch(() => {});
  res.json({ message: 'Mini App logosi olib tashlandi.' });
}));

app.get('/api/admin/broadcasts', auth, adminOnly, asyncHandler(async (_req, res) => {
  const broadcasts = await Broadcast.find().sort({ createdAt: -1 }).limit(30).lean();
  res.json({ broadcasts });
}));

app.post('/api/admin/broadcasts', auth, adminOnly, upload.single('image'), asyncHandler(async (req, res) => {
  const text = safeText(req.body.text, 4000);
  const buttonText = safeText(req.body.buttonText, 64);
  const buttonUrl = safeText(req.body.buttonUrl, 500);
  if (!text) return res.status(400).json({ error: 'E’lon matnini kiriting.' });
  if ((buttonText && !buttonUrl) || (!buttonText && buttonUrl)) {
    return res.status(400).json({ error: 'Inline tugma nomi va havolasini birga kiriting.' });
  }
  if (buttonUrl && !/^https?:\/\//i.test(buttonUrl) && !/^tg:\/\//i.test(buttonUrl)) {
    return res.status(400).json({ error: 'Tugma havolasi http(s):// yoki tg:// bilan boshlanishi kerak.' });
  }

  let imageUrl = safeText(req.body.imageUrl, 500);
  let imagePublicId = '';
  if (req.file) {
    const uploaded = await uploadToCloudinary(req.file.buffer, {
      folder: `${process.env.CLOUDINARY_FOLDER || 'uc-shop'}/broadcasts`,
      transformation: [{ width: 1280, height: 1280, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
    });
    imageUrl = uploaded.secure_url;
    imagePublicId = uploaded.public_id;
  }

  const users = await User.find({ blocked: false }).select('telegramId').lean();
  let sent = 0;
  let failed = 0;
  const payload = { text, imageUrl, buttonText, buttonUrl };
  for (let index = 0; index < users.length; index += 25) {
    const batch = users.slice(index, index + 25);
    const results = await Promise.allSettled(batch.map((user) => sendBroadcastMessage(user.telegramId, payload)));
    sent += results.filter((result) => result.status === 'fulfilled').length;
    failed += results.filter((result) => result.status === 'rejected').length;
    if (index + 25 < users.length) await sleep(1000);
  }

  const broadcast = await Broadcast.create({
    text, imageUrl, imagePublicId, buttonText, buttonUrl, sent, failed,
    createdBy: req.userDoc.telegramId,
  });
  res.status(201).json({
    broadcast,
    message: `E’lon yuborildi: ${sent} ta muvaffaqiyatli, ${failed} ta xatolik.`,
  });
}));

app.get('/api/admin/tasks', auth, adminOnly, asyncHandler(async (_req, res) => {
  const tasks = await Task.find().sort({ order: 1, createdAt: -1 }).lean();
  res.json({ tasks });
}));

app.post('/api/admin/tasks', auth, adminOnly, asyncHandler(async (req, res) => {
  const task = await Task.create({
    title: safeText(req.body.title, 80),
    type: req.body.type === 'group' ? 'group' : 'channel',
    chatId: safeText(req.body.chatId, 80),
    username: safeText(req.body.username, 80).replace(/^@/, ''),
    inviteLink: safeText(req.body.inviteLink, 300),
    reward: Math.max(0.5, normalizeHalf(req.body.reward || CONFIG.taskBonus)),
    active: req.body.active !== false,
    order: Number(req.body.order || 0),
  });
  res.status(201).json({ task });
}));

app.patch('/api/admin/tasks/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const allowed = ['title', 'type', 'chatId', 'username', 'inviteLink', 'reward', 'active', 'order'];
  const update = {};
  for (const key of allowed) if (req.body[key] !== undefined) update[key] = req.body[key];
  if (update.reward !== undefined) update.reward = Math.max(0.5, normalizeHalf(update.reward));
  if (update.username !== undefined) update.username = safeText(update.username, 80).replace(/^@/, '');
  const task = await Task.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
  if (!task) return res.status(404).json({ error: 'Vazifa topilmadi.' });
  res.json({ task });
}));

app.delete('/api/admin/tasks/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const task = await Task.findByIdAndDelete(req.params.id);
  if (!task) return res.status(404).json({ error: 'Vazifa topilmadi.' });
  await TaskClaim.deleteMany({ taskId: task._id });
  res.json({ message: 'Vazifa o‘chirildi.' });
}));

function uploadToCloudinary(buffer, options = {}) {
  if (!cloudinaryEnabled) throw new Error('Cloudinary sozlanmagan.');
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || process.env.CLOUDINARY_FOLDER || 'uc-shop',
        resource_type: 'image',
        transformation: options.transformation || [{ width: 1000, height: 700, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
      },
      (error, result) => error ? reject(error) : resolve(result)
    );
    stream.end(buffer);
  });
}

app.get('/api/admin/shop', auth, adminOnly, asyncHandler(async (_req, res) => {
  const items = await ShopItem.find().sort({ order: 1, createdAt: -1 }).lean();
  res.json({ items });
}));

app.post('/api/admin/shop', auth, adminOnly, upload.single('image'), asyncHandler(async (req, res) => {
  let imageUrl = safeText(req.body.imageUrl, 500);
  let imagePublicId = '';
  if (req.file) {
    const uploaded = await uploadToCloudinary(req.file.buffer);
    imageUrl = uploaded.secure_url;
    imagePublicId = uploaded.public_id;
  }
  const item = await ShopItem.create({
    title: safeText(req.body.title, 100),
    description: safeText(req.body.description, 700),
    ucAmount: Number(req.body.ucAmount),
    priceUZS: Number(req.body.priceUZS),
    imageUrl,
    imagePublicId,
    stock: Number(req.body.stock ?? -1),
    active: String(req.body.active ?? 'true') !== 'false',
    order: Number(req.body.order || 0),
  });
  res.status(201).json({ item });
}));

app.patch('/api/admin/shop/:id', auth, adminOnly, upload.single('image'), asyncHandler(async (req, res) => {
  const item = await ShopItem.findById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Mahsulot topilmadi.' });

  const update = {};
  for (const key of ['title', 'description', 'ucAmount', 'priceUZS', 'imageUrl', 'stock', 'active', 'order']) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  if (update.active !== undefined) update.active = String(update.active) !== 'false';
  if (req.file) {
    const uploaded = await uploadToCloudinary(req.file.buffer);
    update.imageUrl = uploaded.secure_url;
    update.imagePublicId = uploaded.public_id;
    if (item.imagePublicId && cloudinaryEnabled) {
      cloudinary.uploader.destroy(item.imagePublicId).catch(() => {});
    }
  }
  const updated = await ShopItem.findByIdAndUpdate(item._id, { $set: update }, { new: true, runValidators: true });
  res.json({ item: updated });
}));

app.delete('/api/admin/shop/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const item = await ShopItem.findByIdAndDelete(req.params.id);
  if (!item) return res.status(404).json({ error: 'Mahsulot topilmadi.' });
  if (item.imagePublicId && cloudinaryEnabled) cloudinary.uploader.destroy(item.imagePublicId).catch(() => {});
  res.json({ message: 'Mahsulot o‘chirildi.' });
}));

app.get('/api/admin/withdrawals', auth, adminOnly, asyncHandler(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const filter = status ? { status } : {};
  const withdrawals = await Withdrawal.find(filter)
    .populate('userId', 'telegramId username firstName balance')
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  res.json({ withdrawals });
}));

app.patch('/api/admin/withdrawals/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const status = req.body.status;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Status noto‘g‘ri.' });

  const withdrawal = await Withdrawal.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    {
      $set: {
        status,
        adminNote: safeText(req.body.adminNote, 500),
        processedBy: req.userDoc.telegramId,
        processedAt: new Date(),
      },
    },
    { new: true }
  );
  if (!withdrawal) return res.status(409).json({ error: 'So‘rov topilmadi yoki allaqachon yakunlangan.' });

  if (status === 'approved') {
    await User.updateOne({ _id: withdrawal.userId }, { $inc: { totalWithdrawn: withdrawal.amount } });
  } else {
    await Promise.all([
      User.updateOne({ _id: withdrawal.userId }, { $inc: { balance: withdrawal.amount } }),
      Ledger.create({
        userId: withdrawal.userId,
        type: 'withdraw_refund',
        amount: withdrawal.amount,
        description: 'Rad etilgan yechib olish so‘rovi qaytarildi',
        refId: String(withdrawal._id),
      }),
    ]);
  }
  res.json({ withdrawal });
}));

app.get('/api/admin/purchases', auth, adminOnly, asyncHandler(async (req, res) => {
  const allowed = ['pending', 'paid', 'completed', 'rejected'];
  const filter = allowed.includes(req.query.status) ? { status: req.query.status } : {};
  const purchases = await Purchase.find(filter)
    .populate('userId', 'telegramId username firstName')
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  res.json({ purchases });
}));

app.patch('/api/admin/purchases/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const status = req.body.status;
  if (!['pending', 'paid', 'completed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status noto‘g‘ri.' });
  }
  const purchase = await Purchase.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        status,
        adminNote: safeText(req.body.adminNote, 500),
        processedBy: req.userDoc.telegramId,
        processedAt: new Date(),
      },
    },
    { new: true, runValidators: true }
  );
  if (!purchase) return res.status(404).json({ error: 'Buyurtma topilmadi.' });
  res.json({ purchase });
}));

app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Manzil topilmadi.' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Rasm 8 MB dan katta.' : error.message });
  }
  if (error?.name === 'ValidationError') {
    return res.status(400).json({ error: Object.values(error.errors).map((e) => e.message).join(', ') });
  }
  if (error?.code === 11000) return res.status(409).json({ error: 'Bu ma’lumot avval mavjud.' });
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Server xatosi.' : error.message });
});

let httpServer = null;
let shuttingDown = false;

async function start() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI environment variable ko‘rsatilmagan.');
  if (!CONFIG.botToken && !CONFIG.devMode) throw new Error('BOT_TOKEN environment variable ko‘rsatilmagan.');

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    socketTimeoutMS: 45000,
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
  });

  httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`UC Mini App ${PORT}-portda ishga tushdi.`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    if (CONFIG.devMode) console.warn('DEV_MODE yoqilgan — production uchun false qiling.');
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} olindi. Server xavfsiz yopilmoqda...`);

  const forceExitTimer = setTimeout(() => {
    console.error('Server majburan yopildi.');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  try {
    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    }
    await mongoose.connection.close(false);
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    console.error('Serverni yopishda xatolik:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  shutdown('uncaughtException');
});

start().catch((error) => {
  console.error('Server ishga tushmadi:', error);
  process.exit(1);
});
