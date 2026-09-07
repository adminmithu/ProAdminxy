require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Telegraf, Markup, Telegram } = require('telegraf');
const db = require('./db');

// Robust Markdown-to-HTML converter for premium rendering in Telegram
function mdToHtml(md) {
    if (!md) return '';
    let str = md.toString();

    // 1. Escape HTML special characters
    str = str.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;');

    // 2. Stash code blocks (`...`) to prevent formatting inside them
    const codeBlocks = [];
    str = str.replace(/`(.*?)`/g, (match, code) => {
        const placeholder = `TEMPCODEBLOCK${codeBlocks.length}`;
        codeBlocks.push(code);
        return placeholder;
    });

    // 3. Parse blockquotes (lines starting with &gt;)
    let lines = str.split('\n');
    let inBlockquote = false;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let trimmed = line.trim();
        if (trimmed.startsWith('&gt;')) {
            let content = trimmed.substring(4);
            if (content.startsWith(' ')) {
                content = content.substring(1);
            }
            if (!inBlockquote) {
                lines[i] = '<blockquote>' + content;
                inBlockquote = true;
            } else {
                lines[i] = content;
            }
        } else {
            if (inBlockquote) {
                lines[i - 1] = lines[i - 1] + '</blockquote>';
                inBlockquote = false;
            }
        }
    }
    if (inBlockquote) {
        lines[lines.length - 1] = lines[lines.length - 1] + '</blockquote>';
    }
    str = lines.join('\n');

    // 4. Bold: **text** and *text*
    str = str.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    str = str.replace(/\*(.*?)\*/g, '<b>$1</b>');

    // 5. Italic: __text__ and _text_
    str = str.replace(/__(.*?)__/g, '<i>$1</i>');
    str = str.replace(/_(.*?)_/g, '<i>$1</i>');

    // 6. Links: [text](url)
    str = str.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');

    // 7. Restore code blocks wrapped in <code>
    codeBlocks.forEach((code, index) => {
        str = str.replace(`TEMPCODEBLOCK${index}`, `<code>${code}</code>`);
    });

    // 8. Restore Telegram Premium Custom Emoji tags (<tg-emoji>)
    str = str.replace(/&lt;tg-emoji emoji-id=&quot;(.*?)&quot;&gt;(.*?)&lt;\/tg-emoji&gt;/gi, '<tg-emoji emoji-id="$1">$2</tg-emoji>');
    str = str.replace(/&lt;tg-emoji emoji-id="(.*?)"&gt;(.*?)&lt;\/tg-emoji&gt;/gi, '<tg-emoji emoji-id="$1">$2</tg-emoji>');
    str = str.replace(/&lt;tg-emoji emoji-id='(.*?)'&gt;(.*?)&lt;\/tg-emoji&gt;/gi, '<tg-emoji emoji-id="$1">$2</tg-emoji>');

    return str;
}

// Hook into Telegraf Telegram methods to apply custom mdToHtml translation
const originalSendMessage = Telegram.prototype.sendMessage;
Telegram.prototype.sendMessage = function (chatId, text, extra) {
    const cleanExtra = extra ? { ...extra } : {};
    let processedText = text;
    if (!cleanExtra.parse_mode || cleanExtra.parse_mode === 'Markdown' || cleanExtra.parse_mode === 'MarkdownV2') {
        if (typeof text === 'string') {
            processedText = mdToHtml(text);
            cleanExtra.parse_mode = 'HTML';
        }
    }
    return originalSendMessage.call(this, chatId, processedText, cleanExtra);
};

const originalEditMessageText = Telegram.prototype.editMessageText;
Telegram.prototype.editMessageText = function (chatId, messageId, inlineMessageId, text, extra) {
    const cleanExtra = extra ? { ...extra } : {};
    let processedText = text;
    if (!cleanExtra.parse_mode || cleanExtra.parse_mode === 'Markdown' || cleanExtra.parse_mode === 'MarkdownV2') {
        if (typeof text === 'string') {
            processedText = mdToHtml(text);
            cleanExtra.parse_mode = 'HTML';
        }
    }
    return originalEditMessageText.call(this, chatId, messageId, inlineMessageId, processedText, cleanExtra);
};

const originalSendPhoto = Telegram.prototype.sendPhoto;
Telegram.prototype.sendPhoto = function (chatId, photo, extra) {
    const cleanExtra = extra ? { ...extra } : {};
    if (cleanExtra.caption && (!cleanExtra.parse_mode || cleanExtra.parse_mode === 'Markdown' || cleanExtra.parse_mode === 'MarkdownV2')) {
        cleanExtra.caption = mdToHtml(cleanExtra.caption);
        cleanExtra.parse_mode = 'HTML';
    }
    return originalSendPhoto.call(this, chatId, photo, cleanExtra);
};

const originalSendDocument = Telegram.prototype.sendDocument;
Telegram.prototype.sendDocument = function (chatId, doc, extra) {
    const cleanExtra = extra ? { ...extra } : {};
    if (cleanExtra.caption && (!cleanExtra.parse_mode || cleanExtra.parse_mode === 'Markdown' || cleanExtra.parse_mode === 'MarkdownV2')) {
        cleanExtra.caption = mdToHtml(cleanExtra.caption);
        cleanExtra.parse_mode = 'HTML';
    }
    return originalSendDocument.call(this, chatId, doc, cleanExtra);
};

const originalSendVideo = Telegram.prototype.sendVideo;
Telegram.prototype.sendVideo = function (chatId, video, extra) {
    const cleanExtra = extra ? { ...extra } : {};
    if (cleanExtra.caption && (!cleanExtra.parse_mode || cleanExtra.parse_mode === 'Markdown' || cleanExtra.parse_mode === 'MarkdownV2')) {
        cleanExtra.caption = mdToHtml(cleanExtra.caption);
        cleanExtra.parse_mode = 'HTML';
    }
    return originalSendVideo.call(this, chatId, video, cleanExtra);
};

const BOT_TOKEN = (process.env.BOT_TOKEN && process.env.BOT_TOKEN.trim().length > 10 && !process.env.BOT_TOKEN.includes('YOUR_BOT_TOKEN'))
    ? process.env.BOT_TOKEN.trim() 
    : '123456789:AAXXXXXXXXXXXXXX_XXXX';
const ADMIN_ID = (process.env.ADMIN_ID || '8929349073').toString();
const GROUP_ID = process.env.GROUP_ID || '-1004424672543';
const CHANNEL_ID = process.env.CHANNEL_ID || '-1004478024761';

const bot = new Telegraf(BOT_TOKEN);

// In-memory fallback for maintenance mode (just in case)
let memoryMaintenanceMode = false;
let memoryFakeSalesEnabled = true; // in-memory fallback for fake sales loop
let memoryForceJoinEnabled = true;
let memoryReferRewardAmount = 3;
let memorySellingHoursEnabled = true;

async function getForceJoinStatus() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_FORCE_JOIN_ENABLED');
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return true; // default enabled
    }
    return memoryForceJoinEnabled;
}

async function setForceJoinStatus(enabled) {
    const val = enabled ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_FORCE_JOIN_ENABLED', val);
    } else {
        memoryForceJoinEnabled = enabled;
    }
}

async function getReferRewardAmount() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_REFER_REWARD_AMOUNT');
        if (coupon) {
            return coupon.discount_amount;
        }
        return 3; // default 3 TK
    }
    return memoryReferRewardAmount;
}

async function setReferRewardAmount(amount) {
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_REFER_REWARD_AMOUNT', amount);
    } else {
        memoryReferRewardAmount = amount;
    }
}

async function getSellingHoursStatus() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_SELLING_HOURS_ENABLED');
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return true; // default enabled (has 11am-11pm limits)
    }
    return memorySellingHoursEnabled;
}

async function setSellingHoursStatus(enabled) {
    const val = enabled ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_SELLING_HOURS_ENABLED', val);
    } else {
        memorySellingHoursEnabled = enabled;
    }
}

const memoryStock = {};

async function getPackageStockStatus(pkgKey) {
    const dbKey = `STOCK_${pkgKey.toUpperCase()}`;
    let manualEnabled = true;
    if (db.isConfigured()) {
        const coupon = await db.getCoupon(dbKey);
        if (coupon) {
            manualEnabled = coupon.discount_amount === 1;
        }
    } else if (memoryStock[pkgKey] !== undefined) {
        manualEnabled = memoryStock[pkgKey];
    }
    if (!manualEnabled) return false;

    // Check stock pool inventory
    const stockItems = await db.getAllStockAccounts(pkgKey);
    const available = stockItems.filter(i => i.available);
    if (stockItems.length > 0) {
        if (pkgKey === 'pkg_3') {
            return available.length >= 10;
        }
        return available.length > 0;
    }

    return true; // default in stock
}

async function setPackageStockStatus(pkgKey, inStock) {
    const dbKey = `STOCK_${pkgKey.toUpperCase()}`;
    const val = inStock ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon(dbKey, val);
    } else {
        memoryStock[pkgKey] = inStock;
    }
}

async function getFakeSalesStatus() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_FAKE_SALES_ENABLED');
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return true; // default enabled
    }
    return memoryFakeSalesEnabled;
}

async function setFakeSalesStatus(enabled) {
    const val = enabled ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_FAKE_SALES_ENABLED', val);
    } else {
        memoryFakeSalesEnabled = enabled;
    }
}

async function getMaintenanceMode() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_MAINTENANCE_MODE');
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return false;
    }
    return memoryMaintenanceMode;
}

async function setMaintenanceMode(enabled) {
    const val = enabled ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_MAINTENANCE_MODE', val);
    } else {
        memoryMaintenanceMode = enabled;
    }
}

// In-memory fallback for notice mode
let memoryNoticeEnabled = false;
let memoryNoticeText = "Welcome to OWL PROXY BOT!";

async function getNoticeStatus() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_NOTICE_ENABLED');
        if (coupon) {
            return coupon.discount_amount === 1;
        }
        return false;
    }
    return memoryNoticeEnabled;
}

async function setNoticeStatus(enabled) {
    const val = enabled ? 1 : 0;
    if (db.isConfigured()) {
        await db.createCoupon('SYSTEM_NOTICE_ENABLED', val);
    } else {
        memoryNoticeEnabled = enabled;
    }
}

async function getNoticeText() {
    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            const noticeCoupon = coupons.find(cp => cp.code.startsWith('NOTICE_TEXT|'));
            if (noticeCoupon) {
                return noticeCoupon.code.split('NOTICE_TEXT|')[1];
            }
        }
    }
    return memoryNoticeText;
}

async function setNoticeText(text) {
    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            const oldNotices = coupons.filter(cp => cp.code.startsWith('NOTICE_TEXT|'));
            for (const old of oldNotices) {
                await db.deleteCoupon(old.code);
            }
        }
        await db.createCoupon('NOTICE_TEXT|' + text, 0);
    } else {
        memoryNoticeText = text;
    }
}

async function checkAndSendNotice(ctx) {
    const isNoticeEnabled = await getNoticeStatus();
    if (isNoticeEnabled) {
        const noticeText = await getNoticeText();
        const formattedNotice = `🔔 *SPECIAL ANNOUNCEMENT / ঘোষণা* 🔔\n` +
                                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
                                `${noticeText}\n` +
                                `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;
        await ctx.reply(formattedNotice, { parse_mode: 'Markdown' });
    }
}

// Dynamic wallet values (Bkash/Nagad/Binance/Payoneer) with High-Speed In-Memory Cache
let memoryWallets = {
    bkash: '01864339154',
    nagad: '01864339154',
    binance: '955102483',
    payoneer: 'mithuchandra647@gmail.com'
};

let walletCache = {};
let walletCacheTime = 0;

async function getWallet(type) {
    const key = type.toUpperCase();
    const now = Date.now();
    
    // Instant rocket-speed in-memory cache return (< 15s TTL)
    if (walletCache[key] !== undefined && (now - walletCacheTime < 15000)) {
        return walletCache[key];
    }

    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            const walletPrefix = `WALLET_${key}|`;
            const coupon = coupons.find(cp => cp.code.startsWith(walletPrefix));
            if (coupon) {
                const val = coupon.code.split(walletPrefix)[1];
                walletCache[key] = val;
                walletCacheTime = now;
                return val;
            }
        }
    }
    const fallbackVal = memoryWallets[type];
    if (fallbackVal !== undefined) {
        walletCache[key] = fallbackVal;
    }
    return fallbackVal;
}

async function setWallet(type, value) {
    const key = type.toUpperCase();
    walletCache[key] = value;
    walletCacheTime = Date.now();
    memoryWallets[type] = value;

    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            const walletPrefix = `WALLET_${key}|`;
            const oldWallets = coupons.filter(cp => cp.code.startsWith(walletPrefix));
            for (const old of oldWallets) {
                await db.deleteCoupon(old.code);
            }
        }
        await db.createCoupon(`WALLET_${key}|` + value, 0);
    }
}

async function getCustomText(key, defaultVal) {
    const val = await getWallet(`TEXT_${key.toUpperCase()}`);
    return (val && !['01864339154', '955102483', 'mithuchandra647@gmail.com'].includes(val)) ? val : defaultVal;
}

async function setCustomText(key, value) {
    await setWallet(`TEXT_${key.toUpperCase()}`, value);
}

async function getItemEmojiTag(itemKey, defaultFallback = '⭐') {
    const emojiId = await getCustomText(`EMOJIID_${itemKey}`, '');
    if (emojiId && emojiId.trim().length > 0 && !emojiId.includes('সরি') && !emojiId.includes('ডিফল্ট')) {
        const trimmed = emojiId.trim();
        // If it's a numeric Telegram Premium Custom Emoji ID
        if (/^\d{6,}$/.test(trimmed)) {
            return `<tg-emoji emoji-id="${trimmed}">${defaultFallback}</tg-emoji>`;
        }
        // If it's a direct Unicode emoji (e.g. 👔, 👑, 💎, ⚡, 🚀)
        return trimmed;
    }
    // High-quality default Telegram Premium custom emoji tags for Resellers and VIP badges
    if (itemKey === 'RESELLER' || itemKey === 'RESELLER_BADGE') {
        return `<tg-emoji emoji-id="5429188092403752187">${defaultFallback}</tg-emoji>`;
    }
    if (itemKey === 'VIP_STAR') {
        return `<tg-emoji emoji-id="5427009714745618600">${defaultFallback}</tg-emoji>`;
    }
    if (itemKey === 'VIP_CROWN') {
        return `<tg-emoji emoji-id="5427009714745618600">${defaultFallback}</tg-emoji>`;
    }
    if (itemKey === 'VIP_ZAP') {
        return `<tg-emoji emoji-id="5427009714745618600">${defaultFallback}</tg-emoji>`;
    }
    if (itemKey === 'BUY_NOW') {
        return `<tg-emoji emoji-id="5427009714745618600">${defaultFallback}</tg-emoji>`;
    }
    return defaultFallback;
}

// Referral Systems Config & Helpers
let memoryReferrals = {};
let memoryRewardedReferrals = {}; // in-memory history of successful referrals

async function checkIfUserIsNew(userId) {
    if (db.isConfigured()) {
        const users = await db.getAllUsers();
        if (users) {
            return !users.some(u => String(u.user_id) === userId);
        }
    }
    return !memoryAllStartedUsers.has(userId);
}

async function saveReferral(newUserId, referrerId) {
    if (db.isConfigured()) {
        await db.createCoupon(`REFERRAL|${newUserId}|${referrerId}`, 0);
    } else {
        memoryReferrals[newUserId] = referrerId;
    }
}

async function checkAndRewardReferral(newUserId, ctx) {
    try {
        let referrerId = null;
        if (db.isConfigured()) {
            const coupons = await db.getAllCoupons();
            if (coupons) {
                const refCoupon = coupons.find(cp => cp.code.startsWith(`REFERRAL|${newUserId}|`));
                if (refCoupon) {
                    referrerId = refCoupon.code.split('|')[2];
                    await db.deleteCoupon(refCoupon.code);
                }
            }
        } else {
            referrerId = memoryReferrals[newUserId];
            delete memoryReferrals[newUserId];
        }

        if (referrerId) {
            const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
            const rewardCouponCode = `REF_${randomSuffix}`;
            const rewardAmount = await getReferRewardAmount();

            if (db.isConfigured()) {
                await db.createCoupon(rewardCouponCode, rewardAmount);
                await db.createCoupon(`REWARDED_REF|${referrerId}|${newUserId}|${Date.now()}`, 0);
            } else {
                memoryCoupons[rewardCouponCode] = rewardAmount;
                if (!memoryRewardedReferrals[referrerId]) {
                    memoryRewardedReferrals[referrerId] = [];
                }
                memoryRewardedReferrals[referrerId].push(newUserId);
            }

            try {
                await ctx.telegram.sendMessage(
                    referrerId,
                    `🎉 *Referral Reward!* 💎\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `আপনার রেফারেল লিংক ব্যবহার করে একজন কাস্টমার প্রথম কেনাকাটা সম্পন্ন করেছেন!\n\n` +
                    `উপহার হিসেবে আপনি একটি কুপন পেয়েছেন:\n` +
                    `🎟️ Coupon: \`${rewardCouponCode}\` (-${rewardAmount} TK)\n\n` +
                    `🛒 আপনার পরবর্তী কেনাকাটায় এটি ব্যবহার করতে পারবেন!`,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) {
                console.error(`Failed to send referral reward message to ${referrerId}:`, err.message);
            }
        }
    } catch (e) {
        console.error("Error rewarding referral:", e.message);
    }
}

async function getReferralLeaderboard() {
    let list = [];
    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            const counts = {};
            coupons.forEach(cp => {
                if (cp.code.startsWith('REWARDED_REF|')) {
                    const parts = cp.code.split('|');
                    const referrerId = parts[1];
                    counts[referrerId] = (counts[referrerId] || 0) + 1;
                }
            });
            list = Object.keys(counts).map(referrerId => ({
                referrerId,
                count: counts[referrerId]
            }));
        }
    } else {
        list = Object.keys(memoryRewardedReferrals).map(referrerId => ({
            referrerId,
            count: memoryRewardedReferrals[referrerId].length
        }));
    }

    list.sort((a, b) => b.count - a.count);
    return list.slice(0, 10);
}

async function getLeaderboardText() {
    const leaderboard = await getReferralLeaderboard();
    let text = `🏆 *Referral Leaderboard / রেফারে চ্যাম্পিয়ন* 🏆\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `সবচেয়ে বেশি সফল রেফার করা টপ রেফারারদের তালিকা:\n\n`;

    if (leaderboard.length === 0) {
        text += `> ❌ বর্তমানে কোনো সফল রেফারেলের তথ্য নেই। রেফারেল শুরু করতে আপনার লিংক শেয়ার করুন!`;
        return text;
    }

    let users = [];
    if (db.isConfigured()) {
        users = await db.getAllUsers();
    }

    leaderboard.forEach((item, index) => {
        const user = users ? users.find(u => String(u.user_id) === item.referrerId) : null;
        const displayName = user ? (user.first_name || 'User') : `User ID: ${item.referrerId}`;
        const username = user && user.username ? ` (@${user.username})` : '';

        let medal = "👤";
        if (index === 0) medal = "🥇";
        else if (index === 1) medal = "🥈";
        else if (index === 2) medal = "🥉";

        text += `${medal} *#${index + 1}* - ${displayName}${username}\n` +
                `   └─ Successful Refers: *${item.count}* \n\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━\n` +
            `🎁 প্রতি সফল রেফারে ৩ টাকা সরাসরি ডিসকাউন্ট কুপন পান!`;
    return text;
}

async function getReferralStats(referrerId) {
    let pending = 0;
    let successful = 0;

    if (db.isConfigured()) {
        const coupons = await db.getAllCoupons();
        if (coupons) {
            coupons.forEach(cp => {
                if (cp.code.startsWith('REFERRAL|')) {
                    const parts = cp.code.split('|');
                    if (parts[2] === referrerId) {
                        pending++;
                    }
                } else if (cp.code.startsWith('REWARDED_REF|')) {
                    const parts = cp.code.split('|');
                    if (parts[1] === referrerId) {
                        successful++;
                    }
                }
            });
        }
    } else {
        successful = memoryRewardedReferrals[referrerId] ? memoryRewardedReferrals[referrerId].length : 0;
        pending = Object.values(memoryReferrals).filter(rId => rId === referrerId).length;
    }
    return { pending, successful };
}

const groupMemberCache = new Map(); // userId -> expiry timestamp

async function checkUserJoinedGroup(ctx, userId, forceCheck = false) {
    if (userId.toString() === ADMIN_ID) return true;

    // Check if Force Join is enabled in Bot Control
    const isForceJoinEnabled = await getForceJoinStatus();
    if (!isForceJoinEnabled) return true; // auto pass membership check!

    const strId = userId.toString();
    if (!forceCheck) {
        const cachedExpiry = groupMemberCache.get(strId);
        if (cachedExpiry && Date.now() < cachedExpiry) {
            return true;
        }
    }

    try {
        const member = await ctx.telegram.getChatMember(parseInt(GROUP_ID), parseInt(userId));
        const status = member.status;
        const isMember = (status === 'creator' || status === 'administrator' || status === 'member' || status === 'restricted');
        if (isMember) {
            // Cache verified membership for 5 minutes (300,000ms)
            groupMemberCache.set(strId, Date.now() + 300000);
        } else {
            groupMemberCache.delete(strId);
        }
        return isMember;
    } catch (err) {
        console.error("Failed to check group membership:", err.message);
        return true;
    }
}

async function isOutsideSellingHours() {
    // Check if selling hours constraint is enabled
    const enabled = await getSellingHoursStatus();
    if (!enabled) return false; // bypassed, so not outside selling hours

    try {
        const now = new Date();
        // Calculate Asia/Dhaka time (GMT+6)
        const bdTime = new Date(now.getTime() + (6 * 3600 * 1000));
        const hours = bdTime.getUTCHours();
        return (hours < 11 || hours >= 23);
    } catch (e) {
        return false;
    }
}

async function getLatestCompletedEmail(userId) {
    const orders = await getUserOrders(userId);
    if (orders && orders.length > 0) {
        const completedOrder = orders.find(ord => ord.status === 'Completed');
        if (completedOrder) {
            return completedOrder.customEmail || 'N/A';
        }
    }
    return 'N/A';
}

const fakeNames = ["Hasan", "Robin", "Fahim", "Mim", "Rashed", "Nipa", "Arif", "Sumon", "Sazzad", "Anik", "Mithu", "Liton", "Sujon", "Tarek", "Raju", "Hassan", "Apu", "Joy", "Rony", "Faisal"];
const fakeReviews = [
    "অসাধারণ সার্ভিস! খুব দ্রুত ডেলিভারি পেলাম।",
    "অ্যাকাউন্ট পারফেক্টলি কাজ করছে। ধন্যবাদ!",
    "খুব কম সময়ে ডেলিভারি দেওয়ার জন্য ধন্যবাদ।",
    "সেরা সার্ভিস! রেটিং ৫/৫।",
    "খুবই ভালো এবং বিশ্বস্ত সেলার।",
    "ডেলিভারি স্পিড অসাধারণ ছিল!",
    "প্যাকেজ একটিভ হতে মাত্র ২ মিনিট লেগেছে!",
    "রেকমেন্ডেড সেলার, ধন্যবাদ ভাই!",
    "১০০% রিয়েল এবং সিকিউর। কাজ করছে সুন্দর।"
];

function escapeMarkdownV2(str, isCode = false) {
    if (!str) return '';
    if (isCode) {
        return str.toString().replace(/[\\`]/g, '\\$&');
    }
    return str.toString().replace(/[\\_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function sendFakeSaleToGroup(force = false) {
    try {
        let enabled = true; // default enabled
        if (db.isConfigured()) {
            const coupon = await db.getCoupon('SYSTEM_FAKE_SALES_ENABLED');
            if (coupon) {
                enabled = coupon.discount_amount === 1;
            }
        } else {
            enabled = memoryFakeSalesEnabled;
        }

        if (!enabled && !force) return;

        const orderId = Math.floor(10000 + Math.random() * 90000);
        const rawName = fakeNames[Math.floor(Math.random() * fakeNames.length)];
        const maskedName = rawName.length > 2 ? `${rawName.substring(0, 2)}***` : `${rawName}***`;

        const packages = [
            { id: 'pkg_1', name: "OWL Proxy Account", plan: "200MB", price: 35 },
            { id: 'pkg_2', name: "OWL Proxy 1 Pis", plan: "200MB", price: 30 },
            { id: 'pkg_3', name: "FREE PROXY 10 IPs", plan: "1GB [10 IPs]", price: 20 }
        ];
        const selectedPkg = packages[Math.floor(Math.random() * packages.length)];
        const methods = ["bKash Personal", "Nagad Personal", "Binance Pay ID"];
        const method = methods[Math.floor(Math.random() * methods.length)];

        let fakeSalesMsg = "";

        if (selectedPkg.id === 'pkg_1') {
            const firstLetter = rawName.substring(0, 2).toLowerCase();
            const maskedEmail = `${firstLetter}***@emalupe.com`;
            fakeSalesMsg = `🟢 **ORDER SUCCESSFUL**\n\n` +
                           `╔════════════════════╗\n` +
                           `🛒 **${selectedPkg.name.toUpperCase()}**\n` +
                           `╚════════════════════╝\n\n` +
                           `╭──────────────────╮\n` +
                           `│ 🆔 ORDER \`#${orderId}\`\n` +
                           `│ 📦 PLAN \`${selectedPkg.plan}\`\n` +
                           `│ 💰 \`${selectedPkg.price} TK\` | \`${method}\`\n` +
                           `╰──────────────────╯\n\n` +
                           `╭──────────────────╮\n` +
                           `│ 🔐 **ACCOUNT DELIVERED**\n` +
                           `╰──────────────────╯\n\n` +
                           `> 👤 Buyer: \`${maskedName}\`\n` +
                           `> 📧 Gmail: \`${maskedEmail}\`\n` +
                           `> 🔑 Pass: \`••••••••\`\n\n` +
                           `📡 STATUS → 🟢 **DELIVERED (LOGIN CODE FAST)**\n\n` +
                           `> 🚀 **OWL PROXY BOT**`;
        } else if (selectedPkg.id === 'pkg_2') {
            const fakeIP = `103.${Math.floor(Math.random()*200 + 10)}.${Math.floor(Math.random()*200 + 10)}.xxx:8080`;
            fakeSalesMsg = `🟢 **ORDER SUCCESSFUL**\n\n` +
                           `╔════════════════════╗\n` +
                           `🛒 **${selectedPkg.name.toUpperCase()}**\n` +
                           `╚════════════════════╝\n\n` +
                           `╭──────────────────╮\n` +
                           `│ 🆔 ORDER \`#${orderId}\`\n` +
                           `│ 📦 PLAN \`${selectedPkg.plan}\`\n` +
                           `│ 💰 \`${selectedPkg.price} TK\` | \`${method}\`\n` +
                           `╰──────────────────╯\n\n` +
                           `╭──────────────────╮\n` +
                           `│ 🌐 **PROXY DELIVERED**\n` +
                           `╰──────────────────╯\n\n` +
                           `> 👤 Buyer: \`${maskedName}\`\n` +
                           `> 📡 Proxy: \`${fakeIP}:user:***\`\n\n` +
                           `📡 STATUS → 🟢 **INSTANT DELIVERED**\n\n` +
                           `> 🚀 **OWL PROXY BOT**`;
        } else {
            fakeSalesMsg = `🟢 **ORDER SUCCESSFUL**\n\n` +
                           `╔════════════════════╗\n` +
                           `🆓 **${selectedPkg.name.toUpperCase()}**\n` +
                           `╚════════════════════╝\n\n` +
                           `╭──────────────────╮\n` +
                           `│ 🆔 ORDER \`#${orderId}\`\n` +
                           `│ 📦 PLAN \`${selectedPkg.plan}\`\n` +
                           `│ 💰 \`${selectedPkg.price} TK\` | \`${method}\`\n` +
                           `╰──────────────────╯\n\n` +
                           `╭──────────────────╮\n` +
                           `│ 📄 **DOCUMENT DELIVERED**\n` +
                           `╰──────────────────╯\n\n` +
                           `> 👤 Buyer: \`${maskedName}\`\n` +
                           `> 📂 Document: \`free_proxy_10_${orderId}.txt\`\n\n` +
                           `📡 STATUS → 🟢 **FILE INSTANT DELIVERED**\n\n` +
                           `> 🚀 **OWL PROXY BOT**`;
        }

        const chatId = GROUP_ID.toString().startsWith('-') ? parseInt(GROUP_ID) : GROUP_ID;
        const botUsername = bot.botInfo ? bot.botInfo.username : 'OWLProxyBot';
        const sentMsg = await bot.telegram.sendMessage(chatId, fakeSalesMsg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🛒 BUY PROXY / START BOT 🚀', `https://t.me/${botUsername}?start=buy`)]
            ])
        });

        if (sentMsg && sentMsg.message_id) {
            await addAutoReactions(bot.telegram, GROUP_ID, sentMsg.message_id);
        }
    } catch (err) {
        console.error("Error sending fake sale:", err.message);
    }
}

// Reaction Counts Storage System (Default: ❤️ 25, 👌 14, 🫡 67, ⭐ 4.9, 🐷 12)
let memoryReactionCounts = { heart: 25, ok: 14, salute: 67, star: '4.9', pig: 12 };

async function getReactionCounts() {
    if (db.isConfigured()) {
        const coupon = await db.getCoupon('SYSTEM_REACTION_COUNTS');
        if (coupon && coupon.code) {
            const parts = coupon.code.split('|');
            if (parts.length >= 6) {
                return {
                    heart: parseInt(parts[1]) || 25,
                    ok: parseInt(parts[2]) || 14,
                    salute: parseInt(parts[3]) || 67,
                    star: parts[4] || '4.9',
                    pig: parseInt(parts[5]) || 12
                };
            }
        }
    }
    return memoryReactionCounts;
}

async function setReactionCounts(counts) {
    memoryReactionCounts = { ...counts };
    const code = `SYSTEM_REACTION_COUNTS|${counts.heart}|${counts.ok}|${counts.salute}|${counts.star}|${counts.pig}`;
    if (db.isConfigured()) {
        const existing = await db.getCoupon('SYSTEM_REACTION_COUNTS');
        if (existing) {
            await db.deleteCoupon(existing.code);
        }
        await db.createCoupon(code, 0);
    }
}

async function getGroupReactionButtons(countsOverride = null) {
    const counts = countsOverride || await getReactionCounts();
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(`❤️ ${counts.heart}`, `react_heart_${counts.heart}`),
            Markup.button.callback(`👌 ${counts.ok}`, `react_ok_${counts.ok}`),
            Markup.button.callback(`🫡 ${counts.salute}`, `react_salute_${counts.salute}`),
            Markup.button.callback(`⭐ ${counts.star}`, `react_star_${counts.star}`),
            Markup.button.callback(`🐷 ${counts.pig}`, `react_pig_${counts.pig}`)
        ]
    ]);
}

async function addAutoReactions(telegramObj, chatId, messageId) {
    try {
        const availableReactions = [
            { type: 'emoji', emoji: '👍' },
            { type: 'emoji', emoji: '❤️' },
            { type: 'emoji', emoji: '🔥' },
            { type: 'emoji', emoji: '⭐' }
        ];
        const selected = availableReactions[Math.floor(Math.random() * availableReactions.length)];
        await telegramObj.callApi('setMessageReaction', {
            chat_id: chatId,
            message_id: messageId,
            reaction: [selected]
        });
    } catch (err) {}
}

// Maintenance Mode & Scheduling Middleware
bot.use(async (ctx, next) => {
    // Only apply maintenance mode & selling hours restrictions to private direct chats with the bot
    if (ctx.chat && ctx.chat.type !== 'private') {
        return next();
    }
    if (ctx.from) {
        const userId = ctx.from.id.toString();
        if (userId !== ADMIN_ID) {
            // 1. Check manual maintenance mode first
            const isMaintenance = await getMaintenanceMode();
            if (isMaintenance) {
                if (ctx.callbackQuery) {
                    return ctx.answerCbQuery("⚠️ Bot is currently under maintenance. Please try again later.", { show_alert: true });
                }
                return ctx.reply("⚠️ *দুঃখিত! বটটি বর্তমানে রক্ষণাবেক্ষণ (Maintenance) মোডে রয়েছে।*\n\nখুব শীঘ্রই এটি আবার সচল করা হবে। যেকোনো জরুরি প্রয়োজনে যোগাযোগ করুন: @prime8088", { parse_mode: 'Markdown' });
            }

            // 2. Check scheduled selling hours (11:00 AM - 11:00 PM BD Time)
            const outside = await isOutsideSellingHours();
            if (outside) {
                const offHoursMsg = 
                    `✨ *SELLING TIME* ✨\n` +
                    `🕚 সকাল ১১:০০টা — রাত ১১:০০টা\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `🛒 এই সময়ের মধ্যে নিয়মিত Selling চলবে।\n` +
                    `🤖 বট OFF হয়ে যাওয়ার পরেও\n` +
                    `যদি কারও কোনো অ্যাকাউন্টের প্রয়োজন হয়,\n` +
                    `তাহলে সরাসরি 👨‍💻 Admin-কে Message করুন।\n` +
                    `💎 আপনার প্রয়োজন অনুযায়ী\n` +
                    `কাঙ্ক্ষিত Account নিতে পারবেন।\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📲 *WhatsApp Support*\n` +
                    `👉 \`01864339154\`\n` +
                    `🔗 [WhatsApp Link](https://wa.me/8801864339154)\n` +
                    `⚡ Fast Service • Trusted • Easy\n` +
                    `📩 Need an Account? → Contact Admin: @prime8088`;

                if (ctx.callbackQuery) {
                    return ctx.answerCbQuery("⚠️ Selling is currently closed (11 PM - 11 AM).", { show_alert: true });
                }
                return ctx.reply(offHoursMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
            }
        }
    }
    return next();
});


// Fallback in-memory objects in case Supabase is not configured
const memoryUserSession = {};
const memoryPendingOrders = {}; 
const memoryAllStartedUsers = new Set(); 
const memoryUserOrderHistory = {}; 
const memoryAdminSession = {};
const memoryCoupons = {
    'WELCOME10': 10,
    'SPECIAL20': 20
};

let extraAdminCache = new Set();
let lastAdminCacheTime = 0;

async function updateAdminCache() {
    try {
        const list = await db.getExtraAdmins();
        extraAdminCache = new Set(list || []);
        lastAdminCacheTime = Date.now();
    } catch (e) {}
}

function isSuperAdmin(ctx) {
    if (!ctx || !ctx.from) return false;
    return ctx.from.id.toString() === ADMIN_ID;
}

function isAdmin(ctx) {
    if (!ctx || !ctx.from) return false;
    const userId = ctx.from.id.toString();
    if (userId === ADMIN_ID) return true;
    
    if (Date.now() - lastAdminCacheTime > 15000) {
        updateAdminCache();
    }
    
    return extraAdminCache.has(userId);
}

async function notifyAllAdmins(telegramApi, text, extra = {}) {
    await updateAdminCache();
    const admins = new Set([ADMIN_ID, ...Array.from(extraAdminCache)]);
    for (const adminId of admins) {
        try {
            await telegramApi.sendMessage(adminId, text, extra);
        } catch (e) {}
    }
}

const lastUserSaveMap = new Map(); // userId -> timestamp

async function saveUser(ctx, force = false) {
    if (!ctx.from) return;
    const userId = ctx.from.id.toString();
    const now = Date.now();
    const lastSave = lastUserSaveMap.get(userId);
    if (!force && lastSave && (now - lastSave < 300000)) {
        return; // throttled (saved within last 5 minutes)
    }
    lastUserSaveMap.set(userId, now);

    const firstName = ctx.from.first_name || 'User';
    const username = ctx.from.username || '';

    if (db.isConfigured()) {
        const result = await db.saveUser(userId, firstName, username);
        if (result !== null) return;
    }
    memoryAllStartedUsers.add(userId);
}

async function getUserSession(userId) {
    if (db.isConfigured()) {
        const session = await db.getUserSession(userId);
        if (session !== null) {
            // Parse custom encoded method: "methodName|packageName|price|appliedCoupon|discount"
            const parts = session.method ? session.method.split('|') : [];
            const method = parts[0] || null;
            const packageName = parts[1] || '1 Account OWL Proxy';
            const price = parseInt(parts[2]) || 30;
            const appliedCoupon = parts[3] || null;
            const discount = parseInt(parts[4]) || 0;
            return {
                userId: session.user_id,
                method: method,
                packageName: packageName,
                price: price,
                appliedCoupon: appliedCoupon,
                discount: discount,
                waitingFor: session.waiting_for,
                proof: session.proof
            };
        }
    }
    if (!memoryUserSession[userId]) {
        memoryUserSession[userId] = { userId, method: null, packageName: '1 Account OWL Proxy', price: 30, appliedCoupon: null, discount: 0, waitingFor: null, proof: null };
    }
    return memoryUserSession[userId];
}

async function updateUserSession(userId, updateData) {
    const current = await getUserSession(userId);
    const merged = { ...current, ...updateData };

    if (db.isConfigured()) {
        // Encode method, packageName, price, appliedCoupon, and discount together into the "method" column
        const encodedMethod = `${merged.method || ''}|${merged.packageName || '1 Account OWL Proxy'}|${merged.price || 30}|${merged.appliedCoupon || ''}|${merged.discount || 0}`;
        const dbUpdate = {
            method: encodedMethod,
            waitingFor: merged.waitingFor,
            proof: merged.proof
        };
        const result = await db.updateUserSession(userId, dbUpdate);
        if (result !== null) return;
    }
    
    if (!memoryUserSession[userId]) {
        memoryUserSession[userId] = { userId, method: null, packageName: '1 Account OWL Proxy', price: 30, appliedCoupon: null, discount: 0, waitingFor: null, proof: null };
    }
    Object.assign(memoryUserSession[userId], updateData);
}

async function getAdminSession(userId) {
    if (db.isConfigured()) {
        const session = await db.getAdminSession(userId);
        if (session !== null) {
            const parts = session.step ? session.step.split('|') : [];
            const step = parts[0] || null;
            const extraData = parts[1] || null;
            return {
                userId: session.user_id,
                step: step,
                extraData: extraData,
                targetUserId: session.target_user_id,
                customEmail: session.custom_email
            };
        }
    }
    return memoryAdminSession[userId] || null;
}

async function updateAdminSession(userId, updateData) {
    if (db.isConfigured()) {
        let stepVal = updateData.step || '';
        if (updateData.extraData) {
            stepVal = `${stepVal}|${updateData.extraData}`;
        }
        const dbUpdate = {
            step: stepVal,
            targetUserId: updateData.targetUserId,
            customEmail: updateData.customEmail
        };
        const result = await db.updateAdminSession(userId, dbUpdate);
        if (result !== null) return;
    }
    if (!memoryAdminSession[userId]) {
        memoryAdminSession[userId] = { userId, step: null, extraData: null, targetUserId: null, customEmail: null };
    }
    Object.assign(memoryAdminSession[userId], updateData);
}

async function clearAdminSession(userId) {
    if (db.isConfigured()) {
        const result = await db.clearAdminSession(userId);
        if (result !== null) return;
    }
    delete memoryAdminSession[userId];
}

async function getUserOrders(userId) {
    if (db.isConfigured()) {
        const orders = await db.getUserOrders(userId);
        if (orders !== null) {
            return orders.map(ord => ({
                packageName: ord.package_name,
                method: ord.method,
                status: ord.status,
                customEmail: ord.custom_email,
                customPass: ord.custom_pass,
                loginCode: ord.login_code,
                createdAt: ord.created_at
            }));
        }
    }
    return memoryUserOrderHistory[userId] || [];
}

async function clearUserOrders(userId) {
    if (db.isConfigured()) {
        const result = await db.clearUserOrders(userId);
        if (result !== null) return;
    }
    memoryUserOrderHistory[userId] = [];
}

async function getPendingOrders() {
    if (db.isConfigured()) {
        const orders = await db.getPendingOrders();
        if (orders !== null) {
            return orders.map(ord => ({
                name: ord.name,
                method: ord.method ? ord.method.split('|')[0] : 'Unknown', // decode method
                userId: ord.user_id,
                packageName: ord.package_name
            }));
        }
    }
    return Object.values(memoryPendingOrders).filter(o => o.status === 'Pending Verification');
}

async function getOrderForUser(userId) {
    if (db.isConfigured()) {
        const ord = await db.getOrderForUser(userId);
        if (ord !== null) {
            return {
                name: ord.name,
                username: ord.username,
                userId: ord.user_id,
                method: ord.method ? ord.method.split('|')[0] : 'Unknown', // decode method
                proof: ord.proof,
                status: ord.status,
                packageName: ord.package_name
            };
        }
    }
    return memoryPendingOrders[userId] || null;
}

async function rejectOrderDB(userId) {
    if (db.isConfigured()) {
        const result = await db.updateOrderStatus(userId, 'Rejected', null, null);
        if (result !== null) return;
    }
    if (memoryPendingOrders[userId]) {
        memoryPendingOrders[userId].status = 'Rejected';
        delete memoryPendingOrders[userId];
    }
}

async function getSalesReportStats() {
    if (db.isConfigured()) {
        const stats = await db.getSalesReport();
        if (stats !== null) return stats;
    }
    
    // Memory fallback calculation
    let totalCount = 0;
    let totalRevenue = 0;
    let todayRevenue = 0;
    let monthRevenue = 0;
    
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const allMemoryOrders = [];
    Object.keys(memoryUserOrderHistory).forEach(uid => {
        memoryUserOrderHistory[uid].forEach(ord => {
            if (ord.status === 'Completed') {
                allMemoryOrders.push(ord);
            }
        });
    });
    
    allMemoryOrders.forEach(ord => {
        totalCount++;
        totalRevenue += 30; // default 30 TK
        const orderDate = new Date(ord.createdAt || now);
        if (orderDate >= startOfToday) {
            todayRevenue += 30;
        }
        if (orderDate >= startOfMonth) {
            monthRevenue += 30;
        }
    });
    
    return { totalCount, totalRevenue, todayRevenue, monthRevenue };
}

async function getUserIdsForBroadcast() {
    if (db.isConfigured()) {
        const users = await db.getAllUsers();
        if (users !== null) {
            return users.map(u => u.user_id);
        }
    }
    return Array.from(memoryAllStartedUsers);
}

// Reusable menu component with FAQ integrated & Ultra-Premium Styling
async function getMainMenu(userName) {
    const defaultText = `👋 *স্বাগতম {name}! আমাদের অফিশিয়াল শপে আপনাকে অভিনন্দন!* \n\n` +
                        `> 🚀 *Unlock Ultimate Multi-Accounting Security & Rocket Speed!* \n\n` +
                        `📌 *অনুগ্রহ করে নিচের বাটনগুলো থেকে আপনার প্রয়োজনীয় সেবাটি বেছে নিন:*`;
    const customMsg = await getCustomText('MSG_WELCOME', defaultText);
    const welcomeEmojiTag = await getItemEmojiTag('WELCOME', '💎');
    const crownEmoji = await getItemEmojiTag('VIP_CROWN', '👑');
    
    let msgContent = customMsg.includes('{name}') ? customMsg.replace('{name}', userName) : customMsg;
    const text = `${welcomeEmojiTag} *OWL PROXY BOT — OFFICIAL* ${crownEmoji}\n` +
                 `━━━━━━━━━━━━━━━━━━\n\n` +
                 `${msgContent}`;

    const detailsLabel = await getCustomText('LABEL_DETAILS', 'OWL Proxy Details');
    const buyLabel = await getCustomText('LABEL_BUY_NOW', 'Buy Now (প্যাকেজসমূহ)');
    const profileLabel = await getCustomText('LABEL_PROFILE', 'My Profile');
    const orderLabel = await getCustomText('LABEL_MY_ORDER', 'My Order');
    const noticeLabel = await getCustomText('LABEL_NOTICE', 'Offers & Notice');
    const faqLabel = await getCustomText('LABEL_FAQ', 'FAQ & Help Guide');
    const leaderLabel = await getCustomText('LABEL_LEADERBOARD', 'Leaderboard');
    const supportLabel = await getCustomText('LABEL_SUPPORT', 'VIP Support');

    return {
        text: text,
        extra: {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback(`📦 ${detailsLabel}`, 'details'), Markup.button.callback(`🛒 ${buyLabel}`, 'buy_options')],
                [Markup.button.callback(`👤 ${profileLabel}`, 'profile'), Markup.button.callback(`🛍 ${orderLabel}`, 'my_order')],
                [Markup.button.callback(`📢 ${noticeLabel}`, 'notice_board'), Markup.button.callback(`❓ ${faqLabel}`, 'faq_menu')],
                [Markup.button.callback(`🏆 ${leaderLabel}`, 'leaderboard'), Markup.button.callback(`📞 ${supportLabel}`, 'support')]
            ])
        }
    };
}

const adminReplyKeyboard = Markup.keyboard([
    ['⭐ 📦 Pending Orders ⭐', '⭐ 👥 Total Bot Users ⭐'],
    ['📢 Broadcast 📢', '📊 Sales Report 📊'],
    ['🎟️ Coupons 🎟️', '⚙️ Bot Control ⚙️'],
    ['👑 Close Admin Panel 👑']
]).resize();

// Force Join & Ban Verification Middleware
bot.use(async (ctx, next) => {
    const userId = ctx.from ? ctx.from.id.toString() : null;
    if (!userId || userId === ADMIN_ID) return next();

    // Check if user is banned
    const isBanned = await db.isUserBanned(userId);
    if (isBanned) {
        const banMsg = "⛔ *আপনার অ্যাকাউন্টটি এডমিন কর্তৃক স্থগিত/ব্যান করা হয়েছে।*\n\nসহায়তার জন্য এডমিনের সাথে যোগাযোগ করুন।";
        if (ctx.callbackQuery) {
            return ctx.answerCbQuery("আপনার অ্যাকাউন্টটি স্থগিত/ব্যান করা হয়েছে!", { show_alert: true });
        } else {
            return ctx.reply(banMsg, { parse_mode: 'Markdown' });
        }
    }

    // Skip checks for verifying join
    if (ctx.callbackQuery && ctx.callbackQuery.data === 'verify_join') {
        return next();
    }

    const joined = await checkUserJoinedGroup(ctx, userId);
    if (!joined) {
        // Run referral command capture in middleware in case they started via ref link
        if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/start ref_')) {
            const text = ctx.message.text;
            const refMatch = text.match(/^\/start ref_(\d+)$/);
            if (refMatch) {
                const referrerId = refMatch[1];
                const newUserId = ctx.from.id.toString();
                const isNew = await checkIfUserIsNew(newUserId);
                if (isNew && referrerId !== newUserId) {
                    await saveReferral(newUserId, referrerId);
                    try {
                        await ctx.telegram.sendMessage(referrerId, `👥 একজন কাস্টমার আপনার রেফারেল লিংকের মাধ্যমে বটে প্রবেশ করেছেন! তিনি প্রথম অর্ডার সম্পন্ন করলেই আপনি ৩ টাকা ডিসকাউন্ট কুপন পাবেন।`);
                    } catch (err) {}
                }
            }
        }

        let inviteLink = "https://t.me/OWLProxyBotGroup";
        try {
            const chat = await ctx.telegram.getChat(parseInt(GROUP_ID));
            if (chat.invite_link) {
                inviteLink = chat.invite_link;
            } else if (chat.username) {
                inviteLink = `https://t.me/${chat.username}`;
            }
        } catch (err) {}

        const msg = `📢 *অফিসিয়াল গ্রুপে জয়েন করুন!* 📢\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `বটের সকল সার্ভিস সচল করতে প্রথমে আমাদের অফিসিয়াল গ্রুপে জয়েন করুন।\n\n` +
                    `👇 নিচে জয়েন করে ভেরিফাই বাটনে ক্লিক করুন:`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.url('👥 Join Group', inviteLink)],
            [Markup.button.callback('🟢 Verify / Check Join', 'verify_join')]
        ]);

        if (ctx.callbackQuery) {
            await ctx.answerCbQuery("গ্রুপে জয়েন করা বাধ্যতামূলক!", { show_alert: true });
            try {
                return await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...keyboard });
            } catch (e) {
                return await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard });
            }
        } else {
            return await ctx.reply(msg, { parse_mode: 'Markdown', ...keyboard });
        }
    }

    return next();
});

// /start কমান্ড
bot.start(async (ctx) => {
    try {
        const text = ctx.message ? ctx.message.text : '';
        const refMatch = text.match(/^\/start ref_(\d+)$/);
        let referredByMsg = '';
        if (refMatch) {
            const referrerId = refMatch[1];
            const newUserId = ctx.from.id.toString();
            const isNew = await checkIfUserIsNew(newUserId);
            if (isNew && referrerId !== newUserId) {
                await saveReferral(newUserId, referrerId);
                referredByMsg = `🎉 *আপনি আপনার বন্ধুর রেফারেল লিংকের মাধ্যমে প্রবেশ করেছেন!*\n\nআপনার প্রথম কেনাকাটা সফলভাবে সম্পন্ন হলে আপনার বন্ধু ৩ টাকা ডিসকাউন্ট কুপন কমিশন পাবেন। ❤️\n\n`;
                try {
                    await ctx.telegram.sendMessage(referrerId, `👥 একজন কাস্টমার আপনার রেফারেল লিংকের মাধ্যমে বটে প্রবেশ করেছেন! তিনি প্রথম অর্ডার সম্পন্ন করলেই আপনি ৩ টাকা ডিসকাউন্ট কুপন পাবেন।`);
                } catch (err) {}
            }
        }

        const userId = ctx.from.id.toString();
        try { await saveUser(ctx, true); } catch (e) {}
        try { await updateUserSession(userId, { waitingFor: null, tempRating: null }); } catch (e) {}
        try { await checkAndSendNotice(ctx); } catch (e) {}
        const userName = ctx.from.first_name || "User";
        const menu = await getMainMenu(userName);
        if (referredByMsg) {
            try { await ctx.reply(referredByMsg, { parse_mode: 'Markdown' }); } catch (e) {}
        }
        return await ctx.reply(menu.text, menu.extra);
    } catch (err) {
        console.error("Error in /start command:", err.message);
        const userName = (ctx.from && ctx.from.first_name) || "User";
        const fallbackMenu = await getMainMenu(userName);
        return ctx.reply(fallbackMenu.text, fallbackMenu.extra);
    }
});

// Instant answer to all callback queries to prevent button loading delays / spinning
bot.on('callback_query', async (ctx, next) => {
    ctx.answerCbQuery().catch(() => {});
    return next();
});

// Inline Action: Main Menu (Back navigation handler)
bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    const userName = ctx.from.first_name || "User";
    const menu = await getMainMenu(userName);
    try {
        await ctx.editMessageText(menu.text, menu.extra);
    } catch (e) {
        await ctx.reply(menu.text, menu.extra);
    }
});

// OWL Proxy Details with Close/OK button & Back button
bot.action('details', async (ctx) => {
    await ctx.answerCbQuery();
    const detailsText = 
        `🦉 *OWL PROXY BOT — SERVICE DETAILS* 🦉\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `> *High-Quality Residential & Dedicated Proxies for Ultimate Speed & Security!*\n\n` +
        `আপনার Social Media, Web Scraping, Multi-Accounting বা Automation-এর জন্য ১০০% ক্লিন ও ফাস্ট আইপি সার্ভিস।\n\n` +
        `📦 *Available Products & Pricing:* 📦\n` +
        `• 1️⃣ *OWL Proxy Account* — *35 TK* [200MB]\n` +
        `  - Gmail & Password format with Fast Login Code support\n\n` +
        `• 2️⃣ *OWL Proxy 1 Pis* — *30 TK* [200MB]\n` +
        `  - Direct \`IP:PORT:USERNAME:PASSWORD\` with 1-click copy\n\n` +
        `• 3️⃣ *FREE PROXY — 10 IPs* — *20 TK* [1GB]\n` +
        `  - Delivered in clean \`.txt\` file format\n\n` +
        `🌍 *AVAILABLE PROXY COUNTRIES:*\n` +
        `🇺🇸 US | 🇬🇧 UK | 🇩🇪 DE | 🇫🇷 FR | 🇯🇵 JP\n` +
        `🇸🇬 SG | 🇨🇦 CA | 🇳🇱 NL | 🇵🇱 PL | 🇪🇸 ES\n\n` +
        `🛡 *Uptime Guarantee:* ২৪ ঘণ্টার ফুল সাপোর্ট বা আইপি রিপ্লেসমেন্ট গ্যারান্টি।\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👇 প্যাকেজ কিনতে নিচে বাটন চাপুন:`;

    try {
        await ctx.editMessageText(detailsText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('❌ Close Details', 'close_details')],
                [Markup.button.callback('⬅️ Back to Menu', 'main_menu')]
            ])
        });
    } catch(e) {
        return ctx.reply(detailsText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('❌ Close Details', 'close_details')],
                [Markup.button.callback('⬅️ Back to Menu', 'main_menu')]
            ])
        });
    }
});

bot.action('close_details', async (ctx) => {
    try {
        await ctx.deleteMessage();
    } catch (e) {
        await ctx.answerCbQuery("Closed!");
    }
});

// Update buy_options to show Package Selection first
bot.action('buy_options', async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.from;

    await checkAndSendNotice(ctx);

    // Optional admin trace alert when checkout starts
    try {
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `🛒 *User checked packages!*\n\n` +
            `• Name: ${user.first_name || 'User'}\n` +
            `• Username: @${user.username ? user.username : 'N/A'}\n` +
            `• User ID: \`${user.id}\``,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {}

    // Reset applied coupon when user selects a new package
    await updateUserSession(user.id.toString(), { appliedCoupon: '', discount: 0 });

    const stock1 = await getPackageStockStatus('pkg_1');
    const stock2 = await getPackageStockStatus('pkg_2');
    const stock3 = await getPackageStockStatus('pkg_3');

    const pkgText = `⭐️ *OWL PROXY BOT* ⭐️\n` +
                    `📦 *Select Packages / প্যাকেজ সিলেক্ট করুন*:\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `📌 নিচের অপশনগুলো থেকে আপনার প্রয়োজনীয় প্যাকেজটি সিলেক্ট করুন:\n\n` +
                    `🌍 *AVAILABLE PROXY COUNTRIES*\n\n` +
                    `🇺🇸 United States\n` +
                    `🇬🇧 United Kingdom\n` +
                    `🇩🇪 Germany\n` +
                    `🇫🇷 France\n` +
                    `🇯🇵 Japan\n` +
                    `🇸🇬 Singapore\n` +
                    `🇨🇦 Canada\n` +
                    `🇳🇱 Netherlands\n` +
                    `🇵🇱 Poland\n` +
                    `🇪🇸 Spain`;

    const pkgExtra = {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback(`🦉 OWL Proxy Account — 35 TK [200MB] ${stock1 ? '🟢' : '🔴 (Out of stock)'}`, 'pkg_1_35')],
            [Markup.button.callback(`🦉 OWL Proxy 1 Pis — 30 TK [200MB] ${stock2 ? '🟢' : '🔴 (Out of stock)'}`, 'pkg_2_30')],
            [Markup.button.callback(`🆓 FREE PROXY — 10 IPs — 20 TK [1GB] ${stock3 ? '🟢' : '🔴 (Out of stock)'}`, 'pkg_3_20')],
            [Markup.button.callback('⬅️ Back to Menu', 'main_menu')]
        ])
    };

    try {
        await ctx.editMessageText(pkgText, pkgExtra);
    } catch(e) {
        return ctx.reply(pkgText, pkgExtra);
    }
});

// Helper function to render payment selection screen with dynamic coupon status & wallet option
async function showPaymentSelectionScreen(ctx, userId) {
    const session = await getUserSession(userId);
    let price = session.price || 30;
    const isReseller = await db.isResellerUser(userId);

    if (isReseller) {
        let pkgKey = 'pkg_1';
        if (session.packageName.includes('1 Pis') || session.packageName.includes('30')) pkgKey = 'pkg_2';
        if (session.packageName.includes('FREE PROXY') || session.packageName.includes('20')) pkgKey = 'pkg_3';
        price = await db.getResellerPrice(pkgKey);
    }

    const discount = session.discount || 0;
    const finalPrice = Math.max(0, price - discount);
    const balance = await db.getUserBalance(userId);

    let couponInfo = "";
    if (session.appliedCoupon) {
        couponInfo = `🎟️ *Applied Coupon:* \`${session.appliedCoupon}\` (-${discount} TK)\n`;
    }

    let resellerBadge = "";
    if (isReseller) {
        const resellerEmoji = await getItemEmojiTag('RESELLER_BADGE', '👔');
        const starEmoji = await getItemEmojiTag('VIP_STAR', '🌟');
        resellerBadge = `${resellerEmoji} *Reseller Wholesale Rate Applied!* (${starEmoji} \`${price} TK\` Special Price)\n`;
    }

    const buyNowEmojiTag = await getItemEmojiTag('BUY_NOW', '🛒');
    const bkashLabel = await getCustomText('LABEL_BKASH', 'bKash');
    const nagadLabel = await getCustomText('LABEL_NAGAD', 'Nagad');
    const binanceLabel = await getCustomText('LABEL_BINANCE', 'Binance (USDT)');
    const payoneerLabel = await getCustomText('LABEL_PAYONEER', 'Payoneer');

    const buyText = `${buyNowEmojiTag} *Checkout Summary* ${buyNowEmojiTag}\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📦 *Package:* \`${session.packageName}\`\n` +
                    resellerBadge +
                    couponInfo +
                    `💰 *Total Payable:* *${finalPrice} TK*\n` +
                    `💳 *Your Wallet Balance:* \`${balance} TK\`\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `✨ *Select Payment Method / পেমেন্ট মেথড সিলেক্ট করুন:*`;
    
    const buyExtra = {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback(`💳 Pay with Wallet Balance (${balance} TK)`, 'pay_wallet')],
            [Markup.button.callback(`🇧🇩 ${bkashLabel}`, 'pay_bkash'), Markup.button.callback(`🇧🇩 ${nagadLabel}`, 'pay_nagad')],
            [Markup.button.callback(`🌐 ${binanceLabel}`, 'pay_binance'), Markup.button.callback(`🌐 ${payoneerLabel}`, 'pay_payoneer')],
            [Markup.button.callback('🎟️ Apply Coupon Code', 'apply_coupon_prompt')],
            [Markup.button.callback('⬅️ Back to Packages', 'buy_options'), Markup.button.callback('🏠 Main Menu', 'main_menu')]
        ])
    };

    try {
        await ctx.editMessageText(buyText, buyExtra);
    } catch(e) {
        return ctx.reply(buyText, buyExtra);
    }
}

// Callback handler for package selection
bot.action(/^pkg_(\d+)_(\d+)$/, async (ctx) => {
    const count = ctx.match[1];
    let price = parseInt(ctx.match[2]);
    const userId = ctx.from.id.toString();
    const isReseller = await db.isResellerUser(userId);

    if (isReseller) {
        price = await db.getResellerPrice(`pkg_${count}`);
    }

    // Check Stock first
    const isAvailable = await getPackageStockStatus(`pkg_${count}`);
    if (!isAvailable) {
        await ctx.answerCbQuery("⚠️ স্টক খালি! ইমার্জেন্সির জন্য সাপোর্টে যোগাযোগ করুন।", { show_alert: true });
        
        const alertText = isReseller ?
            `⚠️ *রিসেলার স্টক সংক্রান্ত জরুরি নোটিশ* ⚠️\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `প্রিয় রিসেলার, এই মুহূর্তে আপনার সিলেক্ট করা প্রক্সি প্যাকেজের **স্টক অত্যন্ত কম/খালি রয়েছে!**\n\n` +
            `🚨 আপনার যদি বাল্ক (Bulk) বা জরুরি প্রক্সি সার্ভিসের প্রয়োজন হয়, তবে সরাসরি **Contact Support**-এ এডমিনের সাথে কথা বলুন। \n\n` +
            `এডমিন আপনাকে খুব দ্রুত প্রাইভেট স্টক বা বাল্ক প্রক্সি ব্যবস্থা করে দেওয়ার ব্যবস্থা করবেন। ❤️\n` +
            `━━━━━━━━━━━━━━━━━━` :
            `🚨 *স্টক সংক্রান্ত ইমার্জেন্সি অ্যালার্ট!* 🚨\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `দুঃখিত! আপনি যে প্রক্সি প্যাকেজটি সিলেক্ট করেছেন সেটির **স্টক বর্তমানে খালি/কম রয়েছে।**\n\n` +
            `📞 *আপনার যদি খুব বেশি ইমার্জেন্সি প্রক্সি প্রয়োজন হয়:* \n` +
            `তবে সরাসরি আমাদের **Contact Support**-এ অ্যাডমিনের সাথে কথা বলুন। অ্যাডমিন আপনাকে ইমার্জেন্সি স্টক ব্যবস্থা করে দিতে সাহায্য করবেন। ❤️\n` +
            `━━━━━━━━━━━━━━━━━━`;

        const alertKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📞 Contact Support (জরুরি কথা বলুন)', 'support')],
            [Markup.button.callback('⬅️ Back to Packages', 'buy_options')]
        ]);

        try {
            return await ctx.editMessageText(alertText, { parse_mode: 'Markdown', ...alertKeyboard });
        } catch(e) {
            return await ctx.reply(alertText, { parse_mode: 'Markdown', ...alertKeyboard });
        }
    }

    await ctx.answerCbQuery();
    let packageName = '🦉 OWL Proxy Account — 35 TK [200MB]';
    if (count === '1') {
        packageName = '🦉 OWL Proxy Account — 35 TK [200MB]';
    } else if (count === '2') {
        packageName = '🦉 OWL Proxy 1 Pis — 30 TK [200MB]';
    } else if (count === '3') {
        packageName = '🆓 FREE PROXY — 10 IPs — 20 TK [1GB]';
    }
    
    // Save package selection in user session
    await updateUserSession(userId, { packageName, price: price, appliedCoupon: '', discount: 0 });

    return showPaymentSelectionScreen(ctx, userId);
});

bot.action('choose_account_stock', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { customEmail: 'Stock Account' });
    return showPaymentSelectionScreen(ctx, userId);
});

bot.action('choose_account_own_email', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'user_custom_email_input' });
    return ctx.reply("📧 অনুগ্রহ করে আপনার ইমেইল এড্রেসটি লিখে পাঠান (যেটিতে OWL Proxy প্রিমিয়াম সেটআপ পাবেন):");
});

// Callback to trigger Coupon Input prompt
bot.action('apply_coupon_prompt', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'coupon_code' });
    return ctx.reply("🎟️ অনুগ্রহ করে আপনার কুপন কোডটি লিখে পাঠান (যেমন: WELCOME10):");
});

bot.action('profile', async (ctx) => {
    await ctx.answerCbQuery();
    const user = ctx.from;
    const botUsername = ctx.botInfo ? ctx.botInfo.username : 'OWLProxyBotBot';
    const refLink = `https://t.me/${botUsername}?start=ref_${user.id}`;

    let inviteLink = "https://t.me/OWLProxyBotGroup";
    try {
        const chat = await ctx.telegram.getChat(parseInt(GROUP_ID));
        if (chat.invite_link) {
            inviteLink = chat.invite_link;
        } else if (chat.username) {
            inviteLink = `https://t.me/${chat.username}`;
        }
    } catch (err) {}

    const stats = await getReferralStats(user.id.toString());
    const totalEarnings = stats.successful * 3;
    const isReseller = await db.isResellerUser(user.id.toString());
    const balance = await db.getUserBalance(user.id.toString());

    let resellerBadgeText = `• *Account Rank:* 🟢 \`Normal Member\``;
    if (isReseller) {
        const resellerEmoji = await getItemEmojiTag('RESELLER_BADGE', '👔');
        const starEmoji = await getItemEmojiTag('VIP_STAR', '🌟');
        const crownEmoji = await getItemEmojiTag('VIP_CROWN', '👑');
        resellerBadgeText = `• *Account Rank:* ${resellerEmoji} \`VIP VERIFIED RESELLER\` ${crownEmoji}\n• *Wholesale Status:* ${starEmoji} \`VIP Wholesale Rates Active\``;
    }

    const profileText = `👤 *My Profile Info / আমার প্রোফাইল* 👤\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `• *Name:* \`${user.first_name}\`\n` +
                        `• *Username:* @${user.username || 'N/A'}\n` +
                        `• *User ID:* \`${user.id}\` (ক্লিক করে কপি করুন)\n` +
                        `${resellerBadgeText}\n` +
                        `• *Wallet Balance:* \`${balance} TK\` 💳\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `👥 *Referral Statistics / রেফার ড্যাশবোর্ড:*\n` +
                        `• *Successful Refers (সফল রেফার):* \`${stats.successful}\` জন\n` +
                        `• *Pending Refers (পেন্ডিং রেফার):* \`${stats.pending}\` জন\n` +
                        `• *Total Earnings (মোট কমিশন আয়):* \`${totalEarnings} TK\`\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `👥 *Refer & Earn (রেফারেল লিংক):*\n` +
                        `• \`${refLink}\` (ক্লিক করে কপি করুন)\n` +
                        `> এই লিংকটি বন্ধুদের সাথে শেয়ার করুন। আপনার লিংকের মাধ্যমে কেউ এসে প্রথম কেনাকাটা সম্পূর্ণ করলে আপনি পাবেন *৩ টাকা* ডিসকাউন্ট কুপন! 🎁\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💎 *OWL PROXY BOT* এর সাথে থাকার জন্য ধন্যবাদ!`;
    return ctx.reply(profileText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.url('👥 Join Our Group', inviteLink)],
            [Markup.button.callback('⬅️ Back to Menu', 'main_menu')]
        ])
    });
});

bot.action('my_order', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const history = await getUserOrders(userId);

    if (!history || history.length === 0) {
        return ctx.reply(
            `🛍 *Your Orders / আপনার অর্ডার* 🛍\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `> ❌ আপনার কোনো পূর্ববর্তী অর্ডার পাওয়া যায়নি।`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
        });
    }

    let text = `🛍 *Your Order History / লাইভ ট্র্যাকিং* 🛍\n` +
               `━━━━━━━━━━━━━━━━━━\n\n`;
    history.forEach((ord, index) => {
        const dateStr = ord.createdAt ? new Date(ord.createdAt).toLocaleString() : 'N/A';
        
        let statusEmoji = "⏳";
        let statusTextBengali = "অ্যাডমিন ভেরিফাই করছেন...";
        let progressBar = "";
        
        if (ord.status === 'Completed') {
            statusEmoji = "✅";
            statusTextBengali = "সম্পন্ন হয়েছে (Delivered)";
            progressBar = "`✅ Verified ➔ ⚙️ Delivered ➔ 📦 Completed`";
        } else if (ord.status === 'Rejected') {
            statusEmoji = "❌";
            statusTextBengali = "প্রত্যাখ্যান করা হয়েছে (Rejected)";
            progressBar = "`❌ Order Rejected`";
        } else if (ord.status === 'Cancelled') {
            statusEmoji = "❌";
            statusTextBengali = "বাতিল করা হয়েছে (Cancelled)";
            progressBar = "`❌ Order Cancelled`";
        } else {
            // Pending Verification
            progressBar = "`⏳ Pending Verification ➔ ⚙️ Processing ➔ 📦 Completed`";
        }

        text += `📦 *Order #${index + 1}:* \`${ord.packageName}\`\n` +
                `   💳 *Method:* \`${ord.method ? ord.method.split('|')[0] : 'Unknown'}\`\n` +
                `   ${statusEmoji} *Status:* *${ord.status}* (${statusTextBengali})\n` +
                `   📈 *Progress:* ${progressBar}\n` +
                `   📅 *Date:* \`${dateStr}\`\n`;
                
        if (ord.status === 'Completed') {
            text += `   ━━━━━━━━━━━━━━━━━━\n`;
            if (ord.customEmail && ord.customEmail.includes(':')) {
                const lines = ord.customEmail.split('\n');
                lines.forEach((line, idx) => {
                    const parts = line.split(':');
                    if (parts.length >= 2) {
                        text += `   *Account #${idx + 1}:*\n` +
                                `   📧 Email: \`${parts[0].trim()}\`\n` +
                                `   🔑 Pass: \`${parts[1].trim()}\`\n`;
                    }
                });
            } else {
                if (ord.customEmail || ord.customPass) {
                    text += `   📧 *Email:* \`${ord.customEmail || 'N/A'}\`\n` +
                            `   🔑 *Password:* \`${ord.customPass || 'N/A'}\`\n`;
                }
            }
            if (ord.loginCode) {
                text += `   ⏳ *Login Code:* \`${ord.loginCode}\`\n`;
            }
            text += `   ━━━━━━━━━━━━━━━━━━\n`;
        }
        text += `\n`;
    });

    const hasPendingOrder = history.some(ord => ord.status === 'Pending Verification');
    const inlineButtons = [];
    if (hasPendingOrder) {
        inlineButtons.push([Markup.button.callback('❌ Cancel Pending Order', 'cancel_my_pending_order')]);
    }
    inlineButtons.push([
        Markup.button.callback('🗑 Clear History', 'clear_my_order'),
        Markup.button.callback('⬅️ Back to Menu', 'main_menu')
    ]);

    try {
        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(inlineButtons)
        });
    } catch(e) {
        return ctx.reply(text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(inlineButtons)
        });
    }
});

bot.action('clear_my_order', async (ctx) => {
    await ctx.answerCbQuery("Order history cleared!");
    const userId = ctx.from.id.toString();
    await clearUserOrders(userId);
    return ctx.reply(
        `🗑 *History Cleared / হিস্ট্রি ডিলিট* 🗑\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `> ✅ আপনার অর্ডার হিস্ট্রি সফলভাবে মুছে ফেলা হয়েছে।`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
    });
});

bot.action('cancel_my_pending_order', async (ctx) => {
    const userId = ctx.from.id.toString();
    
    let result = false;
    if (db.isConfigured()) {
        result = await db.cancelOrder(userId);
    } else {
        if (memoryPendingOrders[userId] && memoryPendingOrders[userId].status === 'Pending Verification') {
            memoryPendingOrders[userId].status = 'Cancelled';
            result = true;
        }
    }
    
    if (result) {
        if (memoryUserOrderHistory[userId]) {
            const pendingOrdIdx = memoryUserOrderHistory[userId].findIndex(o => o.status === 'Pending Verification');
            if (pendingOrdIdx !== -1) {
                memoryUserOrderHistory[userId][pendingOrdIdx].status = 'Cancelled';
            }
        }
        
        await ctx.answerCbQuery("Pending order cancelled!");
        
        try {
            await ctx.telegram.sendMessage(
                ADMIN_ID,
                `❌ *Order Cancelled by User!*\n\n` +
                `• Name: ${ctx.from.first_name || 'User'}\n` +
                `• Username: @${ctx.from.username || 'N/A'}\n` +
                `• User ID: \`${userId}\`\n` +
                `• Status: Cancelled`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {}

        return ctx.reply(
            `❌ *অর্ডার বাতিল করা হয়েছে!* ❌\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `> আপনার পেন্ডিং অর্ডারটি সফলভাবে বাতিল করা হয়েছে। আপনি চাইলে এখন আবার নতুন করে অর্ডার করতে পারবেন।`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
        });
    } else {
        return ctx.answerCbQuery("কোনো পেন্ডিং অর্ডার পাওয়া যায়নি!", { show_alert: true });
    }
});

bot.action('transaction', async (ctx) => {
    await ctx.answerCbQuery();
    const txText = `🧾 *Transaction Status / লেনদেন* 🧾\n` +
                   `━━━━━━━━━━━━━━━━━━\n` +
                   `> 🟢 **Verified Account Profile**\n\n` +
                   `🔒 আপনার সকল লেনদেন এবং অ্যাকাউন্ট তথ্য আমাদের সিস্টেমে সম্পূর্ণ নিরাপদ ও সুরক্ষিত রয়েছে।`;
    return ctx.reply(txText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
    });
});

bot.action('notice_board', async (ctx) => {
    await ctx.answerCbQuery();
    const noticeText = await getNoticeText();
    const text = `📢 *OWL PROXY BOT - Notice Board* 📢\n` +
                 `━━━━━━━━━━━━━━━━━━\n\n` +
                 `${noticeText}\n\n` +
                 `━━━━━━━━━━━━━━━━━━\n` +
                 `🔔 নতুন আপডেট ও ডিসকাউন্ট অফার পেতে গ্রুপে একটিভ থাকুন!`;
    return ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
    });
});

bot.action(/^react_(star|heart|ok|salute|pig)_(.+)$/, async (ctx) => {
    const type = ctx.match[1];
    let currentVal = parseInt(ctx.match[2]) || 1;
    let newCount = currentVal + 1;

    let alertMessage = "ধন্যবাদ! আপনার রিয়্যাকশন যুক্ত হয়েছে! ❤️";
    if (type === 'star') alertMessage = "ধন্যবাদ! আপনার ⭐ রিয়্যাকশন যুক্ত হয়েছে!";
    if (type === 'ok') alertMessage = "ধন্যবাদ! আপনার 👌 রিয়্যাকশন যুক্ত হয়েছে!";
    if (type === 'salute') alertMessage = "ধন্যবাদ! আপনার 🫡 রিয়্যাকশন যুক্ত হয়েছে!";
    if (type === 'pig') alertMessage = "ধন্যবাদ! আপনার 🐷 রিয়্যাকশন যুক্ত হয়েছে!";

    await ctx.answerCbQuery(alertMessage, { show_alert: true });

    try {
        if (ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup) {
            const keyboard = ctx.callbackQuery.message.reply_markup.inline_keyboard;
            const updatedKeyboard = keyboard.map(row => {
                return row.map(btn => {
                    if (btn.callback_data === ctx.callbackQuery.data) {
                        let label = btn.text;
                        if (type === 'star') label = `⭐ ${newCount}`;
                        if (type === 'heart') label = `❤️ ${newCount}`;
                        if (type === 'ok') label = `👌 ${newCount}`;
                        if (type === 'salute') label = `🫡 ${newCount}`;
                        if (type === 'pig') label = `🐷 ${newCount}`;
                        return Markup.button.callback(label, `react_${type}_${newCount}`);
                    }
                    return btn;
                });
            });
            await ctx.editMessageReplyMarkup({ inline_keyboard: updatedKeyboard });
        }
    } catch (err) {}
});

bot.action('leaderboard', async (ctx) => {
    await ctx.answerCbQuery();
    const text = await getLeaderboardText();
    return ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', 'main_menu')]])
    });
});

bot.action('verify_join', async (ctx) => {
    const userId = ctx.from.id.toString();
    groupMemberCache.delete(userId);
    const joined = await checkUserJoinedGroup(ctx, userId, true);
    if (joined) {
        await ctx.answerCbQuery("সফলভাবে ভেরিফাই হয়েছে! ❤️", { show_alert: true });
        try { await ctx.deleteMessage(); } catch(e) {}
        const userName = ctx.from.first_name || "User";
        const menu = await getMainMenu(userName);
        return ctx.reply(menu.text, menu.extra);
    } else {
        return ctx.answerCbQuery("❌ আপনি এখনো গ্রুপে জয়েন করেননি! অনুগ্রহ করে জয়েন করে আবার ট্রাই করুন।", { show_alert: true });
    }
});

bot.action('support', async (ctx) => {
    await ctx.answerCbQuery();
    const rawAdmin1 = await getCustomText('SUPPORT_USER', '@prime8088');
    const rawAdmin2 = await getCustomText('SUPPORT_USER_2', '@prime8088');
    const rawWa = await getCustomText('SUPPORT_WA', '8801864339154');

    const admin1User = rawAdmin1.replace('@', '').trim();
    const admin2User = rawAdmin2.replace('@', '').trim();
    let waPhone = rawWa.replace(/[^0-9]/g, '').trim();
    if (waPhone.startsWith('01')) waPhone = '88' + waPhone;

    const supportText = `📞 *VIP Support Center / সাহায্য কেন্দ্র* 💎\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `> *২৪/৭ যেকোনো সাহায্য, প্রক্সি রিট্রিভ বা জরুরি অনুসন্ধানের জন্য আমাদের অফিসিয়াল সাপোর্ট টিম তৈরি:* \n\n` +
                        `👇 *নিচের যেকোনো এডমিন বা অফিশিয়াল সাপোর্ট অপশনে সরাসরি ১-ক্লিকে নক দিতে বাটনে চাপ দিন:*`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('👨‍💻 Admin 1 (Main Support ⚡)', `https://t.me/${admin1User}`)],
        [Markup.button.url('👨‍💻 Admin 2 (Order & Stock Support 👑)', `https://t.me/${admin2User}`)],
        [Markup.button.url('📲 Official WhatsApp Support 💬', `https://wa.me/${waPhone}`)],
        [Markup.button.callback('✉️ In-Bot Direct Ticket (অটো মেসেজ)', 'open_support_ticket')],
        [Markup.button.callback('⬅️ Back to Main Menu', 'main_menu')]
    ]);

    try {
        await ctx.editMessageText(supportText, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...keyboard
        });
    } catch (e) {
        return ctx.reply(supportText, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...keyboard
        });
    }
});

bot.action('open_support_ticket', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'support_message' });
    return ctx.reply("✍️ অনুগ্রহ করে আপনার প্রশ্ন বা বার্তাটি এখানে লিখে পাঠান (অ্যাডমিন এটি দেখে সরাসরি বটের মাধ্যমে উত্তর দেবেন):");
});

bot.action(/^reply_support_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];
    const adminId = ctx.from.id.toString();
    
    await updateAdminSession(adminId, { step: `waiting_for_support_reply`, targetUserId: targetUserId });
    return ctx.reply(`✍️ ইউজারকে (ID: \`${targetUserId}\`) উত্তর দেওয়ার জন্য আপনার মেসেজটি লিখে পাঠান:`, { parse_mode: 'Markdown' });
});

// FAQ Section Actions
bot.action('faq_menu', async (ctx) => {
    await ctx.answerCbQuery();
    const faqText = `❓ *OWL Proxy Help Center & FAQ Guide* ❓\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `📌 আপনার প্রয়োজনীয় প্রশ্নের সমাধান পেতে নিচের যেকোনো একটি টপিক সিলেক্ট করুন:`;
    const faqExtra = {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🛠 1. How to Setup Proxy (প্রক্সি সেটআপ)', 'faq_proxy')],
            [Markup.button.callback('🔑 2. Login Code Issue (লগইন কোড সমস্যা)', 'faq_logincode')],
            [Markup.button.callback('🛡 3. Replacement Policy (রিপ্লেসমেন্ট পলিসি)', 'faq_replacement')],
            [Markup.button.callback('⬅️ Back to Main Menu', 'main_menu')]
        ])
    };
    try {
        await ctx.editMessageText(faqText, faqExtra);
    } catch(e) {
        return ctx.reply(faqText, faqExtra);
    }
});

bot.action('faq_proxy', async (ctx) => {
    await ctx.answerCbQuery();
    const superProxyLink = 'https://play.google.com/store/apps/details?id=com.scheler.superproxy';
    const text = 
        `🛠 *OWL Proxy — Easy Proxy Setup Guide* 🛠\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `> *মোবাইল এবং পিসিতে প্রক্সি সেটআপ করার সবচেয়ে সহজ নিয়ম:* \n\n` +
        `📱 *১. মোবাইল প্রক্সি সেটআপ (Android & iOS):*\n` +
        `• **সেরা এন্ড্রয়েড অ্যাপ:** **SuperProxy**\n` +
        `  📥 *প্লে-স্টোর অ্যাপ লিংক:* [SuperProxy App Click Here](${superProxyLink})\n` +
        `• **সেটআপ নিয়ম:**\n` +
        `  ১. **SuperProxy** অ্যাপ ওপেন করে **"Add Proxy"** চাপুন।\n` +
        `  ২. **Server (IP)** & **Port** দিন। (Proxy Type: HTTP/SOCKS5)\n` +
        `  ৩. Authentication থাকলে Username & Password দিন।\n` +
        `  ৪. **Save** করে **Start** বাটনে চাপ দিন!\n` +
        `  *(iOS / iPhone এর ক্ষেত্রে **Shadowrocket** বা **Potatso** অ্যাপ ব্যবহার করতে পারেন)*\n\n` +
        `💻 *২. কম্পিউটার / পিসি সেটআপ (Windows & Mac):*\n` +
        `• **সেরা এক্সটেনশন ও সফটওয়্যার:**\n` +
        `  🌐 **Chrome/Firefox Extension:** **FoxyProxy Standard** অথবা **Proxy SwitchyOmega**\n` +
        `  💻 **PC Desktop Software:** **Proxifier** (পুরো পিসির নেটওয়ার্ক প্রক্সিতে চালানোর জন্য)\n` +
        `  🕵️ **Anti-detect Browser:** **AdsPower**, **GoLogin**, **Dolphin{anty}**\n` +
        `• **সেটআপ নিয়ম:**\n` +
        `  ১. এক্সটেনশন বা সফটওয়্যারে \`IP:PORT\` অথবা \`IP:PORT:USER:PASS\` বসান।\n` +
        `  ২. **Check Proxy** দিয়ে সবুজ সংকেত আসলে ব্রাউজিং শুরু করুন!\n\n` +
        `⚠️ *জরুরি টিপস:* অ্যাকাউন্ট সেফ রাখতে সর্বদা ডেডিকেটেড আইপি ব্যবহার করবেন।`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url('📲 Download SuperProxy App', superProxyLink)],
        [Markup.button.callback('⬅️ Back to FAQ', 'faq_menu'), Markup.button.callback('🏠 Main Menu', 'main_menu')]
    ]);

    try {
        await ctx.editMessageText(text, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...keyboard
        });
    } catch (e) {
        return ctx.reply(text, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...keyboard
        });
    }
});

bot.action('faq_logincode', async (ctx) => {
    await ctx.answerCbQuery();
    const text = 
        `🔑 *How to Get Login Code* 🔑\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `> *অ্যাকাউন্টে লগইন করার জন্য কোড নেওয়ার নিয়ম:*\n\n` +
        `১. ব্রাউজারে কোড চাওয়ার পেজটি ওপেন রাখুন।\n` +
        `২. আমাদের টেলিগ্রাম বটের **"🛍 My Order"** এ যান এবং আপনার একটিভ অর্ডারের নিচে থাকা **"🔑 Get Login Code"** বাটনে ক্লিক করুন।\n` +
        `৩. সাথে সাথে অ্যাডমিনের কাছে আপনার কোড রিকোয়েস্ট চলে যাবে।\n` +
        `৪. অ্যাডমিন কোডটি দেওয়ার সাথে সাথে আপনার চ্যাটে ওয়ান-ক্লিক কপি বাটনসহ কোডটি চলে আসবে। কোডটি কপি করে ব্রাউজারে বসিয়ে লগইন সম্পূর্ণ করুন।`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Back to FAQ', 'faq_menu'), Markup.button.callback('🏠 Main Menu', 'main_menu')]
    ]);

    try {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
        return ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
});

bot.action('faq_replacement', async (ctx) => {
    await ctx.answerCbQuery();
    const text = 
        `🛡 *Warranty & Replacement Policy* 🛡\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `> *রিপ্লেসমেন্ট পেতে নিচের নিয়মগুলো মনোযোগ দিয়ে পড়ুন:*\n\n` +
        `• 🟢 *২৪ ঘণ্টার গ্যারান্টি:* অ্যাকাউন্ট ডেলিভারি নেওয়ার পর প্রথম ২৪ ঘণ্টার মধ্যে কোনো মেজর লগইন এরর বা টেকনিক্যাল সমস্যা হলে সম্পূর্ণ ফ্রিতে অ্যাকাউন্ট রিপ্লেস করে দেওয়া হবে।\n\n` +
        `• 🔴 *কখন রিপ্লেসমেন্ট পাবেন না:*\n` +
        `  ১. ফ্রি বা নিম্নমানের আইপি/প্রক্সি ব্যবহারের কারণে যদি অ্যাকাউন্ট রেস্ট্রিক্ট হয়।\n` +
        `  ২. ফেসবুক বা সোশ্যাল মিডিয়ার নিজস্ব সিকিউরিটি পলিসি ভঙ্গ করলে (যেমন: অতিরিক্ত স্প্যামিং করা)।\n\n` +
        `💬 যেকোনো জরুরি তথ্যের জন্য অ্যাডমিনের সাথে যোগাযোগ করুন: @prime8088`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Back to FAQ', 'faq_menu'), Markup.button.callback('🏠 Main Menu', 'main_menu')]
    ]);

    try {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e) {
        return ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }
});

// Payment Flows with Dynamic Prices & Coupons
bot.action('pay_bkash', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const session = await getUserSession(userId);
    await updateUserSession(userId, { method: 'bKash' });
    const finalPrice = Math.max(0, session.price - session.discount);
    const bkashNum = await getWallet('bkash');
    const bkashEmojiTag = await getItemEmojiTag('BKASH', '🌸');
    
    return ctx.reply(
        `${bkashEmojiTag} *bKash Payment Details* ${bkashEmojiTag}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📞 *Send Money Number:* \`${bkashNum}\` (Personal)\n` +
        `📦 *Selected Package:* \`${session.packageName}\`\n` +
        (session.appliedCoupon ? `🎟️ *Applied Coupon:* \`${session.appliedCoupon}\` (-${session.discount} TK)\n` : '') +
        `💰 *Total Payable:* *${finalPrice} TK*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `👇 পেমেন্ট করার পর নিচের বাটনে ক্লিক করে *TrxID* দিন:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✍️ TrxID দিন', 'input_trx')],
                [Markup.button.callback('⬅️ Change Payment', 'pkg_1_35'), Markup.button.callback('🏠 Main Menu', 'main_menu')]
            ])
        }
    );
});

bot.action('pay_nagad', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const session = await getUserSession(userId);
    await updateUserSession(userId, { method: 'Nagad' });
    const finalPrice = Math.max(0, session.price - session.discount);
    const nagadNum = await getWallet('nagad');
    const nagadEmojiTag = await getItemEmojiTag('NAGAD', '🍑');
    
    return ctx.reply(
        `${nagadEmojiTag} *Nagad Payment Details* ${nagadEmojiTag}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📞 *Send Money Number:* \`${nagadNum}\` (Personal)\n` +
        `📦 *Selected Package:* \`${session.packageName}\`\n` +
        (session.appliedCoupon ? `🎟️ *Applied Coupon:* \`${session.appliedCoupon}\` (-${session.discount} TK)\n` : '') +
        `💰 *Total Payable:* *${finalPrice} TK*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `👇 পেমেন্ট করার পর নিচের বাটনে ক্লিক করে *TrxID* দিন:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✍️ TrxID দিন', 'input_trx')],
                [Markup.button.callback('⬅️ Change Payment', 'pkg_1_35'), Markup.button.callback('🏠 Main Menu', 'main_menu')]
            ])
        }
    );
});

bot.action('pay_binance', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const session = await getUserSession(userId);
    await updateUserSession(userId, { method: 'Binance' });
    const finalPrice = Math.max(0, session.price - session.discount);
    const binanceId = await getWallet('binance');
    const binanceEmojiTag = await getItemEmojiTag('BINANCE', '🟡');
    
    return ctx.reply(
        `${binanceEmojiTag} *Binance Payment Details* ${binanceEmojiTag}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Pay ID:* \`${binanceId}\`\n` +
        `📦 *Selected Package:* \`${session.packageName}\`\n` +
        (session.appliedCoupon ? `🎟️ *Applied Coupon:* \`${session.appliedCoupon}\` (-${session.discount} TK)\n` : '') +
        `💰 *Total Payable:* *${finalPrice} TK* (or USDT equivalent)\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `👇 পেমেন্ট করার পর নিচের বাটনে ক্লিক করে স্ক্রিনশট বা TxID দিন:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📤 স্ক্রিনশট বা TxID দিন', 'input_screenshot')],
                [Markup.button.callback('⬅️ Change Payment', 'pkg_1_35'), Markup.button.callback('🏠 Main Menu', 'main_menu')]
            ])
        }
    );
});

bot.action('pay_payoneer', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const session = await getUserSession(userId);
    await updateUserSession(userId, { method: 'Payoneer' });
    const finalPrice = Math.max(0, session.price - session.discount);
    const payoneerEmail = await getWallet('payoneer');
    const payoneerEmojiTag = await getItemEmojiTag('PAYONEER', '🔷');
    
    return ctx.reply(
        `${payoneerEmojiTag} *Payoneer Payment Details* ${payoneerEmojiTag}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📧 *Email:* \`${payoneerEmail}\`\n` +
        `📦 *Selected Package:* \`${session.packageName}\`\n` +
        (session.appliedCoupon ? `🎟️ *Applied Coupon:* \`${session.appliedCoupon}\` (-${session.discount} TK)\n` : '') +
        `💰 *Total Payable:* *${finalPrice} TK* (or USD equivalent)\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `👇 পেমেন্ট করার পর নিচের বাটনে ক্লিক করে Details দিন:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✍️ Details দিন', 'input_payoneer_details')],
                [Markup.button.callback('⬅️ Change Payment', 'pkg_1_35'), Markup.button.callback('🏠 Main Menu', 'main_menu')]
            ])
        }
    );
});

bot.action('input_trx', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'trx' });
    return ctx.reply("আপনার পেমেন্টের TrxID কোডটি লিখে পাঠান:");
});

bot.action('input_screenshot', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'screenshot' });
    return ctx.reply("আপনার বাইন্যান্স পেমেন্টের স্ক্রিনশট বা TxID ছবি আকারে পাঠান:");
});

bot.action('input_payoneer_details', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'payoneer_details' });
    return ctx.reply("আপনার Payoneer Email এবং Customer ID লিখে পাঠান:");
});

async function checkLowStockAlert(ctx) {
    try {
        const stock1 = (await db.getAllStockAccounts('pkg_1')).filter(i => i.available).length;
        const stock2 = (await db.getAllStockAccounts('pkg_2')).filter(i => i.available).length;
        const stock3 = (await db.getAllStockAccounts('pkg_3')).filter(i => i.available).length;

        const alerts = [];
        if (stock1 <= 3) alerts.push(`• Plan 1 (Gmail & Pass): *${stock1}* Items left`);
        if (stock2 <= 3) alerts.push(`• Plan 2 (IP:PORT:USER:PASS): *${stock2}* Items left`);
        if (stock3 < 10) alerts.push(`• Plan 3 (FREE PROXY IPs): *${stock3}* IPs left (Requires 10 IPs per order)`);

        if (alerts.length > 0) {
            const alertMsg = `🚨 *LOW STOCK WARNING ALERT!* 🚨\n` +
                             `━━━━━━━━━━━━━━━━━━\n` +
                             `স্টকে নির্দিষ্ট প্রক্সি প্যাকেজের পরিমাণ কমে এসেছে:\n\n` +
                             alerts.join('\n') + `\n\n` +
                             `👉 কাস্টমারদের দ্রুত সেবার জন্য অনুগ্রহ করে স্টক রিফিল করুন।`;
            await ctx.telegram.sendMessage(ADMIN_ID, alertMsg, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('📦 Open Stock Manager', 'stock_menu')]])
            });
        }
    } catch (e) {
        console.error("Low stock alert error:", e.message);
    }
}

async function showAdminManagementMenu(ctx) {
    if (!isAdmin(ctx)) {
        if (ctx.callbackQuery) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
        return;
    }

    const msgText = `🎛️ *Golden Admin Control Panel*\n\n` +
                    `শুধুমাত্র এডমিন আইডি দিয়ে অ্যাক্সেসযোগ্য। নিচের বাটনগুলো দিয়ে বটের অর্ডারিং, স্ট্যাটাস, ইউজার ব্যান/আনব্যান, ব্যালেন্স এবং কাস্টমাইজেশন নিয়ন্ত্রণ করুন:`;

    const inlineKeyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('🔍 SEARCH ORDER / USER', 'admin_search_prompt'),
            Markup.button.callback('👑 TOP VIP BUYERS', 'admin_top_vip_buyers')
        ],
        [
            Markup.button.callback('💾 FULL DB BACKUP (JSON)', 'admin_full_db_backup')
        ],
        [
            Markup.button.callback('📈 TODAY ALL STATUS', 'admin_today_status'),
            Markup.button.callback('👤 USER STATUS CHECK', 'admin_user_status')
        ],
        [
            Markup.button.callback('📡 UPDATE JOINS', 'admin_update_joins'),
            Markup.button.callback('🛰️ LIVE SERVICES', 'admin_live_services')
        ],
        [
            Markup.button.callback('📝 CUSTOMIZE TEXTS & BUTTONS', 'admin_customize_texts')
        ],
        [
            Markup.button.callback('⛔ BAN USER', 'admin_ban_user'),
            Markup.button.callback('🔓 UNBAN USER', 'admin_unban_user')
        ],
        [
            Markup.button.callback('📜 BAN USER LIST', 'admin_ban_list')
        ],
        [
            Markup.button.callback('➖ REMOVE BALANCE', 'admin_remove_balance'),
            Markup.button.callback('➕ ADD BALANCE', 'admin_add_balance')
        ],
        [
            Markup.button.callback('📥 PENDING ORDERS', 'admin_pending_orders'),
            Markup.button.callback('👥 TOTAL BOT USERS', 'admin_total_users')
        ],
        [
            Markup.button.callback('📢 BROADCAST', 'admin_broadcast_prompt'),
            Markup.button.callback('🎟️ COUPONS', 'admin_coupons_menu')
        ],
        [
            Markup.button.callback('👑 MANAGE ADMINS (এডমিন যোগ/রিমুভ)', 'admin_manage_admins'),
            Markup.button.callback('👔 RESELLER MANAGER', 'admin_manage_resellers')
        ],
        [
            Markup.button.callback('📊 SALES REPORT', 'admin_sales_report'),
            Markup.button.callback('⚙️ BOT CONTROL', 'bot_control_back')
        ],
        [
            Markup.button.callback('❌ CLOSE ADMIN PANEL', 'admin_close')
        ]
    ]);

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(msgText, { parse_mode: 'Markdown', ...inlineKeyboard });
        } catch(e) {
            await ctx.reply(msgText, { parse_mode: 'Markdown', ...inlineKeyboard });
        }
    } else {
        await ctx.reply(msgText, { parse_mode: 'Markdown', ...inlineKeyboard });
    }
}

async function showBotControlPanel(ctx) {
    const isMaintenance = await getMaintenanceMode();
    const isNoticeEnabled = await getNoticeStatus();
    const noticeText = await getNoticeText();
    const isFakeSalesEnabled = await getFakeSalesStatus();
    const isForceJoinEnabled = await getForceJoinStatus();
    const isSellingHoursEnabled = await getSellingHoursStatus();
    const referRewardAmount = await getReferRewardAmount();
    const reactionCounts = await getReactionCounts();

    const isAllowCustomEmail = await db.getAllowCustomEmailStatus();

    const botStatusText = isMaintenance ? '🔴 **OFF (Maintenance Mode is ON)**' : '🟢 **ON (Normal Mode is ON)**';
    const noticeStatusText = isNoticeEnabled ? '🟢 **ENABLED (Active)**' : '🔴 **DISABLED (Inactive)**';
    const fakeSalesStatusText = isFakeSalesEnabled ? '🟢 **ENABLED (Sending Fake Sales)**' : '🔴 **DISABLED (Stopped)**';
    const forceJoinStatusText = isForceJoinEnabled ? '🟢 **ENABLED (Force Join is ON)**' : '🔴 **DISABLED (Everyone can access)**';
    const sellingHoursStatusText = isSellingHoursEnabled ? '🟢 **ENABLED (Selling limits: 11am-11pm)**' : '🔴 **DISABLED (24-Hour Selling is ON)**';
    const emailChoiceStatusText = isAllowCustomEmail ? '🟢 **ENABLED (User can choose Stock vs Own Email)**' : '🔴 **DISABLED (Stock Only Mode)**';

    const bkashNum = await getWallet('bkash');
    const nagadNum = await getWallet('nagad');
    const binanceId = await getWallet('binance');
    const payoneerEmail = await getWallet('payoneer');

    const panelMsg = `⚙️ *OWL Proxy Bot Golden Control Panel*\n\n` +
                     `• **Bot Status:** ${botStatusText}\n` +
                     `• **Highlight Notice:** ${noticeStatusText}\n` +
                     `• **Fake Sales Loop:** ${fakeSalesStatusText}\n` +
                     `• **Force Group Join:** ${forceJoinStatusText}\n` +
                     `• **Selling Time Limit:** ${sellingHoursStatusText}\n` +
                     `• **User Email Choice:** ${emailChoiceStatusText}\n` +
                     `• **Refer Reward Amount:** \`${referRewardAmount} TK\`\n` +
                     `• **Group Reactions:** ❤️ \`${reactionCounts.heart}\` | 👌 \`${reactionCounts.ok}\` | 🫡 \`${reactionCounts.salute}\` | ⭐ \`${reactionCounts.star}\`\n\n` +
                     `📢 **Notice Text:**\n` +
                     `> ${noticeText}\n\n` +
                     `💳 **Wallet Numbers / IDs:**\n` +
                     `• bKash: \`${bkashNum}\`\n` +
                     `• Nagad: \`${nagadNum}\`\n` +
                     `• Binance Pay ID: \`${binanceId}\`\n` +
                     `• Payoneer Email: \`${payoneerEmail}\`\n\n` +
                     `নিচের বাটনগুলো ক্লিক করে কন্ট্রোল করুন:`;

    const inlineKeyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('🎛️ Advanced Admin Management Panel', 'open_admin_mgmt_menu')
        ],
        [
            Markup.button.callback(isMaintenance ? '🟢 Turn Bot ON' : '🔴 Turn Bot OFF (Maintenance)', 'maintenance_toggle'),
        ],
        [
            Markup.button.callback(isNoticeEnabled ? '🔕 Disable Notice' : '🔔 Enable Notice', 'notice_toggle'),
            Markup.button.callback('✍️ Edit Notice Text', 'notice_edit_prompt')
        ],
        [
            Markup.button.callback(isFakeSalesEnabled ? '🔕 Disable Fake Sales' : '🔔 Enable Fake Sales', 'fake_sales_toggle'),
            Markup.button.callback('💳 Update Wallets', 'wallets_menu')
        ],
        [
            Markup.button.callback(isForceJoinEnabled ? '🔕 Disable Force Join' : '🔔 Enable Force Join', 'force_join_toggle'),
            Markup.button.callback(isSellingHoursEnabled ? '🔕 Disable Time Limits (24h)' : '🔔 Enable Time Limits (11am-11pm)', 'selling_hours_toggle')
        ],
        [
            Markup.button.callback(isAllowCustomEmail ? '🟢 Email Choice: ON' : '🔴 Email Choice: OFF (Stock)', 'toggle_allow_custom_email'),
            Markup.button.callback('💰 Edit Refer Bonus', 'edit_refer_reward')
        ],
        [
            Markup.button.callback('📦 Manage Stock Pool', 'stock_menu'),
            Markup.button.callback('🎭 Reaction Counts', 'edit_reaction_counts_prompt')
        ],
        [
            Markup.button.callback('⚡ Trigger Fake Sale Now (Test)', 'trigger_fake_sale_now')
        ]
    ]);

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(panelMsg, { parse_mode: 'Markdown', ...inlineKeyboard });
        } catch(e) {
            await ctx.reply(panelMsg, { parse_mode: 'Markdown', ...inlineKeyboard });
        }
    } else {
        await ctx.reply(panelMsg, { parse_mode: 'Markdown', ...inlineKeyboard });
    }
}

bot.action('pay_wallet', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const session = await getUserSession(userId);
    const balance = await db.getUserBalance(userId);
    const isReseller = await db.isResellerUser(userId);

    let pkgKey = 'pkg_1';
    let pName = session ? session.packageName || 'OWL Proxy Account — 35 TK [200MB]' : 'OWL Proxy Account — 35 TK [200MB]';
    if (pName.includes('1 Pis') || pName.includes('30')) pkgKey = 'pkg_2';
    if (pName.includes('FREE PROXY') || pName.includes('20')) pkgKey = 'pkg_3';

    let price = session ? session.price || 30 : 30;
    if (isReseller) {
        price = await db.getResellerPrice(pkgKey);
    }

    const discount = session.discount || 0;
    const finalPrice = Math.max(0, price - discount);

    if (balance < finalPrice) {
        return ctx.reply(
            `❌ *পর্যাপ্ত ওয়ালেট ব্যালেন্স নেই!*\n\n` +
            `• *প্যাকেজ মূল্য:* \`${finalPrice} TK\`\n` +
            `• *আপনার বর্তমান ওয়ালেট ব্যালেন্স:* \`${balance} TK\`\n\n` +
            `অর্ডার সম্পন্ন করতে অনুগ্রহ করে আগে আপনার ওয়ালেটে ব্যালেন্স রিচার্জ করুন:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Add Balance (রিচার্জ করুন)', 'add_balance_prompt')],
                    [Markup.button.callback('⬅️ Back to Checkout', 'pkg_1_35')]
                ])
            }
        );
    }

    // Check Stock Pool Availability for Instant Auto Delivery
    const isAvailable = await getPackageStockStatus(pkgKey);
    if (!isAvailable) {
        const outNotice = isReseller ?
            `⚠️ *রিসেলার স্টক সংক্রান্ত জরুরি নোটিশ* ⚠️\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `প্রিয় রিসেলার, এই মুহূর্তে আপনার সিলেক্ট করা প্রক্সি প্যাকেজের **স্টক অত্যন্ত কম/খালি রয়েছে!**\n\n` +
            `🚨 আপনার যদি বাল্ক (Bulk) বা জরুরি প্রক্সি সার্ভিসের প্রয়োজন হয়, তবে সরাসরি **Contact Support**-এ এডমিনের সাথে কথা বলুন। \n\n` +
            `এডমিন আপনাকে খুব দ্রুত প্রাইভেট স্টক বা বাল্ক প্রক্সি ব্যবস্থা করে দেওয়ার ব্যবস্থা করবেন। ❤️\n` +
            `━━━━━━━━━━━━━━━━━━` :
            `🚨 *স্টক সংক্রান্ত ইমার্জেন্সি অ্যালার্ট!* 🚨\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `দুঃখিত! আপনি যে প্রক্সি প্যাকেজটি সিলেক্ট করেছেন সেটির **স্টক বর্তমানে খালি/কম রয়েছে।**\n\n` +
            `📞 *আপনার যদি খুব বেশি ইমার্জেন্সি প্রক্সি প্রয়োজন হয়:* \n` +
            `তবে সরাসরি আমাদের **Contact Support**-এ অ্যাডমিনের সাথে কথা বলুন। অ্যাডমিন আপনাকে ইমার্জেন্সি স্টক ব্যবস্থা করে দিতে সাহায্য করবেন। ❤️\n` +
            `━━━━━━━━━━━━━━━━━━`;

        return ctx.reply(outNotice, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📞 Contact Support (জরুরি কথা বলুন)', 'support')],
                [Markup.button.callback('⬅️ Back to Packages', 'buy_options')]
            ])
        });
    }

    // Deduct Balance & Deliver Instantly!
    await db.deductBalanceFromUser(userId, finalPrice);
    const newBal = await db.getUserBalance(userId);
    const orderId = Math.floor(10000 + Math.random() * 90000);
    const buyerName = ctx.from.first_name || 'User';

    if (db.isConfigured()) {
        await db.createOrder({
            userId,
            name: buyerName,
            username: ctx.from.username || 'N/A',
            packageName: pName,
            method: 'Wallet Balance Instant',
            proof: `WALLET_PAY_${orderId}`,
            pricePaid: finalPrice
        });
        await db.updateOrderStatus(userId, 'Completed', 'Wallet Balance Delivered', 'Delivered');
    }

    // --- INSTANT AUTO DELIVERY ENGINE ---
    if (pkgKey === 'pkg_3') {
        const poppedIPs = await db.popStockForPlan3(userId, 10);
        let txtContent = `FREE PROXY — 10 IPs\n\n`;
        const proxyLines = poppedIPs.length === 10 ? poppedIPs : Array(10).fill('192.168.1.1:8080:user:pass');
        proxyLines.forEach((line, idx) => {
            const numStr = (idx + 1).toString().padStart(2, '0');
            txtContent += `${numStr}. ${line}\n`;
        });

        const filename = `free_proxy_10_${orderId}.txt`;
        const tempFilePath = path.join(os.tmpdir(), filename);
        fs.writeFileSync(tempFilePath, txtContent, 'utf-8');

        try {
            await ctx.telegram.sendDocument(
                userId,
                { source: tempFilePath, filename: filename },
                {
                    caption: `📦 **FREE PROXY — 10 IPs**\n📄 Your proxy list has been delivered successfully.\n\n💰 *Wallet Balance Deducted:* \`${finalPrice} TK\` | *Remaining Balance:* \`${newBal} TK\``,
                    parse_mode: 'Markdown'
                }
            );
        } catch (err) {
            console.error("Wallet doc delivery error:", err.message);
        } finally {
            try { fs.unlinkSync(tempFilePath); } catch (e) {}
        }
    } else if (pkgKey === 'pkg_2') {
        const proxyLine = (await db.popStockAccount(userId, 'pkg_2')) || '192.168.1.1:8080:user:pass';
        const deliveryMsg = `🟢 **ORDER SUCCESSFUL (INSTANT WALLET DELIVERED)**\n\n` +
                            `╔════════════════════╗\n` +
                            `🛒 **OWL PROXY 1 PIS**\n` +
                            `╚════════════════════╝\n\n` +
                            `╭──────────────────╮\n` +
                            `│ 🆔 ORDER \`#${orderId}\`\n` +
                            `│ 📦 PLAN \`200MB\`\n` +
                            `│ 🌐 PROXY \`${proxyLine}\`\n` +
                            `│ 💰 REMAINING BAL \`${newBal} TK\`\n` +
                            `╰──────────────────╯`;

        try {
            await ctx.telegram.sendMessage(userId, deliveryMsg, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`🌐 Copy Proxy: ${proxyLine}`, `copy_pass_${proxyLine}`)]
                ])
            });
        } catch (err) {}
    } else {
        const accountLine = (await db.popStockAccount(userId, 'pkg_1')) || 'user@gmail.com:pass123';
        let emailVal = accountLine;
        let passVal = '123456';
        if (accountLine.includes(':')) {
            const parts = accountLine.split(':');
            emailVal = parts[0].trim();
            passVal = parts[1].trim();
        }

        const deliveryMsg = `🟢 **ORDER SUCCESSFUL (INSTANT WALLET DELIVERED)**\n\n` +
                            `╔════════════════════╗\n` +
                            `🛒 **OWL PROXY ACCOUNT**\n` +
                            `╚════════════════════╝\n\n` +
                            `╭──────────────────╮\n` +
                            `│ 🆔 ORDER \`#${orderId}\`\n` +
                            `│ 📦 PLAN \`200MB\`\n` +
                            `│ 📧 EMAIL \`${emailVal}\`\n` +
                            `│ 🔑 PASS \`${passVal}\`\n` +
                            `│ 💰 REMAINING BAL \`${newBal} TK\`\n` +
                            `╰──────────────────╯`;

        try {
            await ctx.telegram.sendMessage(userId, deliveryMsg, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`📧 Copy Email`, `copy_email_${emailVal}`)],
                    [Markup.button.callback(`🔑 Copy Pass`, `copy_pass_${passVal}`)],
                    [Markup.button.callback(`🔑 Request Login Code`, `req_login_code_${userId}`)]
                ])
            });
        } catch (err) {}
    }

    // --- POST GROUP RECEIPT ---
    try {
        const groupMsg = `🟢 **NEW COMPLETED ORDER**\n\n` +
                         `╔════════════════════╗\n` +
                         `🛒 **${pName.toUpperCase()}**\n` +
                         `╚════════════════════╝\n\n` +
                         `╭──────────────────╮\n` +
                         `│ 👤 BUYER \`${buyerName.substring(0, 2)}***\`\n` +
                         `│ 🆔 ORDER \`#${orderId}\`\n` +
                         `│ 💰 PAID \`${finalPrice} TK\` (Wallet Instant)\n` +
                         `╰──────────────────╯\n\n` +
                         `📡 STATUS → 🟢 **INSTANT DELIVERED**\n\n` +
                         `> 🚀 **OWL PROXY BOT**`;

        const botUsername = ctx.botInfo ? ctx.botInfo.username : 'OWLProxyBot';
        const botUrl = `https://t.me/${botUsername}`;

        const groupSent = await ctx.telegram.sendMessage(parseInt(GROUP_ID), groupMsg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🛒 BUY PROXY / START BOT 🚀', botUrl)]
            ])
        });
        if (groupSent && groupSent.message_id) {
            await addAutoReactions(ctx.telegram, GROUP_ID, groupSent.message_id);
        }
    } catch (e) {}

    // Alert Admin
    await notifyAllAdmins(ctx.telegram, `⚡ *Instant Auto-Delivery via Wallet Balance!*\n\n• *User:* ${buyerName} (\`${userId}\`)\n• *Package:* ${pName}\n• *Price:* ${finalPrice} TK\n• *New Balance:* ${newBal} TK`);

    return ctx.reply(`✅ *অর্ডার সফলভাবে ওয়ালেট ব্যালেন্স থেকে ইনস্ট্যান্ট ডেলিভারি করা হয়েছে!* \n\nবর্তমান ব্যালেন্স: \`${newBal} TK\``, { parse_mode: 'Markdown' });
});

bot.action('add_balance_prompt', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    await updateUserSession(userId, { waitingFor: 'balance_amount' });

    return ctx.reply(
        "💳 *বট ওয়ালেট ব্যালেন্স রিচার্জ করুন:*\n\n" +
        "আপনি আপনার ওয়ালেটে কত টাকা জমা করতে চান (টাকায়) লিখে পাঠান (যেমন: `500` বা `1000`):\n\n" +
        "*(জমানো ব্যালেন্স দিয়ে যেকোটাই প্রক্সি ইনস্ট্যান্ট ১-সেকেন্ডে অটো-ডেলিভারিতে কিনতে পারবেন)*",
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'main_menu')]])
        }
    );
});

bot.action('admin_manage_resellers', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const resellers = await db.getResellerList();
    const price1 = await db.getResellerPrice('pkg_1');
    const price2 = await db.getResellerPrice('pkg_2');
    const price3 = await db.getResellerPrice('pkg_3');

    const msg = `👔 *Reseller Management & Pricing Panel* 👔\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `• 👥 *Total Verified Resellers:* *${resellers.length}* জন\n\n` +
                `🏷️ *Current Reseller Rates:*\n` +
                `• 1️⃣ Plan 1 (OWL Proxy Account): *${price1} TK* (Regular 35 TK)\n` +
                `• 2️⃣ Plan 2 (OWL Proxy 1 Pis): *${price2} TK* (Regular 30 TK)\n` +
                `• 3️⃣ Plan 3 (FREE PROXY 10 IPs): *${price3} TK* (Regular 20 TK)\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +
                `নিচের বাটনগুলো ব্যবহার করে নতুন রিসেলার যোগ, রেট পরিবর্তন বা ব্যালেন্স ম্যানেজ করুন:`;

    return ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Add New Reseller', 'admin_add_reseller_prompt')],
            [Markup.button.callback('📋 View All Resellers', 'admin_list_resellers')],
            [Markup.button.callback('🏷️ Set Reseller Prices', 'admin_set_reseller_prices_menu')],
            [Markup.button.callback('🗑 Remove Reseller', 'admin_remove_reseller_menu')],
            [Markup.button.callback('⬅️ Back to Control Panel', 'open_admin_mgmt_menu')]
        ])
    });
});

bot.action('admin_add_reseller_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_new_reseller_id' });

    return ctx.reply(
        "✍️ *নতুন Reseller যোগ করুন:*\n\n" +
        "যাকে রিসেলার হিসেবে যোগ করতে চান তার **Telegram User ID** অথবা **Username** (@username) লিখে পাঠান:\n\n" +
        "*(রিসেলার হওয়ার পর তিনি বটের সকল প্যাকেজে কম দামে কেনাকাটা ও ওয়ালেট ব্যালেন্স ব্যবহারের সুবিধা পাবেন)*",
        { parse_mode: 'Markdown' }
    );
});

bot.action('admin_list_resellers', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const resellers = await db.getResellerList();
    let text = `👔 *Verified Resellers List (Total: ${resellers.length})* 👔\n` +
               `━━━━━━━━━━━━━━━━━━\n`;

    if (resellers.length === 0) {
        text += `*(বর্তমানে কোনো রিসেলার যোগ করা নেই)*`;
    } else {
        resellers.forEach((id, idx) => {
            text += `${idx + 1}. User ID: \`${id}\`\n`;
        });
    }

    return ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Reseller Panel', 'admin_manage_resellers')]])
    });
});

bot.action('admin_remove_reseller_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const resellers = await db.getResellerList();
    if (resellers.length === 0) {
        return ctx.reply("❌ রিমুভ করার মতো কোনো রিসেলার নেই।");
    }

    const buttons = resellers.map(id => [
        Markup.button.callback(`🗑 Remove Reseller ID: ${id}`, `remove_reseller_${id}`)
    ]);
    buttons.push([Markup.button.callback('⬅️ Back to Reseller Panel', 'admin_manage_resellers')]);

    return ctx.reply("🗑 *যে রিসেলারকে রিমুভ করতে চান নিচে নির্বাচন করুন:*", {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
    });
});

bot.action(/^remove_reseller_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const targetId = ctx.match[1];
    await ctx.answerCbQuery();

    await db.removeResellerUser(targetId);
    await ctx.reply(`✅ Reseller ID \`${targetId}\` কে সফলভাবে রিমুভ করা হয়েছে!`, { parse_mode: 'Markdown' });
    return showAdminManagementMenu(ctx);
});

bot.action('admin_set_reseller_prices_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const price1 = await db.getResellerPrice('pkg_1');
    const price2 = await db.getResellerPrice('pkg_2');
    const price3 = await db.getResellerPrice('pkg_3');

    const msg = `🏷️ *Set Custom Reseller Prices* 🏷️\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `• 1️⃣ Plan 1 (OWL Proxy Account): *${price1} TK*\n` +
                `• 2️⃣ Plan 2 (OWL Proxy 1 Pis): *${price2} TK*\n` +
                `• 3️⃣ Plan 3 (FREE PROXY 10 IPs): *${price3} TK*\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +
                `নিচে ক্লিক করে যে প্যাকেজের দাম পরিবর্তন করতে চান বেছে নিন:`;

    return ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback(`1️⃣ Set Plan 1 Reseller Price (Now: ${price1} TK)`, 'edit_rprice_pkg_1')],
            [Markup.button.callback(`2️⃣ Set Plan 2 Reseller Price (Now: ${price2} TK)`, 'edit_rprice_pkg_2')],
            [Markup.button.callback(`3️⃣ Set Plan 3 Reseller Price (Now: ${price3} TK)`, 'edit_rprice_pkg_3')],
            [Markup.button.callback('⬅️ Back to Reseller Panel', 'admin_manage_resellers')]
        ])
    });
});

bot.action(/^edit_rprice_(pkg_\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const pkgKey = ctx.match[1];
    const adminId = ctx.from.id.toString();

    await updateAdminSession(adminId, { step: 'waiting_for_reseller_price', extraData: pkgKey });
    return ctx.reply(`✍️ [${pkgKey}] এর জন্য নতুন রিসেলার মূল্য (টাকায়) টাইপ করে পাঠান (যেমন: 28):`, { parse_mode: 'Markdown' });
});

bot.action(/^approve_topup_(.+)_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];
    const amount = parseInt(ctx.match[2]);

    const newBal = await db.addBalanceToUser(targetUserId, amount);

    try {
        await ctx.telegram.sendMessage(
            targetUserId,
            `🎉 *অ্যাপ্রুভড! আপনার ওয়ালেট ব্যালেন্স রিচার্জ সফল হয়েছে!* \n\n` +
            `• *যোগ করা হয়েছে:* \`${amount} TK\`\n` +
            `• *বর্তমান মোট ওয়ালেট ব্যালেন্স:* \`${newBal} TK\`\n\n` +
            `এখন থেকে আপনি পেমেন্টে Wallet Balance সিলেক্ট করে ১-সেকেন্ডে অটো-ডেলিভারি নিতে পারবেন! 🚀`,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {}

    return ctx.reply(`✅ Successfully added ${amount} TK balance to user (${targetUserId})! New Balance: ${newBal} TK`);
});

bot.action('admin_manage_admins', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const extraAdmins = await db.getExtraAdmins();
    const count = extraAdmins.length;

    const msg = `👑 *Multi-Admin Management Panel* 👑\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `• 🌟 *Super Admin (Owner):* \`${ADMIN_ID}\`\n` +
                `• 👥 *Sub-Admins Added:* *${count}* জন\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +
                `এডমিন তালিকায় থাকা সবাই নতুন অর্ডার কনফার্ম করতে, স্টক যোগ করতে, কাস্টমার চ্যাটে রিপ্লাই দিতে এবং কোড প্রোভাইড করতে পারবেন।`;

    return ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Add New Sub-Admin', 'admin_add_admin_prompt')],
            [Markup.button.callback('📋 View All Sub-Admins', 'admin_list_admins')],
            [Markup.button.callback('🗑 Remove Sub-Admin', 'admin_remove_admin_menu')],
            [Markup.button.callback('⬅️ Back to Control Panel', 'open_admin_mgmt_menu')]
        ])
    });
});

bot.action('admin_add_admin_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    if (!isSuperAdmin(ctx)) {
        return ctx.answerCbQuery("❌ শুধুমাত্র Super Admin (Owner) নতুন এডমিন যোগ বা রিমুভ করতে পারবেন!", { show_alert: true });
    }
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_new_admin_id' });

    return ctx.reply(
        "✍️ *নতুন Sub-Admin যোগ করুন:*\n\n" +
        "নতুন এডমিন হিসেবে যাকে যোগ করতে চান তার **Telegram User ID** অথবা **Username** (@username) লিখে পাঠান:\n\n" +
        "*(ইউজারকে আগে বটে /start দিতে বলবেন যাতে তিনি নোটিফিকেশন পান)*",
        { parse_mode: 'Markdown' }
    );
});

bot.action('admin_list_admins', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const extraAdmins = await db.getExtraAdmins();
    let text = `👑 *All Bot Admins List* 👑\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `• 🌟 *Super Admin (Owner):* \`${ADMIN_ID}\`\n\n` +
               `👥 *Sub-Admins List:* \n`;

    if (extraAdmins.length === 0) {
        text += `*(কোনো অতিরিক্ত Sub-Admin যোগ করা নেই)*`;
    } else {
        extraAdmins.forEach((id, idx) => {
            text += `${idx + 1}. User ID: \`${id}\`\n`;
        });
    }

    return ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Admin Panel', 'admin_manage_admins')]])
    });
});

bot.action('admin_remove_admin_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    if (!isSuperAdmin(ctx)) {
        return ctx.answerCbQuery("❌ শুধুমাত্র Super Admin (Owner) এডমিন রিমুভ করতে পারবেন!", { show_alert: true });
    }
    await ctx.answerCbQuery();

    const extraAdmins = await db.getExtraAdmins();
    if (extraAdmins.length === 0) {
        return ctx.reply("❌ রিমুভ করার মতো কোনো Sub-Admin নেই।");
    }

    const buttons = extraAdmins.map(id => [
        Markup.button.callback(`🗑 Remove ID: ${id}`, `remove_subadmin_${id}`)
    ]);
    buttons.push([Markup.button.callback('⬅️ Back to Admin Panel', 'admin_manage_admins')]);

    return ctx.reply("🗑 *যে Sub-Admin কে রিমুভ করতে চান নিচে নির্বাচন করুন:*", {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
    });
});

bot.action(/^remove_subadmin_(.+)$/, async (ctx) => {
    if (!isSuperAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const targetId = ctx.match[1];
    await ctx.answerCbQuery();

    await db.removeExtraAdmin(targetId);
    await updateAdminCache();

    await ctx.reply(`✅ Sub-Admin ID \`${targetId}\` কে সফলভাবে রিমুভ করা হয়েছে!`, { parse_mode: 'Markdown' });
    return showAdminManagementMenu(ctx);
});

bot.action('stock_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const stock1 = (await db.getAllStockAccounts('pkg_1')).filter(i => i.available).length;
    const stock2 = (await db.getAllStockAccounts('pkg_2')).filter(i => i.available).length;
    const stock3 = (await db.getAllStockAccounts('pkg_3')).filter(i => i.available).length;

    const stockText = `📦 *OWL Proxy Stock Management Pool* 📦\n` +
                      `━━━━━━━━━━━━━━━━━━\n` +
                      `• 1️⃣ *Plan 1 (Gmail & Pass):* *${stock1}* Items ${stock1 > 0 ? '🟢' : '🔴 (Out of stock)'}\n` +
                      `• 2️⃣ *Plan 2 (IP:PORT:USER:PASS):* *${stock2}* Items ${stock2 > 0 ? '🟢' : '🔴 (Out of stock)'}\n` +
                      `• 3️⃣ *Plan 3 (FREE PROXY IPs):* *${stock3}* IPs ${stock3 >= 10 ? '🟢 (' + Math.floor(stock3 / 10) + ' Orders Ready)' : '🔴 (Out of stock)'}\n` +
                      `━━━━━━━━━━━━━━━━━━\n\n` +
                      `আপলোড বাটন সিলেক্ট করে মেসজে সরাসরি লিখে **অথবা .txt ফাইল সেন্ড করে** একবারে একাধিক স্টক আপলোড করতে পারেন।`;

    return ctx.editMessageText(stockText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📥 Add Stock: Plan 1 (Gmail & Pass)', 'add_stock_pkg_1')],
            [Markup.button.callback('📥 Add Stock: Plan 2 (IP:PORT:USER:PASS)', 'add_stock_pkg_2')],
            [Markup.button.callback('📥 Add Stock: Plan 3 (FREE PROXY IPs)', 'add_stock_pkg_3')],
            [Markup.button.callback('📋 View Available Stock', 'view_stock_accounts')],
            [Markup.button.callback('📥 Download Stock Backup (.txt)', 'download_stock_txt')],
            [Markup.button.callback('🗑 Clear Available Stock', 'clear_stock_prompt')],
            [Markup.button.callback('⬅️ Back to Control Panel', 'bot_control_back')]
        ])
    });
});

bot.action(/^add_stock_(pkg_\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const pkgType = ctx.match[1];
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_stock_bulk_add', extraData: pkgType });

    let planTitle = "Plan 1 (Gmail & Pass)";
    let sampleFormat = "email1@gmail.com:pass123\nemail2@gmail.com:pass456";
    if (pkgType === 'pkg_2') {
        planTitle = "Plan 2 (IP:PORT:USER:PASS)";
        sampleFormat = "192.168.1.1:8080:username:password\n192.168.1.2:8080:username:password";
    } else if (pkgType === 'pkg_3') {
        planTitle = "Plan 3 (FREE PROXY IPs)";
        sampleFormat = "192.168.1.1:8080:username:password\n192.168.1.2:8080:username:password\n...";
    }

    return ctx.reply(
        `📦 *OWL Proxy [${planTitle}] স্টক যুক্ত করুন:*\n\n` +
        `এক সাথে এক বা একাধিক স্টক চ্যাটে লিখে **অথবা একটি \`.txt\` ফাইল আপলোড করে** পাঠান (প্রতি লাইনে একটি করে):\n\n` +
        `**উদাহরণ:**\n` +
        `\`${sampleFormat}\``,
        { parse_mode: 'Markdown' }
    );
});

bot.action('add_stock_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_stock_bulk_add', extraData: 'pkg_1' });

    return ctx.reply(
        "📦 *OWL Proxy স্টক অ্যাকাউন্ট যুক্ত করুন:*\n\n" +
        "এক সাথে এক বা একাধিক OWL Proxy আইডি/ইমেইল চ্যাটে মেসেজ আকারে **অথবা একটি `.txt` ফাইল আপলোড করে** পাঠান (প্রতি লাইনে একটি করে):\n\n" +
        "**উদাহরণ:**\n" +
        "`email1@gmail.com:pass123`\n" +
        "`email2@gmail.com:pass456`",
        { parse_mode: 'Markdown' }
    );
});

bot.action('view_stock_accounts', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const allStock = await db.getAllStockAccounts();
    const available = allStock.filter(i => i.available);

    if (available.length === 0) {
        return ctx.reply("📦 *Stock Status:* বর্তমানে কোনো অব্যবহৃত স্টক খালি নেই।", { parse_mode: 'Markdown' });
    }

    const previewLimit = 25;
    const previewList = available.slice(0, previewLimit);

    let text = `📦 *Available Stock Accounts (Total: ${available.length} টি)* 📦\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               (available.length > previewLimit ? `*(প্রথম ${previewLimit} টি প্রদর্শন করা হলো, বাকিগুলো দেখতে নিচে .txt ডাউনলোড বাটন ব্যবহার করুন)*\n\n` : `\n`);

    previewList.forEach((item, index) => {
        text += `${index + 1}. \`${item.data}\`\n`;
    });

    return ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📥 Download Full Stock List (.txt)', 'download_stock_txt')],
            [Markup.button.callback('⬅️ Back to Stock Manager', 'stock_menu')]
        ])
    });
});

bot.action('download_stock_txt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery("Generating stock file...");

    const allStock = await db.getAllStockAccounts();
    const available = allStock.filter(i => i.available);

    if (available.length === 0) {
        return ctx.reply("❌ ডাউনলোডের জন্য কোনো অব্যবহৃত স্টক খালি নেই।");
    }

    let fileContent = available.map(i => i.data).join('\n');
    const buffer = Buffer.from(fileContent, 'utf-8');

    return await ctx.replyWithDocument(
        { source: buffer, filename: `available_stock_${available.length}_items.txt` },
        { caption: `📦 *OWL Proxy Available Stock Backup (${available.length} items)*`, parse_mode: 'Markdown' }
    );
});

bot.action('admin_search_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_search_query' });

    return ctx.reply(
        "🔍 *Search Order or User Profile:*\n\n" +
        "অনুগ্রহ করে কাস্টমারের **User ID**, **Username** (@username), অথবা **Order ID** লিখে পাঠান:",
        { parse_mode: 'Markdown' }
    );
});

bot.action('admin_top_vip_buyers', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const vipList = await db.getTopVIPBuyers();

    let text = `👑 *Top VIP Customers Leaderboard* 👑\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `সবচেয়ে বেশি টাকার কেনাকাটা করা সেরা ১০ জন ভিআইপি গ্রাহকদের তালিকা:\n\n`;

    if (vipList.length === 0) {
        text += `> ❌ বর্তমানে কোনো ডেলিভারড অর্ডারের রেকর্ড পাওয়া যায়নি।`;
    } else {
        vipList.forEach((item, index) => {
            let medal = "👤";
            if (index === 0) medal = "🥇";
            else if (index === 1) medal = "🥈";
            else if (index === 2) medal = "🥉";

            text += `${medal} *#${index + 1}* - ${item.name} (@${item.username})\n` +
                    `   ├─ User ID: \`${item.userId}\`\n` +
                    `   ├─ Total Orders: *${item.count}* টি\n` +
                    `   └─ Total Spent: *${item.totalSpent} TK*\n\n`;
        });
    }

    return ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Control Panel', 'open_admin_mgmt_menu')]])
    });
});

bot.action('admin_full_db_backup', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery("Generating full database backup...");

    const backupData = await db.getFullDatabaseBackupData();
    const jsonString = JSON.stringify(backupData, null, 2);
    const buffer = Buffer.from(jsonString, 'utf-8');

    const dateStr = new Date().toISOString().split('T')[0];

    return await ctx.replyWithDocument(
        { source: buffer, filename: `full_bot_backup_${dateStr}.json` },
        {
            caption: `💾 *OWL PROXY BOT Bot - Full System Backup*\n\n` +
                     `• Date: \`${dateStr}\`\n` +
                     `• Total Users: *${backupData.totalUsersCount || 0}*\n` +
                     `• Total Orders: *${backupData.totalOrdersCount || 0}*\n\n` +
                     `আপনার ডাটাবেজের সম্পূর্ণ ব্যাকআপ জেনারেট করে পাঠানো হয়েছে।`,
            parse_mode: 'Markdown'
        }
    );
});

bot.action('clear_stock_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const allStock = await db.getAllStockAccounts();
    const available = allStock.filter(i => i.available);

    for (const item of available) {
        await db.deleteStockAccount(item.code);
    }

    await ctx.reply("✅ সকল অব্যবহৃত স্টক অ্যাকাউন্ট সফলভাবে মুছে ফেলা হয়েছে!");
    return showBotControlPanel(ctx);
});

bot.action('edit_reaction_counts_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const counts = await getReactionCounts();
    await updateAdminSession(userId, { step: 'waiting_for_reaction_counts' });
    const msg = `🎭 *Set Custom Group Reaction Counts*\n\n` +
                `বর্তমান কনফিগারেশন:\n` +
                `• ❤️ Heart: \`${counts.heart}\`\n` +
                `• 👌 OK: \`${counts.ok}\`\n` +
                `• 🫡 Salute: \`${counts.salute}\`\n` +
                `• ⭐ Star Rating: \`${counts.star}\`\n\n` +
                `📝 কমা (,) দিয়ে নতুন সংখ্যাসমূহ লিখে পাঠান:\n` +
                `উদাহরণ: \`25, 14, 67, 4.9\`\n` +
                `(ক্রম অনুযায়ী: ❤️ Heart, 👌 OK, 🫡 Salute, ⭐ Rating)`;
    return ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.action('wallets_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    
    const walletsText = `💳 *Wallet Numbers Update Panel* 💳\n\n` +
                        `নিচের বাটনগুলো থেকে পেমেন্ট মেথড সিলেক্ট করে নতুন নাম্বার/আইডি দিন:`;
                        
    return ctx.editMessageText(walletsText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🇧🇩 Edit bKash', 'edit_wallet_bkash'), Markup.button.callback('🇧🇩 Edit Nagad', 'edit_wallet_nagad')],
            [Markup.button.callback('🌐 Edit Binance', 'edit_wallet_binance'), Markup.button.callback('🌐 Edit Payoneer', 'edit_wallet_payoneer')],
            [Markup.button.callback('⬅️ Back to Control Panel', 'bot_control_back')]
        ])
    });
});

bot.action('bot_control_back', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showBotControlPanel(ctx);
});

bot.action(/^edit_wallet_(bkash|nagad|binance|payoneer)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    
    const type = ctx.match[1];
    const adminId = ctx.from.id.toString();
    
    await updateAdminSession(adminId, { step: `waiting_for_wallet_${type}` });
    
    return ctx.reply(`✍️ অনুগ্রহ করে নতুন *${type.toUpperCase()}* নাম্বার বা আইডিটি লিখে পাঠান:`, { parse_mode: 'Markdown' });
});

bot.action('maintenance_toggle', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await getMaintenanceMode();
    await setMaintenanceMode(!current);
    await ctx.answerCbQuery(`Bot status changed to ${!current ? 'OFF' : 'ON'}!`);
    return showBotControlPanel(ctx);
});

bot.action('notice_toggle', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await getNoticeStatus();
    await setNoticeStatus(!current);
    await ctx.answerCbQuery(`Highlight notice changed to ${!current ? 'ENABLED' : 'DISABLED'}!`);
    return showBotControlPanel(ctx);
});

bot.action('notice_edit_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_notice_text' });
    return ctx.reply("📢 অনুগ্রহ করে নতুন নোটিশ/ঘোষণা মেসেজটি লিখে পাঠান (Markdown ফরম্যাট সাপোর্ট করবে):");
});

bot.action('fake_sales_toggle', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await getFakeSalesStatus();
    await setFakeSalesStatus(!current);
    await ctx.answerCbQuery(`Fake sales posting changed to ${!current ? 'ENABLED' : 'DISABLED'}!`);
    return showBotControlPanel(ctx);
});

bot.action('trigger_fake_sale_now', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery("Posting fake sale to group now...");
    try {
        await sendFakeSaleToGroup(true);
        return ctx.reply(`✅ *গ্রুপে (ID: \`${GROUP_ID}\`) টেস্ট ফেইক সেলস সফলভাবে পাঠানো হয়েছে!*`, { parse_mode: 'Markdown' });
    } catch (err) {
        return ctx.reply(`❌ *গ্রুপে মেসেজ পাঠানো ব্যর্থ হয়েছে:*\n\`${err.message}\``, { parse_mode: 'Markdown' });
    }
});

bot.action('toggle_allow_custom_email', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await db.getAllowCustomEmailStatus();
    await db.setAllowCustomEmailStatus(!current);
    await ctx.answerCbQuery(`User email choice mode changed to ${!current ? 'ENABLED' : 'DISABLED'}!`);
    return showBotControlPanel(ctx);
});

// Text / Input Handler / Document Handler
bot.on(['text', 'photo', 'document'], async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message ? ctx.message.text : null;

    if (isAdmin(ctx)) {
        if (text) {
            if (text === '/admin') {
                return showAdminManagementMenu(ctx);
            }
            if (text.includes('Pending Orders')) {
                return showPendingOrdersMenu(ctx);
            } 
            if (text.includes('Total Bot Users')) {
                return showTotalUsersStats(ctx);
            }
            if (text.includes('Close Admin Panel')) {
                return ctx.reply("👑 Admin Panel Closed.", Markup.removeKeyboard());
            }
            if (text.includes('Broadcast')) {
                await updateAdminSession(userId, { step: 'waiting_for_broadcast' });
                return ctx.reply("📢 আপনার ব্রডকাস্ট মেসেজটি (লেখা বা ছবি) পাঠান যা সকল বটের ইউজারের কাছে পাঠানো হবে:");
            }
            if (text.includes('Sales Report')) {
                const stats = await getSalesReportStats();
                const reportText = 
                    `📊 *OWL Proxy Bot Sales Report* 📊\n\n` +
                    `• Total Completed Sales: *${stats.totalCount}*\n` +
                    `• Total Revenue: *${stats.totalRevenue} TK*\n\n` +
                    `• Today's Sales: *${stats.todayRevenue} TK*\n` +
                    `• This Month's Sales: *${stats.monthRevenue} TK*\n\n` +
                    `❤️ Keep hustling! Keep selling! 🚀`;
                return ctx.reply(reportText, { 
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('📥 Download CSV Report', 'download_sales_csv')]
                    ])
                });
            }
            if (text.includes('Coupons')) {
                return showCouponsMenu(ctx);
            }
            if (text.includes('Bot Control')) {
                return showBotControlPanel(ctx);
            }
        }

        const adminSession = await getAdminSession(userId);
        if (adminSession && adminSession.step) {
            const state = adminSession.step;
            const targetUser = adminSession.targetUserId;
            const extraData = adminSession.extraData;

            if (state === 'waiting_for_reaction_counts' && text) {
                await clearAdminSession(userId);
                const parts = text.split(',').map(p => p.trim());
                if (parts.length >= 3) {
                    const heart = parseInt(parts[0]) || 25;
                    const ok = parseInt(parts[1]) || 14;
                    const salute = parseInt(parts[2]) || 67;
                    const star = parts[3] ? parts[3] : '4.9';

                    await setReactionCounts({ heart, ok, salute, star });
                    await ctx.reply(`✅ *গ্রুপ রিয়্যাকশন সংখ্যা সফলভাবে আপডেট করা হয়েছে!*\n\n` +
                                    `• ❤️ Heart: \`${heart}\`\n` +
                                    `• 👌 OK: \`${ok}\`\n` +
                                    `• 🫡 Salute: \`${salute}\`\n` +
                                    `• ⭐ Rating: \`${star}\``, { parse_mode: 'Markdown' });
                    return showBotControlPanel(ctx);
                } else {
                    return ctx.reply("❌ ভুল ফরম্যাট! উদাহরণ অনুযায়ী কমা (,) দিয়ে লিখুন: `25, 14, 67, 4.9`", { parse_mode: 'Markdown' });
                }
            }

            if (state === 'waiting_for_broadcast') {
                await clearAdminSession(userId);
                const userList = await getUserIdsForBroadcast();
                
                if (userList.length === 0) {
                    return ctx.reply("❌ ব্রডকাস্ট করার জন্য কোনো ইউজার পাওয়া যায়নি।");
                }

                await ctx.reply(`📢 ব্রডকাস্ট পাঠানো শুরু হয়েছে... মোট ইউজার: ${userList.length} জন।`);
                let success = 0;
                let fail = 0;

                for (const uId of userList) {
                    try {
                        await ctx.telegram.copyMessage(uId, ctx.chat.id, ctx.message.message_id);
                        success++;
                    } catch (err) {
                        fail++;
                    }
                }
                
                return ctx.reply(
                    `📢 *Broadcast Completed!* \n\n` +
                    `✅ সফলভাবে পাঠানো হয়েছে: *${success}* জনের কাছে\n` +
                    `❌ ব্যর্থ হয়েছে: *${fail}* জনের কাছে (বট ব্লক করার কারণে হতে পারে)`,
                    { parse_mode: 'Markdown' }
                );
            }

            if (state === 'waiting_for_search_query' && text) {
                await clearAdminSession(userId);
                const query = text.trim().replace('@', '');
                
                let foundUser = null;
                let userOrders = [];

                if (db.isConfigured()) {
                    const allUsers = (await db.getAllUsers()) || [];
                    foundUser = allUsers.find(u => u.user_id.toString() === query || (u.username && u.username.toLowerCase() === query.toLowerCase()));
                    const targetId = foundUser ? foundUser.user_id.toString() : query;
                    userOrders = (await db.getUserOrders(targetId)) || [];

                    if (!foundUser && userOrders.length === 0) {
                        const allOrders = (await db.getAllOrders()) || [];
                        const matchOrder = allOrders.find(o => String(o.id) === query);
                        if (matchOrder) {
                            userOrders = [matchOrder];
                            foundUser = allUsers.find(u => u.user_id.toString() === matchOrder.user_id.toString());
                        }
                    }
                }

                const targetId = foundUser ? foundUser.user_id.toString() : query;
                const isBanned = await db.isUserBanned(targetId);
                const balance = await db.getUserBalance(targetId);

                let resultMsg = `🔍 *Search Results for "${query}"*\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `👤 *Name:* ${foundUser ? foundUser.first_name : 'N/A'}\n` +
                                `🔗 *Username:* @${foundUser && foundUser.username ? foundUser.username : 'N/A'}\n` +
                                `🆔 *User ID:* \`${targetId}\`\n` +
                                ` Status: ${isBanned ? '⛔ **Banned**' : '🟢 **Active**'}\n` +
                                `💰 *Balance:* \`${balance} TK\`\n` +
                                `🛍 *Total Orders Found:* *${userOrders.length}*\n` +
                                `━━━━━━━━━━━━━━━━━━\n\n`;

                if (userOrders.length > 0) {
                    resultMsg += `📋 *Delivered Orders / Account Records:*\n`;
                    userOrders.slice(0, 10).forEach((ord, index) => {
                        resultMsg += `${index + 1}. Package: *${ord.package_name || ord.packageName}* | Status: *${ord.status}*\n`;
                        if (ord.custom_email || ord.customEmail) {
                            resultMsg += `   └─ 📧 Email: \`${ord.custom_email || ord.customEmail}\`\n`;
                        }
                        if (ord.custom_pass || ord.customPass) {
                            resultMsg += `   └─ 🔑 Pass: \`${ord.custom_pass || ord.customPass}\`\n`;
                        }
                    });
                } else {
                    resultMsg += `> ❌ কোনো পূর্বাভিজ্ঞ অর্ডারের তথ্য পাওয়া যায়নি।`;
                }

                return ctx.reply(resultMsg, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Control Panel', 'open_admin_mgmt_menu')]])
                });
            }

            if (state === 'waiting_for_stock_bulk_add') {
                const targetPkg = adminSession ? (adminSession.extraData || 'pkg_1') : 'pkg_1';
                let rawContent = text;
                if (ctx.message && ctx.message.document) {
                    try {
                        const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
                        const response = await fetch(fileLink.href);
                        rawContent = await response.text();
                    } catch (e) {
                        return ctx.reply(`❌ .txt ফাইল পড়তে সমস্যা হয়েছে: ${e.message}`);
                    }
                }

                if (rawContent && rawContent.trim()) {
                    await clearAdminSession(userId);
                    const lines = rawContent.trim().split(/\r?\n/);
                    let count = 0;
                    for (const line of lines) {
                        if (line.trim()) {
                            await db.addStockAccount(line.trim(), targetPkg);
                            count++;
                        }
                    }

                    let planLabel = "Plan 1 (Gmail & Pass)";
                    if (targetPkg === 'pkg_2') planLabel = "Plan 2 (IP:PORT:USER:PASS)";
                    if (targetPkg === 'pkg_3') planLabel = "Plan 3 (FREE PROXY IPs)";

                    await ctx.reply(`✅ সফলভাবে *${count}* টি আইটেম [${planLabel}] স্টকে যোগ করা হয়েছে!`, { parse_mode: 'Markdown' });
                    return showBotControlPanel(ctx);
                }
            }

            if (state === 'waiting_for_new_admin_id' && text) {
                if (!isSuperAdmin(ctx)) {
                    await clearAdminSession(userId);
                    return ctx.reply("❌ শুধুমাত্র Super Admin (Owner) নতুন এডমিন যোগ করতে পারবেন!");
                }

                await clearAdminSession(userId);
                const query = text.trim();
                let targetId = query.replace('@', '');

                const allUsers = (await db.getAllUsers()) || [];
                const userObj = allUsers.find(u => u.user_id.toString() === targetId || (u.username && u.username.toLowerCase() === targetId.toLowerCase()));
                if (userObj) {
                    targetId = userObj.user_id.toString();
                }

                await db.addExtraAdmin(targetId);
                await updateAdminCache();

                try {
                    await ctx.telegram.sendMessage(
                        targetId,
                        `🎉 *অভিনন্দন! আপনাকে OWL PROXY BOT এর নতুন Sub-Admin হিসেবে নিযুক্ত করা হয়েছে!* \n\n` +
                        `এখন থেকে আপনিও বটের পেমেন্ট ভেরিফাই, স্টক যোগ, সাপোর্ট রিপ্লাই ও অন্যান্য কাজ পরিচালনা করতে পারবেন।`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) {}

                await ctx.reply(`✅ ইউজার (\`${targetId}\`) কে সফলভাবে নতুন Sub-Admin হিসেবে যোগ করা হয়েছে!`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_new_reseller_id' && text) {
                await clearAdminSession(userId);
                const query = text.trim();
                let targetId = query.replace('@', '');

                const allUsers = (await db.getAllUsers()) || [];
                const userObj = allUsers.find(u => u.user_id.toString() === targetId || (u.username && u.username.toLowerCase() === targetId.toLowerCase()));
                if (userObj) {
                    targetId = userObj.user_id.toString();
                }

                await db.addResellerUser(targetId);

                try {
                    const resellerEmoji = await getItemEmojiTag('RESELLER_BADGE', '👔');
                    const crownEmoji = await getItemEmojiTag('VIP_CROWN', '👑');
                    await ctx.telegram.sendMessage(
                        targetId,
                        `🎉 ${crownEmoji} *অভিনন্দন! আপনাকে OWL PROXY BOT এর Verified Reseller ${resellerEmoji} হিসেবে নিযুক্ত করা হয়েছে!* \n\n` +
                        `এখন থেকে আপনি বটের সকল প্যাকেজে বিশেষ রিসেলার পাইকারি ছাড় এবং Wallet Balance দিয়ে ১-সেকেন্ডে অটো-ডেলিভারি সুবিধা পাবেন! 🚀`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) {}

                await ctx.reply(`✅ ইউজার (\`${targetId}\`) কে সফলভাবে নতুন Reseller হিসেবে যোগ করা হয়েছে!`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_reseller_price' && text) {
                const newPrice = parseInt(text.trim());
                const pkgKey = adminSession ? (adminSession.extraData || 'pkg_1') : 'pkg_1';
                await clearAdminSession(userId);

                if (isNaN(newPrice) || newPrice <= 0) {
                    return ctx.reply("❌ অনুগ্রহ করে সঠিক টাকার সংখ্যা লিখুন!");
                }

                await db.setResellerPrice(pkgKey, newPrice);
                await ctx.reply(`✅ [${pkgKey}] এর জন্য নতুন রিসেলার রেট *${newPrice} TK* সেট করা হয়েছে!`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_notice_text' && text) {
                await clearAdminSession(userId);
                await setNoticeText(text.trim());
                await ctx.reply("✅ নতুন নোটিশ মেসেজ সফলভাবে সংরক্ষণ করা হয়েছে!");
                return showBotControlPanel(ctx);
            }

            if (state === 'waiting_for_user_status_id' && text) {
                await clearAdminSession(userId);
                const query = text.trim();
                const allUsers = (await db.getAllUsers()) || [];
                const userObj = allUsers.find(u => u.user_id.toString() === query || (u.username && u.username.toLowerCase() === query.replace('@', '').toLowerCase()));
                const targetId = userObj ? userObj.user_id.toString() : query;
                
                const balance = await db.getUserBalance(targetId);
                const isBanned = await db.isUserBanned(targetId);
                const orders = (await db.getUserOrders(targetId)) || [];

                const userText = 
                    `👤 *User Status Details*\n\n` +
                    `• **User ID:** \`${targetId}\`\n` +
                    `• **First Name:** ${userObj ? userObj.first_name : 'N/A'}\n` +
                    `• **Username:** ${userObj && userObj.username ? '@' + userObj.username : 'N/A'}\n` +
                    `• **Account Status:** ${isBanned ? '⛔ **Banned**' : '🟢 **Active**'}\n` +
                    `• **Current Balance:** \`${balance} TK\`\n` +
                    `• **Total Orders Placed:** *${orders.length}*\n\n` +
                    `নিচের বাটন চেপে কুইক অ্যাকশন নিন:`;

                const keyboard = Markup.inlineKeyboard([
                    [
                        isBanned 
                            ? Markup.button.callback('🔓 Unban User', `unban_id_${targetId}`)
                            : Markup.button.callback('⛔ Ban User', `ban_id_${targetId}`)
                    ],
                    [Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]
                ]);

                return ctx.reply(userText, { parse_mode: 'Markdown', ...keyboard });
            }

            if (state.startsWith('waiting_for_card_') && text) {
                const raw = state.replace('waiting_for_card_', '');
                let field = '';
                let itemKey = '';

                if (raw.startsWith('label_')) {
                    field = 'label';
                    itemKey = raw.replace('label_', '');
                } else if (raw.startsWith('msg_')) {
                    field = 'msg';
                    itemKey = raw.replace('msg_', '');
                } else if (raw.startsWith('emojiid_')) {
                    field = 'emojiid';
                    itemKey = raw.replace('emojiid_', '');
                }

                await clearAdminSession(userId);

                if (field === 'label') {
                    await setCustomText(`LABEL_${itemKey}`, text.trim());
                    await ctx.reply(`✅ *Label for ${itemKey} Updated!*`, { parse_mode: 'Markdown' });
                } else if (field === 'msg') {
                    await setCustomText(`MSG_${itemKey}`, text.trim());
                    if (['BKASH', 'NAGAD', 'BINANCE', 'PAYONEER'].includes(itemKey)) {
                        await setWallet(itemKey.toLowerCase(), text.trim());
                    }
                    await ctx.reply(`✅ *Message / Number for ${itemKey} Updated!*`, { parse_mode: 'Markdown' });
                } else if (field === 'emojiid') {
                    await setCustomText(`EMOJIID_${itemKey}`, text.trim());
                    await ctx.reply(`✨ *Premium Emoji ID for ${itemKey} Updated!*`, { parse_mode: 'Markdown' });
                }

                return showCustomizeItemCard(ctx, itemKey);
            }

            if (state.startsWith('waiting_for_emoji_') && text) {
                const type = state.replace('waiting_for_emoji_', '');
                await clearAdminSession(userId);
                await setCustomText(`EMOJI_${type.toUpperCase()}`, text.trim());
                await ctx.reply(`✨ *${type.toUpperCase()} Button Emoji Updated to:* ${text.trim()}`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_new_join_link' && text) {
                await clearAdminSession(userId);
                const newLink = text.trim();
                await setWallet('join_link', newLink);
                await ctx.reply(`📡 *Force Join Link/Username Updated!*\n\nনতুন লিংক: \`${newLink}\``, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_welcome_msg' && text) {
                await clearAdminSession(userId);
                await setCustomText('WELCOME', text.trim());
                await ctx.reply("💎 *Welcome Message Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_buy_now_title' && text) {
                await clearAdminSession(userId);
                await setCustomText('BUY_NOW', text.trim());
                await ctx.reply("🛒 *Buy Now Title Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_profile_title' && text) {
                await clearAdminSession(userId);
                await setCustomText('PROFILE', text.trim());
                await ctx.reply("👤 *Profile Title Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_my_order_title' && text) {
                await clearAdminSession(userId);
                await setCustomText('MY_ORDER', text.trim());
                await ctx.reply("🛍 *My Order Title Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_faq_text' && text) {
                await clearAdminSession(userId);
                await setCustomText('FAQ', text.trim());
                await ctx.reply("❓ *FAQ & Help Guide Text Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_leaderboard_title' && text) {
                await clearAdminSession(userId);
                await setCustomText('LEADERBOARD', text.trim());
                await ctx.reply("🏆 *Leaderboard Title Updated!*", { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_support_username' && text) {
                await clearAdminSession(userId);
                const username = text.trim().startsWith('@') ? text.trim() : '@' + text.trim();
                await setCustomText('SUPPORT_USER', username);
                await ctx.reply(`📞 *Support Admin Username Updated to ${username}!*`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_ban_user_id' && text) {
                await clearAdminSession(userId);
                const targetId = text.trim();
                await db.banUser(targetId);
                await ctx.reply(`⛔ ইউজার ID \`${targetId}\` কে সফলভাবে **ব্যান** করা হয়েছে!`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_unban_user_id' && text) {
                await clearAdminSession(userId);
                const targetId = text.trim();
                await db.unbanUser(targetId);
                await ctx.reply(`🔓 ইউজার ID \`${targetId}\` কে সফলভাবে **আনব্যান** করা হয়েছে!`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_add_balance' && text) {
                await clearAdminSession(userId);
                const parts = text.trim().split(/\s+/);
                if (parts.length < 2) {
                    return ctx.reply("❌ ভুল ফরম্যাট! উদাহরণ: `1262396547 100` (User_ID টাকার_পরিমাণ)", { parse_mode: 'Markdown' });
                }
                const targetId = parts[0];
                const amount = parseInt(parts[1]);
                if (isNaN(amount) || amount <= 0) {
                    return ctx.reply("❌ টাকার পরিমাণ সঠিক সংখ্যা হতে হবে।");
                }
                const curr = await db.getUserBalance(targetId);
                const newBal = curr + amount;
                await db.setUserBalance(targetId, newBal);
                await ctx.reply(`➕ ইউজার \`${targetId}\` এর অ্যাকাউন্টে *${amount} TK* যোগ করা হয়েছে!\n\nবর্তমান ব্যালেন্স: *${newBal} TK*`, { parse_mode: 'Markdown' });
                try {
                    await ctx.telegram.sendMessage(targetId, `🎉 *Balance Updated!*\n\nএডমিন আপনার অ্যাকাউন্টে *${amount} TK* যোগ করেছেন।\nবর্তমান ব্যালেন্স: *${newBal} TK*`, { parse_mode: 'Markdown' });
                } catch(e) {}
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_remove_balance' && text) {
                await clearAdminSession(userId);
                const parts = text.trim().split(/\s+/);
                if (parts.length < 2) {
                    return ctx.reply("❌ ভুল ফরম্যাট! উদাহরণ: `1262396547 50` (User_ID টাকার_পরিমাণ)", { parse_mode: 'Markdown' });
                }
                const targetId = parts[0];
                const amount = parseInt(parts[1]);
                if (isNaN(amount) || amount <= 0) {
                    return ctx.reply("❌ টাকার পরিমাণ সঠিক সংখ্যা হতে হবে।");
                }
                const curr = await db.getUserBalance(targetId);
                const newBal = Math.max(0, curr - amount);
                await db.setUserBalance(targetId, newBal);
                await ctx.reply(`➖ ইউজার \`${targetId}\` এর অ্যাকাউন্ট থেকে *${amount} TK* কেটে নেওয়া হয়েছে!\n\nবর্তমান ব্যালেন্স: *${newBal} TK*`, { parse_mode: 'Markdown' });
                return showAdminManagementMenu(ctx);
            }

            if (state === 'waiting_for_refer_reward' && text) {
                const amount = parseInt(text.trim());
                await clearAdminSession(userId);
                if (isNaN(amount) || amount < 0) {
                    return ctx.reply("❌ ভুল ইনপুট! বোনাস মূল্য অবশ্যই একটি পজিটিভ সংখ্যা হতে হবে।");
                }
                await setReferRewardAmount(amount);
                await ctx.reply(`✅ রেফারেল বোনাস সফলভাবে আপডেট করা হয়েছে! নতুন মূল্য: *${amount} TK*`, { parse_mode: 'Markdown' });
                return showBotControlPanel(ctx);
            }

            if (state.startsWith('waiting_for_wallet_') && text) {
                const type = state.replace('waiting_for_wallet_', '');
                await clearAdminSession(userId);
                await setWallet(type, text.trim());
                await ctx.reply(`✅ *${type.toUpperCase()}* ওয়ালেট সফলভাবে আপডেট করা হয়েছে!`, { parse_mode: 'Markdown' });
                return showBotControlPanel(ctx);
            }

            if (state === 'waiting_for_coupon_code' && text) {
                const couponCode = text.trim().toUpperCase();
                await updateAdminSession(userId, {
                    step: 'waiting_for_coupon_discount',
                    extraData: couponCode
                });
                return ctx.reply(`🎟️ কুপন *${couponCode}* এর জন্য ডিসকাউন্ট মূল্য (টাকায়) লিখে পাঠান (যেমন: 10):`);
            }

            if (state === 'waiting_for_coupon_discount' && text) {
                const discount = parseInt(text.trim());
                const couponCode = extraData;

                if (isNaN(discount)) {
                    await clearAdminSession(userId);
                    return ctx.reply("❌ ভুল ইনপুট! ডিসকাউন্ট সংখ্যায় হতে হবে। কুপন তৈরি বাতিল করা হয়েছে।");
                }

                await updateAdminSession(userId, {
                    step: 'waiting_for_coupon_limit',
                    extraData: JSON.stringify({ code: couponCode, discount })
                });

                return ctx.reply("🎟️ এই কুপনটির জন্য ব্যবহারের সর্বোচ্চ সীমা (Limit) লিখে পাঠান (যেমন: 10 দিলে সর্বোচ্চ ১০ বার ব্যবহার করা যাবে; আনলিমিটেড করতে 0 লিখে পাঠান):");
            }

            if (state === 'waiting_for_coupon_limit' && text) {
                const limit = parseInt(text.trim());
                const data = JSON.parse(extraData);
                const couponCode = data.code;
                const discount = data.discount;
                await clearAdminSession(userId);

                if (isNaN(limit) || limit < 0) {
                    return ctx.reply("❌ ভুল ইনপুট! লিমিট অবশ্যই ০ বা পজিটিভ সংখ্যা হতে হবে। কুপন তৈরি বাতিল করা হয়েছে।");
                }

                const finalCouponCode = limit > 0 ? `LIMIT|${couponCode}|${limit}|0` : couponCode;

                if (db.isConfigured()) {
                    await db.createCoupon(finalCouponCode, discount);
                } else {
                    memoryCoupons[finalCouponCode] = discount;
                }

                await ctx.reply(`✅ কুপন কোড সফলভাবে যুক্ত হয়েছে!\n• Code: *${couponCode}*\n• Discount: *${discount} TK*\n• Limit: *${limit > 0 ? limit + ' uses' : 'Unlimited'}*\n\n📢 কাস্টমারদের কাছে কুপনটির নোটিফিকেশন ব্রডকাস্ট করা হচ্ছে...`, { parse_mode: 'Markdown' });

                // Auto Coupon Announcement Broadcast
                const userList = await getUserIdsForBroadcast();
                const announceMsg = `🎟️ *NEW DISCOUNT COUPON RELEASED!* 🎟️\n` +
                                    `━━━━━━━━━━━━━━━━━━\n` +
                                    `নতুন প্রোমো কোড ব্যবহার করে আকর্ষণীয় ডিসকাউন্ট পান!\n\n` +
                                    `• Coupon Code: *${couponCode}*\n` +
                                    `• Discount Amount: *${discount} TK*\n` +
                                    (limit > 0 ? `• Limit: *First ${limit} customers only!* ⏳\n\n` : `\n`) +
                                    `🛒 এখনই কেনাকাটা করতে /start এ যান! 🚀`;

                let successCount = 0;
                for (const uId of userList) {
                    try {
                        await ctx.telegram.sendMessage(uId, announceMsg, { parse_mode: 'Markdown' });
                        successCount++;
                    } catch (err) {}
                }

                return ctx.reply(`📢 *Coupon Broadcast Completed!* \n\n✅ সফলভাবে পাঠানো হয়েছে: *${successCount}* জনের কাছে।`, { parse_mode: 'Markdown' });
            }

            if (state === 'waiting_for_reject_reason' && text) {
                const reason = text.trim();
                await clearAdminSession(userId);

                // Update order to Rejected in DB / memory
                await rejectOrderDB(targetUser);

                try {
                    await ctx.telegram.sendMessage(
                        targetUser,
                        `❌ *আপনার অর্ডারটি রিজেক্ট করা হয়েছে!*\n\n` +
                        `আপনার OWL Proxy অর্ডারের পেমেন্টটি অ্যাডমিন ভেরিফাই করতে পারেননি।\n\n` +
                        `• *কারণ:* ${reason}\n\n` +
                        `দয়া করে সঠিক ট্রানজেকশন প্রুফ দিয়ে আবার অর্ডার করুন অথবা অ্যাডমিনের সাথে যোগাযোগ করুন।`,
                        { parse_mode: 'Markdown' }
                    );
                    return ctx.reply(`✅ Successfully Rejected Order & Sent Reason to User!`);
                } catch (err) {
                    return ctx.reply(`❌ ইউজারকে রিজেক্ট মেসেজ পাঠানো যায়নি।`);
                }
            }

            if (state === 'waiting_for_support_reply' && text) {
                await clearAdminSession(userId);

                try {
                    await ctx.telegram.sendMessage(
                        targetUser,
                        `💬 *Support Team Reply* 💬\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `> ${text}\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `যেকোনো প্রয়োজনে আবার মেসেজ পাঠাতে পারেন। ধন্যবাদ!`,
                        { parse_mode: 'Markdown' }
                    );
                    return ctx.reply(`✅ উত্তরটি সফলভাবে ইউজারের কাছে পাঠানো হয়েছে!`);
                } catch (err) {
                    return ctx.reply(`❌ ইউজারকে উত্তর পাঠানো যায়নি (ইউজার হয়তো বটটি ব্লক করেছেন)।`);
                }
            }

            if (state === 'waiting_for_accounts' && text) {
                const inputLines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
                if (inputLines.length === 0) {
                    return ctx.reply("❌ Input cannot be empty!");
                }

                // Fetch Order details for targetUser
                let orderObj = null;
                let orderId = Math.floor(10000 + Math.random() * 90000);
                let buyerName = 'User';
                let pricePaid = 30;
                let pName = 'OWL Proxy Account — 35 TK [200MB]';
                let pMethod = 'bKash';

                if (db.isConfigured()) {
                    orderObj = await db.getOrderForUser(targetUser);
                    if (orderObj) {
                        orderId = orderObj.id || orderId;
                        buyerName = orderObj.name || buyerName;
                        pricePaid = orderObj.price_paid || orderObj.pricePaid || pricePaid;
                        pName = orderObj.package_name || pName;
                        pMethod = orderObj.method || pMethod;
                    }
                } else if (memoryPendingOrders[targetUser]) {
                    orderObj = memoryPendingOrders[targetUser];
                    orderId = orderObj.id || orderId;
                    buyerName = orderObj.name || buyerName;
                    pricePaid = orderObj.pricePaid || pricePaid;
                    pName = orderObj.packageName || pName;
                    pMethod = orderObj.method || pMethod;
                }

                const isProduct1 = pName.includes('OWL Proxy Account') || pName.includes('35');
                const isProduct2 = pName.includes('OWL Proxy 1 Pis') || pName.includes('30');
                const isProduct3 = pName.includes('FREE PROXY') || pName.includes('10 IPs') || pName.includes('20');

                // Validation & Safety for Free Proxy 10 IPs product
                if (isProduct3) {
                    if (inputLines.length !== 10) {
                        return ctx.reply(`❌ Validation Error: FREE PROXY 10 IPs product requires exactly 10 proxies. You provided ${inputLines.length} line(s). Please provide exactly 10 proxies (1 per line).`);
                    }
                }

                await clearAdminSession(userId);

                if (db.isConfigured()) {
                    await db.updateOrderStatus(targetUser, 'Completed', text.trim(), 'Delivered');
                }
                if (memoryPendingOrders[targetUser]) {
                    memoryPendingOrders[targetUser].status = 'Completed';
                    delete memoryPendingOrders[targetUser];
                }

                if (!memoryUserOrderHistory[targetUser]) memoryUserOrderHistory[targetUser] = [];
                memoryUserOrderHistory[targetUser].push({
                    packageName: pName,
                    method: pMethod,
                    status: 'Completed',
                    createdAt: new Date().toISOString()
                });

                await checkAndRewardReferral(targetUser, ctx);

                // --- PRODUCT DELIVERY TO CUSTOMER ---
                if (isProduct3) {
                    // Product 3: FREE PROXY — 10 IPs — TXT File Delivery
                    let txtContent = `FREE PROXY — 10 IPs\n\n`;
                    inputLines.forEach((line, idx) => {
                        const numStr = (idx + 1).toString().padStart(2, '0');
                        txtContent += `${numStr}. ${line}\n`;
                    });

                    const filename = `free_proxy_10_${orderId}.txt`;
                    const tempFilePath = path.join(os.tmpdir(), filename);
                    fs.writeFileSync(tempFilePath, txtContent, 'utf-8');

                    try {
                        await ctx.telegram.sendDocument(
                            targetUser,
                            { source: tempFilePath, filename: filename },
                            {
                                caption: `📦 **FREE PROXY — 10 IPs**\n📄 Your proxy list has been delivered successfully.`,
                                parse_mode: 'Markdown'
                            }
                        );
                        await ctx.reply(`✅ Successfully delivered ${filename} with 10 proxies to user!`);
                    } catch (err) {
                        console.error("Failed to send document to user:", err.message);
                        await ctx.reply(`❌ Failed to send document to user: ${err.message}`);
                    } finally {
                        try { fs.unlinkSync(tempFilePath); } catch (e) {}
                    }
                } else if (isProduct2) {
                    // Plan 2: OWL Proxy 1 Pis — IP:PORT:USERNAME:PASSWORD format
                    const fullProxyStr = inputLines[0] || text.trim();
                    const deliveryMsg = `🟢 **ORDER SUCCESSFUL**\n\n` +
                                        `╔════════════════════╗\n` +
                                        `🛒 **OWL PROXY 1 PIS**\n` +
                                        `╚════════════════════╝\n\n` +
                                        `╭──────────────────╮\n` +
                                        `│ 🆔 ORDER \`#${orderId}\`\n` +
                                        `│ 📦 PLAN \`200MB\`\n` +
                                        `│ 🌐 PROXY \`${fullProxyStr}\`\n` +
                                        `│ 📊 DATA \`200MB\`\n` +
                                        `╰──────────────────╯`;

                    try {
                        await ctx.telegram.sendMessage(targetUser, deliveryMsg, {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback(`🌐 Copy Proxy: ${fullProxyStr}`, `copy_pass_${fullProxyStr}`)]
                            ])
                        });
                        await ctx.reply(`✅ Successfully delivered 1 Proxy (IP:PORT:USERNAME:PASSWORD) to user!`);
                    } catch (err) {
                        console.error("Failed to send delivery message:", err.message);
                        await ctx.reply(`❌ Failed to send message to user: ${err.message}`);
                    }
                } else {
                    // Plan 1: OWL Proxy Account — Gmail & Pass format + Login Code Option
                    let emailVal = 'N/A';
                    let passVal = 'N/A';

                    const firstLine = inputLines[0] || text.trim();
                    if (firstLine.includes(':')) {
                        const parts = firstLine.split(':');
                        emailVal = parts[0].trim();
                        passVal = parts[1].trim();
                    } else {
                        emailVal = firstLine;
                        passVal = inputLines[1] ? inputLines[1].trim() : 'N/A';
                    }

                    const deliveryMsg = `🟢 **ORDER SUCCESSFUL**\n\n` +
                                        `╔════════════════════╗\n` +
                                        `🛒 **OWL PROXY ACCOUNT**\n` +
                                        `╚════════════════════╝\n\n` +
                                        `╭──────────────────╮\n` +
                                        `│ 🆔 ORDER \`#${orderId}\`\n` +
                                        `│ 📦 PLAN \`200MB\`\n` +
                                        `│ 📧 EMAIL \`${emailVal}\`\n` +
                                        `│ 🔑 PASS \`${passVal}\`\n` +
                                        `│ 📊 DATA \`200MB\`\n` +
                                        `╰──────────────────╯`;

                    try {
                        const inlineButtons = [];
                        if (emailVal !== 'N/A') inlineButtons.push([Markup.button.callback(`📧 Copy Email`, `copy_email_${emailVal}`)]);
                        if (passVal !== 'N/A') inlineButtons.push([Markup.button.callback(`🔑 Copy Pass`, `copy_pass_${passVal}`)]);
                        inlineButtons.push([Markup.button.callback(`🔑 Request Login Code`, `req_login_code_${targetUser}`)]);

                        await ctx.telegram.sendMessage(targetUser, deliveryMsg, {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard(inlineButtons)
                        });
                        await ctx.reply(`✅ Successfully delivered OWL Proxy Account (Gmail & Pass) to user!`);
                    } catch (err) {
                        console.error("Failed to send account delivery message:", err.message);
                        await ctx.reply(`❌ Failed to send message to user: ${err.message}`);
                    }
                }

                // --- GROUP & CHANNEL SUCCESS POSTING ---
                try {
                    const firstLetter = buyerName.substring(0, 2).toLowerCase();
                    const maskedEmail = `${firstLetter}***@emalupe.com`;
                    let groupTitle = 'OWL PROXY ACCOUNT';
                    if (isProduct2) groupTitle = 'OWL PROXY 1 PIS';
                    if (isProduct3) groupTitle = 'FREE PROXY 10 IPs';

                    let planLabel = '200MB';
                    if (isProduct3) planLabel = '1GB';

                    const realSaleMsg = `🟢 **ORDER SUCCESSFUL**\n\n` +
                                         `╔════════════════════╗\n` +
                                         `**🛒 ${groupTitle}**\n` +
                                         `╚════════════════════╝\n\n` +
                                         `╭──────────────────╮\n` +
                                         `│ 🆔 ORDER \`#${orderId}\`\n` +
                                         `│ 📦 PLAN \`${planLabel}\`\n` +
                                         `│ 💰 \`${pricePaid} TK\`\n` +
                                         `│ 💳 \`${pMethod.toUpperCase()}\`\n` +
                                         `╰──────────────────╯\n\n` +
                                         `╭──────────────────╮\n` +
                                         `│ 🔐 **CUSTOMER DATA**\n` +
                                         `╰──────────────────╯\n\n` +
                                         `> 👤 \`${buyerName}\`\n` +
                                         `> 📧 \`${maskedEmail}\`\n` +
                                         `> 🔑 \`••••••••\`\n\n` +
                                         `📡 STATUS → 🟢 **DELIVERED**\n\n` +
                                         `> 🚀 **OWL PROXY BOT**`;

                    const chatId = GROUP_ID.toString().startsWith('-') ? parseInt(GROUP_ID) : GROUP_ID;
                    const botUsername = ctx.botInfo ? ctx.botInfo.username : 'OWLProxyBot';
                    await ctx.telegram.sendMessage(chatId, realSaleMsg, {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.url('🛒 BUY PROXY / START BOT 🚀', `https://t.me/${botUsername}?start=buy`)]
                        ])
                    });
                } catch (err) {
                    console.error("Failed to post real completed order to group/channel:", err.message);
                }
            }

            if (state === 'waiting_for_login_code' && text) {
                const loginCode = text.trim();
                await clearAdminSession(userId);

                if (db.isConfigured()) {
                    await db.updateOrderLoginCode(targetUser, loginCode);
                }

                try {
                    await ctx.telegram.sendMessage(
                        targetUser,
                        "🚨 *আপনার Login Code নিচে দেওয়া হলো:*\n\nবাটনে ক্লিক করে কোডটি চ্যাটে নিয়ে কপি করে নিন। লগইন সম্পন্ন হলে নিচের **Done** বাটনে ক্লিক করুন:",
                        {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback(`⏳ Code: ${loginCode}`, `copy_code_${loginCode}`)],
                                [Markup.button.callback('✅ Done ❤️', 'login_done')]
                            ])
                        }
                    );
                    return ctx.reply(`✅ ইউজারের কাছে লগইন কোড সফলভাবে পাঠানো হয়েছে!`);
                } catch (err) {
                    return ctx.reply(`❌ ইউজারকে লগইন কোড পাঠানো যায়নি।`);
                }
            }
        }
    }

    const session = await getUserSession(userId);
    if (!session) return;

    if (session.waitingFor === 'balance_amount' && text) {
        const amount = parseInt(text.trim());
        if (isNaN(amount) || amount <= 0) {
            return ctx.reply("❌ অনুগ্রহ করে সঠিক টাকার পরিমাণ (যেমন: 500) টাইপ করুন।");
        }

        await updateUserSession(userId, { waitingFor: null, balanceTopupAmount: amount });

        const bkashLabel = await getCustomText('LABEL_BKASH', 'bKash');
        const nagadLabel = await getCustomText('LABEL_NAGAD', 'Nagad');
        const binanceLabel = await getCustomText('LABEL_BINANCE', 'Binance (USDT)');
        const payoneerLabel = await getCustomText('LABEL_PAYONEER', 'Payoneer');

        return ctx.reply(
            `💳 *Wallet Top-Up (${amount} TK)*\n\n` +
            `পেমেন্ট মেথড নির্বাচন করুন:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`🇧🇩 ${bkashLabel}`, 'topup_bkash'), Markup.button.callback(`🇧🇩 ${nagadLabel}`, 'topup_nagad')],
                    [Markup.button.callback(`🌐 ${binanceLabel}`, 'topup_binance'), Markup.button.callback(`🌐 ${payoneerLabel}`, 'topup_payoneer')]
                ])
            }
        );
    }

    if (session.waitingFor === 'user_custom_email_input' && text) {
        const customEmail = text.trim();
        await updateUserSession(userId, { customEmail: customEmail, waitingFor: null });
        await ctx.reply(`✅ ইমেইল সংরক্ষণ করা হয়েছে: \`${customEmail}\``, { parse_mode: 'Markdown' });
        return showPaymentSelectionScreen(ctx, userId);
    }

    if (session.waitingFor === 'coupon_code' && text) {
        const inputCode = text.trim().toUpperCase();
        await updateUserSession(userId, { waitingFor: null });

        if (inputCode === 'SYSTEM_MAINTENANCE_MODE' || inputCode === 'SYSTEM_NOTICE_ENABLED' || inputCode.startsWith('NOTICE_TEXT|')) {
            await ctx.reply(`❌ দুঃখিত! এই কুপন কোডটি সঠিক নয় বা এর মেয়াদ শেষ হয়ে গেছে।`);
            return showPaymentSelectionScreen(ctx, userId);
        }

        let coupon = null;
        if (db.isConfigured()) {
            const allCoupons = await db.getAllCoupons();
            if (allCoupons) {
                coupon = allCoupons.find(cp => cp.code === inputCode);
                if (!coupon) {
                    const match = allCoupons.find(cp => cp.code.startsWith(`LIMIT|${inputCode}|`));
                    if (match) {
                        const parts = match.code.split('|');
                        const maxUses = parseInt(parts[2]);
                        const currentUses = parseInt(parts[3]);
                        if (currentUses >= maxUses) {
                            await ctx.reply(`❌ কুপন কোডটির ব্যবহারের সর্বোচ্চ সীমা পার হয়ে গেছে!`);
                            return showPaymentSelectionScreen(ctx, userId);
                        }
                        coupon = { code: inputCode, discount_amount: match.discount_amount };
                    }
                }
            }
        } else {
            if (memoryCoupons[inputCode] !== undefined) {
                coupon = { code: inputCode, discount_amount: memoryCoupons[inputCode] };
            } else {
                const matchKey = Object.keys(memoryCoupons).find(k => k.startsWith(`LIMIT|${inputCode}|`));
                if (matchKey) {
                    const parts = matchKey.split('|');
                    const maxUses = parseInt(parts[2]);
                    const currentUses = parseInt(parts[3]);
                    if (currentUses >= maxUses) {
                        await ctx.reply(`❌ কুপন কোডটির ব্যবহারের সর্বোচ্চ সীমা পার হয়ে গেছে!`);
                        return showPaymentSelectionScreen(ctx, userId);
                    }
                    coupon = { code: inputCode, discount_amount: memoryCoupons[matchKey] };
                }
            }
        }

        if (coupon) {
            await updateUserSession(userId, {
                appliedCoupon: coupon.code,
                discount: coupon.discount_amount
            });
            await ctx.reply(`✅ কুপন সফলভাবে যুক্ত হয়েছে! আপনি *${coupon.discount_amount} TK* ডিসকাউন্ট পেয়েছেন।`, { parse_mode: 'Markdown' });
        } else {
            await ctx.reply(`❌ দুঃখিত! এই কুপন কোডটি সঠিক নয় বা এর মেয়াদ শেষ হয়ে গেছে।`);
        }
        return showPaymentSelectionScreen(ctx, userId);
    }

    if (session.waitingFor === 'support_message' && text) {
        await updateUserSession(userId, { waitingFor: null });

        try {
            await ctx.telegram.sendMessage(
                ADMIN_ID,
                `💬 *New Support Request!* 👤\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `• *From:* ${ctx.from.first_name || 'User'} (@${ctx.from.username || 'N/A'})\n` +
                `• *User ID:* \`${userId}\`\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +
                `📝 *Message:* \n${text}`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✍️ Reply to User', `reply_support_${userId}`)]
                    ])
                }
            );
        } catch (e) {
            console.error("Failed to forward support message to admin:", e.message);
        }

        return ctx.reply("✅ আপনার বার্তাটি অ্যাডমিনের কাছে পাঠানো হয়েছে। অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন, অ্যাডমিন উত্তর দিলে আপনি এখানে নোটিফিকেশন পাবেন।");
    }

    if (session.waitingFor === 'feedback_text' && text) {
        const rating = session.tempRating || '5';
        await updateUserSession(userId, { waitingFor: null, tempRating: null });

        const reviewText = text.trim() === '/skip' ? 'No comment' : text.trim();

        const ratingStars = '⭐'.repeat(parseInt(rating));
        const ratingNum = parseFloat(rating).toFixed(1);
        const buyerName = ctx.from.first_name || 'User';
        const usernameStr = ctx.from.username ? ` (@${ctx.from.username})` : '';

        // Escape variables for MarkdownV2 safety
        const buyerNameEscaped = escapeMarkdownV2(buyerName, false);
        const usernameStrEscaped = escapeMarkdownV2(usernameStr, false);
        const userIdEscaped = escapeMarkdownV2(userId, true);
        const ratingNumEscaped = escapeMarkdownV2(ratingNum, true);
        const reviewTextEscaped = escapeMarkdownV2(reviewText, false);

        const feedbackMsg = `> ⭐️ *CUSTOMER FEEDBACK RECEIVED*\n` +
                            `╔════════════════════╗\n` +
                            `  *🗣️ SHOP REVIEW*\n` +
                            `╚════════════════════╝\n` +
                            `╭──────────────────╮\n` +
                            `│ 👤 *Customer:* ${buyerNameEscaped}${usernameStrEscaped}\n` +
                            `│ 🆔 *User ID:* \`${userIdEscaped}\`\n` +
                            `│ 📊 *Rating:* ${ratingStars} \`${ratingNumEscaped}\`\n` +
                            `╰──────────────────╯\n\n` +
                            `*💬 FEEDBACK RECEIVED*\n\n` +
                            `> ${reviewTextEscaped}\n\n` +
                            `> 🚀 *OWL PROXY BOT*`;

        try {
            await ctx.telegram.sendMessage(ADMIN_ID, feedbackMsg, { parse_mode: 'Markdown' });
            const groupFeedbackSent = await ctx.telegram.sendMessage(parseInt(GROUP_ID), feedbackMsg, {
                parse_mode: 'Markdown'
            });
            if (groupFeedbackSent && groupFeedbackSent.message_id) {
                await addAutoReactions(ctx.telegram, GROUP_ID, groupFeedbackSent.message_id);
            }
        } catch (e) {
            console.error("Failed to forward review feedback to admin/group:", e.message);
        }

        const botUsername = ctx.botInfo ? `@${ctx.botInfo.username}` : '';
        return ctx.reply(
            `❤️ আপনার মূল্যবান মতামত আমাদের সাথে শেয়ার করার জন্য ধন্যবাদ! ভালো থাকবেন। 🚀\n\n${botUsername}`,
            { parse_mode: 'Markdown' }
        );
    }

    const state = session.waitingFor;
    if (state === 'trx' || state === 'screenshot' || state === 'payoneer_details') {
        let proof = text;
        if (ctx.message && ctx.message.photo && ctx.message.photo.length > 0) {
            const photo = ctx.message.photo[ctx.message.photo.length - 1];
            proof = "photo:" + photo.file_id;
        }
        if (!proof) {
            proof = "Details Provided";
        }
        await updateUserSession(userId, { proof, waitingFor: null });

        try { await ctx.deleteMessage(); } catch(e) {}

        return ctx.reply("✅ আপনার পেমেন্ট ইনফো গ্রহণ করা হয়েছে। নিচে কনফার্ম বাটনে ক্লিক করুন:", {
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Confirm Payment', 'final_confirm')]
            ])
        });
    }
});

bot.action(/^copy_email_(.+)$/, async (ctx) => {
    const email = ctx.match[1];
    await ctx.answerCbQuery("Email sent below to copy!");
    return ctx.reply(`📧 আপনার ইমেইল (কপি করতে চেপে ধরে রাখুন):\n\`${email}\``, { parse_mode: 'Markdown' });
});

bot.action(/^copy_pass_(.+)$/, async (ctx) => {
    const password = ctx.match[1];
    await ctx.answerCbQuery("Password sent below to copy!");
    return ctx.reply(`🔑 আপনার পাসওয়ার্ড (কপি করতে চেপে ধরে রাখুন):\n\`${password}\``, { parse_mode: 'Markdown' });
});

bot.action(/^copy_code_(.+)$/, async (ctx) => {
    const code = ctx.match[1];
    await ctx.answerCbQuery("Login Code sent below to copy!");
    return ctx.reply(`⏳ আপনার লগইন কোড (কপি করতে চেপে ধরে রাখুন):\n\`${code}\``, { parse_mode: 'Markdown' });
});

bot.action(/^req_login_code_(.+)$/, async (ctx) => {
    const targetUserId = ctx.match[1];
    await ctx.answerCbQuery("Login Code request sent to Admin! ❤️", { show_alert: true });

    try {
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `🚨 *Login Code Request from Customer!* 🔑\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `• *Name:* ${ctx.from.first_name || 'User'}\n` +
            `• *Username:* @${ctx.from.username || 'N/A'}\n` +
            `• *User ID:* \`${targetUserId}\`\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `👇 কাস্টমার লগইন কোড চাচ্ছেন। কোড দিতে নিচের বাটনে ক্লিক করুন:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔑 Provide Login Code', `provide_login_code_${targetUserId}`)]
                ])
            }
        );
    } catch (e) {
        console.error("Failed to forward login code request to admin:", e.message);
    }

    return ctx.reply("🔑 *আপনার লগইন কোড রিকোয়েস্ট অ্যাডমিনের কাছে পাঠানো হয়েছে।* অ্যাডমিন কোড দেওয়ার সাথে সাথে আপনি এখানে পাবেন।", { parse_mode: 'Markdown' });
});

bot.action(/^provide_login_code_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];
    const adminId = ctx.from.id.toString();

    await updateAdminSession(adminId, { step: 'waiting_for_login_code', targetUserId: targetUserId });
    return ctx.reply(`✍️ ইউজারকে (ID: \`${targetUserId}\`) পাঠানোর জন্য **Login Code** টি লিখে পাঠান:`, { parse_mode: 'Markdown' });
});

async function checkIfTrxIDExists(proof) {
    if (db.isConfigured()) {
        const exists = await db.checkIfProofExists(proof);
        return exists === true;
    }
    let found = false;
    Object.keys(memoryUserOrderHistory).forEach(uid => {
        memoryUserOrderHistory[uid].forEach(ord => {
            if (ord.proof === proof) {
                found = true;
            }
        });
    });
    return found;
}

bot.action('final_confirm', async (ctx) => {
    const user = ctx.from;
    const userId = user.id.toString();
    const session = await getUserSession(userId);
    const proof = session ? session.proof || 'N/A' : 'N/A';

    // Duplicate TrxID Check
    const isPhotoProof = proof.startsWith("photo:");
    if (!isPhotoProof && proof !== 'N/A' && proof !== 'Details Provided') {
        const isDuplicate = await checkIfTrxIDExists(proof);
        if (isDuplicate) {
            await ctx.answerCbQuery();
            return ctx.reply("❌ *দুঃখিত! এই TrxID-টি ইতিমধ্যে অন্য একটি অর্ডারে ব্যবহার করা হয়েছে।*\n\nঅনুগ্রহ করে সঠিক পেমেন্ট প্রুফ বা TrxID দিয়ে আবার ট্রাই করুন। কোনো সমস্যা হলে সাপোর্টে যোগাযোগ করুন।", { parse_mode: 'Markdown' });
        }
    }

    await ctx.answerCbQuery("Payment Submitted!");
    const method = session ? session.method || 'Unknown' : 'Unknown';
    const packageName = session ? session.packageName || '1 Account OWL Proxy' : '1 Account OWL Proxy';
    const price = session ? session.price || 30 : 30;
    const discount = session ? session.discount || 0 : 0;
    const finalPrice = Math.max(0, price - discount);

    if (db.isConfigured()) {
        await db.createOrder({
            userId,
            name: user.first_name || 'User',
            username: user.username || 'N/A',
            packageName: packageName,
            method,
            proof,
            pricePaid: finalPrice
        });
    }

    memoryPendingOrders[userId] = {
        name: user.first_name || 'User',
        username: user.username || 'N/A',
        userId: userId,
        method,
        proof,
        status: 'Pending Verification',
        packageName: packageName,
        pricePaid: finalPrice
    };

    if (!memoryUserOrderHistory[userId]) memoryUserOrderHistory[userId] = [];
    memoryUserOrderHistory[userId].push({
        packageName: packageName,
        method,
        status: 'Pending Verification',
        date: new Date().toLocaleString()
    });

    let proofText = `🚨 *NEW ORDER RECEIVED* 🚨\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📦 *Package:* \`${packageName}\`\n` +
                    `💳 *Payment Method:* \`${method}\`\n` +
                    `💰 *Price Paid:* *${finalPrice} TK*\n` +
                    (session.appliedCoupon ? `🎟️ *Coupon:* \`${session.appliedCoupon}\` (-${discount} TK)\n` : '') +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `👤 *Customer:* ${user.first_name || 'User'}\n` +
                    `🔗 *Username:* @${user.username || 'N/A'}\n` +
                    `🆔 *User ID:* \`${userId}\`\n` +
                    `📌 *Proof (TrxID/Details):* \`${proof}\``;

    const photoFileId = isPhotoProof ? proof.substring(6) : null;
    const displayProofText = isPhotoProof 
        ? proofText.replace(`\`${proof}\``, `\`[Screenshot Attached]\``)
        : proofText;

    const sendNotification = async (chatId) => {
        try {
            if (isPhotoProof) {
                await ctx.telegram.sendPhoto(chatId, photoFileId, { caption: displayProofText, parse_mode: 'Markdown' });
            } else {
                await ctx.telegram.sendMessage(chatId, displayProofText, { parse_mode: 'Markdown' });
            }
        } catch (err) {
            console.error(`Failed to send order notification to ${chatId}:`, err.message);
            try {
                await ctx.telegram.sendMessage(chatId, proofText, { parse_mode: 'Markdown' });
            } catch (fallbackErr) {
                console.error(`Fallback failed to send order notification to ${chatId}:`, fallbackErr.message);
            }
        }
    };

    await sendNotification(ADMIN_ID);
    await sendNotification(GROUP_ID);

    // Reset user session applied coupon and discount after placing order
    await updateUserSession(userId, { appliedCoupon: '', discount: 0 });

    return ctx.reply(
        `✅ *Payment Request Submitted!* ⏳\n\n` +
        `> আপনার পেমেন্ট ইনফরমেশন সফলভাবে জমা হয়েছে। অ্যাডমিন পেমেন্টটি ভেরিফাই করছেন।\n\n` +
        `🕒 **অনুগ্রহ করে ৫ মিনিট অপেক্ষা করুন।** অর্ডার সম্পূর্ণ হলে আপনাকে চ্যাটে জানানো হবে।\n\n` +
        `❌ যদি ৫ মিনিটের বেশি দেরি হয়, তবে অনুগ্রহ করে **Contact Support** অপশন ব্যবহার করে অ্যাডমিনের সাথে যোগাযোগ করুন। ❤️`,
        { parse_mode: 'Markdown' }
    );
});

// ================= ADMIN MENUS =================

async function showPendingOrdersMenu(ctx) {
    const orders = await getPendingOrders();

    if (!orders || orders.length === 0) {
        return ctx.reply("⭐ *Pending Orders:* বর্তমানে কোনো পেন্ডিং অর্ডার নেই।", { parse_mode: 'Markdown' });
    }

    let buttons = [];
    orders.forEach((ord) => {
        const name = ord.name || 'User';
        const method = ord.method || 'N/A';
        const id = ord.userId;
        buttons.push([Markup.button.callback(`📦 ${name} [ ${method} ]`, `view_order_${id}`)]);
    });

    return ctx.reply("⭐ *Select an Order to Check Details:*", {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
    });
}

bot.action(/^view_order_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    
    const targetUserId = ctx.match[1];
    const ord = await getOrderForUser(targetUserId);

    if (!ord) return ctx.reply("❌ অর্ডারটি পাওয়া যায়নি বা ইতিমধ্যে প্রসেস হয়ে গেছে।");

    const isPhotoProof = ord.proof && ord.proof.startsWith("photo:");
    const photoFileId = isPhotoProof ? ord.proof.substring(6) : null;

    // Fetch available stock items
    const allStock = await db.getAllStockAccounts();
    const availableStock = allStock.filter(i => i.available);

    let detailsMsg = `📋 *Order Details*\n\n` +
                     `👤 *Name:* ${ord.name}\n` +
                     `🔗 *Username:* @${ord.username}\n` +
                     `🆔 *User ID:* \`${ord.userId}\`\n` +
                     `💳 *Method:* ${ord.method}\n` +
                     `📦 *Package:* ${ord.packageName}\n` +
                     `📌 *Proof:* ${isPhotoProof ? '`[Screenshot Attached]`' : `\`${ord.proof}\``}\n\n` +
                     `📦 *Available Stock in Pool:* *${availableStock.length}* টি`;

    const inlineMarkup = Markup.inlineKeyboard([
        [Markup.button.callback(`📦 Reserve Stock Account (${availableStock.length} Available)`, `reserve_stock_${targetUserId}`)],
        [Markup.button.callback('✍️ Manual Input Email/Pass', `start_custom_pass_${targetUserId}`)],
        [Markup.button.callback('❌ Reject Order', `start_reject_order_${targetUserId}`)]
    ]);

    try {
        if (isPhotoProof) {
            return await ctx.replyWithPhoto(photoFileId, {
                caption: detailsMsg,
                parse_mode: 'Markdown',
                ...inlineMarkup
            });
        } else {
            return await ctx.reply(detailsMsg, {
                parse_mode: 'Markdown',
                ...inlineMarkup
            });
        }
    } catch (e) {
        console.error("Failed to display order details with photo:", e.message);
        return ctx.reply(detailsMsg, {
            parse_mode: 'Markdown',
            ...inlineMarkup
        });
    }
});

bot.action(/^reserve_specific_stock_(.+)_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];
    const stockId = ctx.match[2];

    const stockData = await db.popSpecificStockAccount(stockId, targetUserId);

    if (!stockData) {
        return ctx.reply("⚠️ উক্ত স্টক অ্যাকাউন্টটি ইতিমধ্যে অন্য অর্ডারে ব্যবহৃত বা রিমুভ হয়ে গেছে!");
    }

    // Trigger Low Stock Alert check
    await checkLowStockAlert(ctx);

    // Save reserved account info into order details
    if (db.isConfigured()) {
        await db.updateOrderStatus(targetUserId, 'Pending 10-Day Setup', stockData, 'Reserved-Pass');
    } else {
        if (memoryPendingOrders[targetUserId]) {
            memoryPendingOrders[targetUserId].status = 'Pending 10-Day Setup';
            memoryPendingOrders[targetUserId].reservedAccount = stockData;
        }
    }

    let emailVal = stockData;
    let passVal = '10-Day Premium Active';
    if (stockData.includes(':')) {
        const parts = stockData.split(':');
        emailVal = parts[0].trim();
        passVal = parts[1].trim();
    }

    // Send instant 1-Tap Copy text box to Admin
    await ctx.reply(
        `📋 *Reserved Stock Credentials (1-Tap Copy):*\n\n` +
        `📧 *Email (কপি করতে ট্যাপ করুন):*\n\`${emailVal}\`\n\n` +
        `🔑 *Password (কপি করতে ট্যাপ করুন):*\n\`${passVal}\`\n\n` +
        `> 💡 *ক্লিক বা ট্যাপ করলেই ১-সেকেন্ডে টেক্সট কপি হয়ে যাবে।*`,
        { parse_mode: 'Markdown' }
    );

    const confirmMsg = `📥 *Stock Account Reserved for User!* \n` +
                       `━━━━━━━━━━━━━━━━━━\n` +
                       `👤 *Customer ID:* \`${targetUserId}\`\n` +
                       `📧 *Assigned Email:* \`${emailVal}\`\n` +
                       `🔑 *Assigned Pass:* \`${passVal}\`\n` +
                       `⏳ *Status:* 10-Day Premium Setup Required\n` +
                       `━━━━━━━━━━━━━━━━━━\n\n` +
                       `👉 *আপনার করণীয়:* OWL Proxy ক্লায়েন্টে উক্ত আইডিতে ১০ দিনের প্রিমিয়াম এক্সেস একটিভ করুন।\n\n` +
                       `এক্টিভেশন শেষ হলে নিচের **"✅ Done & Deliver to Customer"** বাটনে ১-ক্লিক করুন:`;

    return ctx.reply(confirmMsg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback(`📧 Copy Email: ${emailVal}`, `copy_email_${emailVal}`)],
            [Markup.button.callback(`🔑 Copy Pass: ${passVal}`, `copy_pass_${passVal}`)],
            [Markup.button.callback('✅ Done & 1-Click Deliver to Customer', `deliver_stock_${targetUserId}`)],
            [Markup.button.callback('❌ Reject / Cancel Order', `start_reject_order_${targetUserId}`)]
        ])
    });
});

bot.action(/^reserve_stock_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];

    const stockData = await db.popStockAccount(targetUserId);

    if (!stockData) {
        return ctx.reply(
            "⚠️ *স্টকে কোনো অব্যবহৃত অ্যাকাউন্ট খালি নেই!*\n\n" +
            "দয়া করে আগে স্টকে নতুন অ্যাকাউন্ট যোগ করুন অথবা ম্যানুয়ালি ইমেইল-পাসওয়ার্ড ইনপুট দিন:",
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('➕ Add to Stock Pool', 'add_stock_prompt')],
                    [Markup.button.callback('✍️ Manual Input Email/Pass', `start_custom_pass_${targetUserId}`)]
                ])
            }
        );
    }

    // Trigger Low Stock Alert check
    await checkLowStockAlert(ctx);

    // Save reserved account info into order details
    if (db.isConfigured()) {
        await db.updateOrderStatus(targetUserId, 'Pending 10-Day Setup', stockData, 'Reserved-Pass');
    } else {
        if (memoryPendingOrders[targetUserId]) {
            memoryPendingOrders[targetUserId].status = 'Pending 10-Day Setup';
            memoryPendingOrders[targetUserId].reservedAccount = stockData;
        }
    }

    let emailVal = stockData;
    let passVal = '10-Day Premium Active';
    if (stockData.includes(':')) {
        const parts = stockData.split(':');
        emailVal = parts[0].trim();
        passVal = parts[1].trim();
    }

    // Send instant 1-Tap Copy text box to Admin
    await ctx.reply(
        `📋 *Reserved Stock Credentials (1-Tap Copy):*\n\n` +
        `📧 *Email (কপি করতে ট্যাপ করুন):*\n\`${emailVal}\`\n\n` +
        `🔑 *Password (কপি করতে ট্যাপ করুন):*\n\`${passVal}\`\n\n` +
        `> 💡 *ক্লিক বা ট্যাপ করলেই ১-সেকেন্ডে টেক্সট কপি হয়ে যাবে।*`,
        { parse_mode: 'Markdown' }
    );

    const confirmMsg = `📥 *Stock Account Reserved for User!* \n` +
                       `━━━━━━━━━━━━━━━━━━\n` +
                       `👤 *Customer ID:* \`${targetUserId}\`\n` +
                       `📧 *Assigned Account:* \`${stockData}\`\n` +
                       `⏳ *Status:* 10-Day Premium Setup Required\n` +
                       `━━━━━━━━━━━━━━━━━━\n\n` +
                       `👉 *আপনার করণীয়:* OWL Proxy ক্লায়েন্টে উক্ত আইডিতে ১০ দিনের প্রিমিয়াম এক্সেস একটিভ করুন।\n\n` +
                       `এক্টিভেশন শেষ হলে নিচের **"✅ Done & Deliver to Customer"** বাটনে ১-ক্লিক করুন:`;
                       `━━━━━━━━━━━━━━━━━━\n\n` +
                       `👉 *আপনার করণীয়:* OWL Proxy ক্লায়েন্টে উক্ত আইডিতে ১০ দিনের প্রিমিয়াম এক্সেস একটিভ করুন।\n\n` +
                       `এক্টিভেশন শেষ হলে নিচের **"✅ Done & Deliver to Customer"** বাটনে ১-ক্লিক করুন:`;

    return ctx.reply(confirmMsg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Done & 1-Click Deliver to Customer', `deliver_stock_${targetUserId}`)],
            [Markup.button.callback('❌ Reject / Cancel Order', `start_reject_order_${targetUserId}`)]
        ])
    });
});

bot.action(/^deliver_stock_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];

    let customAccountData = null;
    if (db.isConfigured()) {
        const ord = await db.getOrderForUser(targetUserId) || (await db.getUserOrders(targetUserId) || []).find(o => o.status === 'Pending 10-Day Setup');
        if (ord) customAccountData = ord.custom_email;
        await db.updateOrderStatus(targetUserId, 'Completed', customAccountData || 'OWL Proxy Premium Account', 'Delivered');
    } else {
        if (memoryPendingOrders[targetUserId]) {
            customAccountData = memoryPendingOrders[targetUserId].reservedAccount;
            memoryPendingOrders[targetUserId].status = 'Completed';
            delete memoryPendingOrders[targetUserId];
        }
    }

    if (!customAccountData) {
        customAccountData = "OWL Proxy 10-Day Premium Account";
    }

    // Check referral reward
    await checkAndRewardReferral(targetUserId, ctx);

    if (!memoryUserOrderHistory[targetUserId]) memoryUserOrderHistory[targetUserId] = [];
    memoryUserOrderHistory[targetUserId].push({
        packageName: '10-Day Premium OWL Proxy Account',
        method: '1-Click Stock Delivery',
        status: 'Completed',
        createdAt: new Date().toISOString()
    });

    // Parse email & pass if format is email:pass
    let emailVal = customAccountData;
    let passVal = '10-Day Premium Active';
    if (customAccountData.includes(':')) {
        const parts = customAccountData.split(':');
        emailVal = parts[0].trim();
        passVal = parts[1].trim();
    }

    // Post Real Completed Order to Group
    try {
        const realSaleMsg = `🟢 **ORDER SUCCESSFUL**\n\n` +
                             `╔════════════════════╗\n` +
                             `**🛒 OWL PROXY ACCOUNT**\n` +
                             `╚════════════════════╝\n\n` +
                             `📡 STATUS → 🟢 **DELIVERED SUCCESSFULLY**\n\n` +
                             `> 🚀 **OWL PROXY BOT**`;

        const sentReal = await ctx.telegram.sendMessage(parseInt(GROUP_ID), realSaleMsg, { parse_mode: 'Markdown' });
        if (sentReal && sentReal.message_id) {
            await addAutoReactions(ctx.telegram, GROUP_ID, sentReal.message_id);
        }
    } catch (err) {}

    // Send credentials to User
    try {
        await ctx.telegram.sendMessage(
            targetUserId,
            `🎉 *Congratulations on Your Purchase!* 💎\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `> *আপনার পেমেন্ট সফলভাবে ভেরিফাই হয়েছে এবং ১০ দিনের প্রিমিয়াম এক্সেস এক্টিভ করা হয়েছে!*\n\n` +
            `📧 *Email / Account:* \`${emailVal}\`\n` +
            `🔑 *Password:* \`${passVal}\`\n\n` +
            `👇 নিচের বাটনগুলোতে ক্লিক করে তথ্য এক ক্লিকে কপি করে নিন:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`📧 Copy Email: ${emailVal}`, `copy_email_${emailVal}`)],
                    [Markup.button.callback(`🔑 Copy Pass: ${passVal}`, `copy_pass_${passVal}`)],
                    [Markup.button.callback('🔑 Get Login Code', `get_code_${targetUserId}`)],
                    [Markup.button.callback('📦 OWL Proxy Details', 'details')]
                ])
            }
        );
        return ctx.reply(`✅ 10-Day Premium Account Successfully Delivered to Customer (${targetUserId})!`);
    } catch (err) {
        return ctx.reply(`❌ ইউজারকে মেসেজ পাঠানো যায়নি (ইউজার হয়তো বট ব্লক করেছেন)।`);
    }
});

bot.action(/^start_custom_pass_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];

    await updateAdminSession(ctx.from.id.toString(), {
        step: 'waiting_for_accounts',
        targetUserId: targetUserId
    });

    return ctx.reply(
        "📧 অনুগ্রহ করে অ্যাকাউন্ট(সমূহ) নিচের ফরম্যাটে লিখে পাঠান (প্রতি লাইনে একটি করে):\n\n" +
        "`email:password`"
    );
});

bot.action(/^start_reject_order_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];

    await updateAdminSession(ctx.from.id.toString(), {
        step: 'waiting_for_reject_reason',
        targetUserId: targetUserId
    });

    return ctx.reply("❌ অর্ডারটি রিজেক্ট করার কারণটি লিখে পাঠান (যেমন: আপনার TrxID মিলছে না):");
});

bot.action('download_sales_csv', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery("Generating sales report CSV...");

    try {
        let orders = [];
        if (db.isConfigured()) {
            orders = await db.getAllOrders();
        } else {
            // Memory fallback logic
            Object.keys(memoryUserOrderHistory).forEach(uid => {
                memoryUserOrderHistory[uid].forEach(ord => {
                    orders.push({
                        user_id: uid,
                        package_name: ord.packageName || 'Unknown Package',
                        method: ord.method || 'Unknown Method',
                        proof: ord.proof || 'N/A',
                        status: ord.status || 'Completed',
                        created_at: ord.createdAt || new Date().toISOString(),
                        price_paid: ord.pricePaid || 30
                    });
                });
            });
        }

        if (!orders || orders.length === 0) {
            return ctx.reply("❌ কোনো সেলস বা অর্ডারের রেকর্ড পাওয়া যায়নি।");
        }

        // Construct CSV
        let csvContent = "\ufeff"; // BOM for UTF-8 Excel support
        csvContent += "Order ID,Date (UTC),User ID,Package,Method,TrxID/Proof,Price Paid (TK),Status,Email,Password,Login Code\n";

        orders.forEach(ord => {
            const escape = (val) => {
                if (val === null || val === undefined) return "";
                const str = String(val).replace(/"/g, '""');
                return str.includes(',') || str.includes('\n') || str.includes('"') ? `"${str}"` : str;
            };

            csvContent += `${escape(ord.id || 'N/A')},` +
                          `${escape(ord.created_at || ord.createdAt || 'N/A')},` +
                          `${escape(ord.user_id)},` +
                          `${escape(ord.package_name)},` +
                          `${escape(ord.method)},` +
                          `${escape(ord.proof)},` +
                          `${escape(ord.price_paid || ord.pricePaid || 0)},` +
                          `${escape(ord.status)},` +
                          `${escape(ord.custom_email || '')},` +
                          `${escape(ord.custom_pass || '')},` +
                          `${escape(ord.login_code || '')}\n`;
        });

        const csvBuffer = Buffer.from(csvContent, 'utf-8');
        return await ctx.replyWithDocument({ source: csvBuffer, filename: `sales_report_${new Date().toISOString().split('T')[0]}.csv` }, {
            caption: "📊 *OWL Proxy Bot Sales Report Backup CSV*\n\nআপনার সকল ট্রানজেকশন এবং সেলসের এক্সেল ফাইল ব্যাকআপ সফলভাবে জেনারেট করা হয়েছে।",
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error("Failed to generate sales CSV:", err.message);
        return ctx.reply(`❌ CSV রিপোর্ট জেনারেট করতে সমস্যা হয়েছে: ${err.message}`);
    }
});

async function showTotalUsersStats(ctx) {
    let usersList = null;
    if (db.isConfigured()) {
        usersList = await db.getAllUsers();
    }

    let totalCount = 0;
    let buttons = [];

    if (usersList !== null && usersList.length > 0) {
        totalCount = usersList.length;
        usersList.forEach((u, index) => {
            buttons.push([Markup.button.callback(`👤 User #${index + 1} (ID: ${u.user_id})`, `inspect_user_${u.user_id}`)]);
        });
    } else {
        totalCount = memoryAllStartedUsers.size;
        Array.from(memoryAllStartedUsers).forEach((id, index) => {
            buttons.push([Markup.button.callback(`👤 User #${index + 1} (ID: ${id})`, `inspect_user_${id}`)]);
        });
    }

    return ctx.reply(
        `⭐ *Total Bot Users Statistics*\n\n` +
        `🚀 মোট কতজন বট স্টার্ট করেছে: **${totalCount} জন**\n\n` +
        `নিচের তালিকা থেকে যেকোনো ইউজারের ওপর ক্লিক করে দেখতে পারেন:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons.slice(0, 50))
        }
    );
}

bot.action(/^inspect_user_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const id = ctx.match[1];
    
    let userDetails = `👤 *User Details* 👤\n` +
                      `━━━━━━━━━━━━━━━━━━\n` +
                      `• *User ID:* \`${id}\`\n` +
                      `━━━━━━━━━━━━━━━━━━\n` +
                      `⚠️ Database lookup failed or fallback memory is in use.`;

    try {
        if (db.isConfigured()) {
            const users = await db.getAllUsers();
            const user = users ? users.find(u => String(u.user_id) === id) : null;
            if (user) {
                const orders = await db.getUserOrders(id);
                const totalOrders = orders ? orders.length : 0;
                const completedOrders = orders ? orders.filter(o => o.status === 'Completed').length : 0;
                
                userDetails = `👤 *User Details* 👤\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `• *Name:* ${user.first_name || 'N/A'}\n` +
                              `• *Username:* @${user.username || 'N/A'}\n` +
                              `• *User ID:* \`${user.user_id}\`\n` +
                              `• *Registered:* \`${user.created_at ? new Date(user.created_at).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }) : 'N/A'}\`\n` +
                              `• *Last Active:* \`${user.last_active ? new Date(user.last_active).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }) : 'N/A'}\`\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `🛍 *Order Stats:*\n` +
                              `• Total Orders: *${totalOrders}*\n` +
                              `• Completed Orders: *${completedOrders}*`;
            } else {
                userDetails = `👤 *User Details* 👤\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `• *User ID:* \`${id}\`\n` +
                              `━━━━━━━━━━━━━━━━━━\n` +
                              `❌ User details not found in database.`;
            }
        } else {
            // Memory fallback stats
            const orders = memoryUserOrderHistory[id] || [];
            const totalOrders = orders.length;
            const completedOrders = orders.filter(o => o.status === 'Completed').length;
            
            userDetails = `👤 *User Details (Memory Fallback)* 👤\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `• *User ID:* \`${id}\`\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `🛍 *Order Stats:*\n` +
                          `• Total Orders: *${totalOrders}*\n` +
                          `• Completed Orders: *${completedOrders}*`;
        }
    } catch (err) {
        console.error("Error fetching user details in admin panel:", err.message);
    }
    
    return ctx.reply(userDetails, { parse_mode: 'Markdown' });
});

bot.action(/^get_code_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery("Login code request sent to Admin!");
    const user = ctx.from;
    const targetUserId = ctx.match[1];
    const email = await getLatestCompletedEmail(targetUserId);

    try {
        await ctx.telegram.sendMessage(
            ADMIN_ID, 
            `🔑 *Login Code Request from User!*\n\n` +
            `👤 *User:* ${user.first_name} (\`${targetUserId}\`)\n` +
            `📧 *Email:* \`${email}\`\n\n` +
            `দয়া করে এই ইউজারকে লগইন কোড প্রদান করুন।`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📤 Send Login Code', `send_code_admin_${targetUserId}`)]
                ])
            }
        );
    } catch (err) {}

    return ctx.reply("📤 অ্যাডমিনের কাছে কোডের অনুরোধ পাঠানো হয়েছে। অ্যাডমিন কোড দিলে আপনার কাছে মেসেজ চলে আসবে। দয়া করে অপেক্ষা করুন...");
});

bot.action(/^send_code_admin_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const targetUserId = ctx.match[1];

    await updateAdminSession(ctx.from.id.toString(), {
        step: 'waiting_for_login_code',
        targetUserId: targetUserId
    });

    return ctx.reply(`🔑 অনুগ্রহ করে ইউজার (ID: \`${targetUserId}\`) এর জন্য **Login Code** টি লিখে পাঠান:`, { parse_mode: 'Markdown' });
});

bot.action('login_done', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply(
        `❤️ *Thank You for Purchasing from OWL PROXY BOT!*\n\n` +
        `আপনার প্রিমিয়াম পাস সফলভাবে অ্যাক্টিভ হয়েছে। আমাদের সেবা নেওয়ার জন্য আপনাকে আন্তরিক ধন্যবাদ! 🚀\n\n` +
        `⭐ *অনুগ্রহ করে আমাদের সার্ভিসটি রেটিং দিন:*`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('⭐ 1', 'rate_1'),
                    Markup.button.callback('⭐⭐ 2', 'rate_2'),
                    Markup.button.callback('⭐⭐⭐ 3', 'rate_3'),
                    Markup.button.callback('⭐⭐⭐⭐ 4', 'rate_4'),
                    Markup.button.callback('⭐⭐⭐⭐⭐ 5', 'rate_5')
                ]
            ])
        }
    );
});

bot.action(/^rate_(\d)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const rating = ctx.match[1];
    const userId = ctx.from.id.toString();

    await updateUserSession(userId, { tempRating: rating, waitingFor: 'feedback_text' });

    return ctx.reply(
        `✍️ আপনি **${rating} Star** রেটিং দিয়েছেন। ধন্যবাদ! \n\n` +
        `আমাদের সার্ভিস নিয়ে আপনার কোনো মতামত বা অনুভূতি থাকলে তা লিখে পাঠান (অথবা চাইলে সরাসরি /skip টাইপ করতে পারেন):`
    );
});

// Admin Coupon Management Menus
async function showCouponsMenu(ctx) {
    let coupons = [];
    if (db.isConfigured()) {
        coupons = await db.getAllCoupons();
    } else {
        coupons = Object.keys(memoryCoupons).map(code => ({ code, discount_amount: memoryCoupons[code] }));
    }

    let inlineButtons = [];
    if (coupons && coupons.length > 0) {
        coupons.forEach(cp => {
            if (cp.code === 'SYSTEM_MAINTENANCE_MODE' || cp.code === 'SYSTEM_NOTICE_ENABLED' || cp.code.startsWith('NOTICE_TEXT|')) return;
            inlineButtons.push([
                Markup.button.callback(`🎟️ ${cp.code} (-${cp.discount_amount} TK)`, 'noop'),
                Markup.button.callback('❌ Delete', `delete_coupon_${cp.code}`)
            ]);
        });
    }

    inlineButtons.push([Markup.button.callback('➕ Add Coupon', 'admin_add_coupon')]);

    return ctx.reply("🎟️ *Active Coupons Management Menu:*\n\nকুপন কোড ও ডিসকাউন্ট অ্যাড বা ডিলিট করুন:", {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(inlineButtons)
    });
}

bot.action('noop', async (ctx) => {
    await ctx.answerCbQuery();
});

bot.action('admin_add_coupon', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_coupon_code' });
    return ctx.reply("🎟️ অনুগ্রহ করে নতুন **কুপন কোডটি** লিখুন (যেমন: BD50):");
});

bot.action(/^delete_coupon_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery("Coupon Deleted!");
    const code = ctx.match[1].toUpperCase();

    if (db.isConfigured()) {
        await db.deleteCoupon(code);
    } else {
        delete memoryCoupons[code];
    }

    try { await ctx.deleteMessage(); } catch(e) {}
    return showCouponsMenu(ctx);
});

bot.action('force_join_toggle', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await getForceJoinStatus();
    await setForceJoinStatus(!current);
    await ctx.answerCbQuery(`Force Join is now ${!current ? 'Enabled' : 'Disabled'}`);
    return showBotControlPanel(ctx);
});

bot.action('selling_hours_toggle', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const current = await getSellingHoursStatus();
    await setSellingHoursStatus(!current);
    await ctx.answerCbQuery(`Time Limits are now ${!current ? 'Enabled' : 'Disabled'}`);
    return showBotControlPanel(ctx);
});

bot.action('edit_refer_reward', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), {
        step: 'waiting_for_refer_reward'
    });
    return ctx.reply("💰 কুপনের মাধ্যমে রেফারেলের জন্য নতুন কুপন বোনাস মূল্য (টাকায়) লিখে পাঠান (যেমন: 5):");
});

bot.action('stock_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const stock1 = await getPackageStockStatus('pkg_1');
    const stock3 = await getPackageStockStatus('pkg_3');
    const stock5 = await getPackageStockStatus('pkg_5');

    const stockText = `📦 *Stock Management Panel* 📦\n\n` +
                      `নিচের বাটনগুলো ক্লিক করে প্যাকেজের স্টক অন/অফ (In Stock / Out of Stock) করুন:\n\n` +
                      `• **1 Account:** ${stock1 ? '🟢 In Stock' : '🔴 Out of Stock'}\n` +
                      `• **3 Accounts:** ${stock3 ? '🟢 In Stock' : '🔴 Out of Stock'}\n` +
                      `• **5 Accounts:** ${stock5 ? '🟢 In Stock' : '🔴 Out of Stock'}`;

    return ctx.editMessageText(stockText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [
                Markup.button.callback(stock1 ? '🔴 Set 1 Acc Out of Stock' : '🟢 Set 1 Acc In Stock', 'toggle_stock_pkg_1'),
            ],
            [
                Markup.button.callback(stock3 ? '🔴 Set 3 Acc Out of Stock' : '🟢 Set 3 Acc In Stock', 'toggle_stock_pkg_3'),
            ],
            [
                Markup.button.callback(stock5 ? '🔴 Set 5 Acc Out of Stock' : '🟢 Set 5 Acc In Stock', 'toggle_stock_pkg_5'),
            ],
            [Markup.button.callback('⬅️ Back to Control Panel', 'bot_control_back')]
        ])
    });
});

bot.action(/^toggle_stock_(pkg_\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const pkgKey = ctx.match[1];
    const current = await getPackageStockStatus(pkgKey);
    await setPackageStockStatus(pkgKey, !current);
    await ctx.answerCbQuery(`Stock updated!`);
    
    // Smoothly redraw stock menu
    const stock1 = await getPackageStockStatus('pkg_1');
    const stock3 = await getPackageStockStatus('pkg_3');
    const stock5 = await getPackageStockStatus('pkg_5');

    const stockText = `📦 *Stock Management Panel* 📦\n\n` +
                      `নিচের বাটনগুলো ক্লিক করে প্যাকেজের স্টক অন/অফ (In Stock / Out of Stock) করুন:\n\n` +
                      `• **1 Account:** ${stock1 ? '🟢 In Stock' : '🔴 Out of Stock'}\n` +
                      `• **3 Accounts:** ${stock3 ? '🟢 In Stock' : '🔴 Out of Stock'}\n` +
                      `• **5 Accounts:** ${stock5 ? '🟢 In Stock' : '🔴 Out of Stock'}`;

    return ctx.editMessageText(stockText, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [
                Markup.button.callback(stock1 ? '🔴 Set 1 Acc Out of Stock' : '🟢 Set 1 Acc In Stock', 'toggle_stock_pkg_1'),
            ],
            [
                Markup.button.callback(stock3 ? '🔴 Set 3 Acc Out of Stock' : '🟢 Set 3 Acc In Stock', 'toggle_stock_pkg_3'),
            ],
            [
                Markup.button.callback(stock5 ? '🔴 Set 5 Acc Out of Stock' : '🟢 Set 5 Acc In Stock', 'toggle_stock_pkg_5'),
            ],
            [Markup.button.callback('⬅️ Back to Control Panel', 'bot_control_back')]
        ])
    });
});

// Admin Management Action Handlers
bot.action('open_admin_mgmt_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showAdminManagementMenu(ctx);
});

bot.action('admin_back_to_main', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showBotControlPanel(ctx);
});

bot.action('admin_today_status', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const stats = await getSalesReportStats();
    const pendingOrders = (await db.getPendingOrders()) || [];
    const allUsers = (await db.getAllUsers()) || [];
    const bannedUsers = await db.getAllBannedUsers();
    const isMaintenance = await getMaintenanceMode();

    const statusMsg = 
        `📈 *Today's Overall Status Report*\n\n` +
        `• **Bot Mode:** ${isMaintenance ? '🔴 Maintenance ON' : '🟢 Operational ON'}\n` +
        `• **Today's Revenue:** *${stats.todayRevenue} TK*\n` +
        `• **This Month's Revenue:** *${stats.monthRevenue} TK*\n` +
        `• **Total Completed Orders:** *${stats.totalCount}*\n` +
        `• **Pending Orders Verification:** *${pendingOrders.length}*\n` +
        `• **Total Registered Users:** *${allUsers.length}*\n` +
        `• **Total Banned Users:** *${bannedUsers.length}*\n\n` +
        `⏱️ *Last Updated:* ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })}`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Status', 'admin_today_status')],
        [Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]
    ]);

    return ctx.editMessageText(statusMsg, { parse_mode: 'Markdown', ...keyboard });
});

bot.action('admin_user_status', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_user_status_id' });
    return ctx.reply("👤 *User Status Check*\n\nঅনুগ্রহ করে যে ইউজারের বিবরণ দেখতে চান তার **Telegram User ID** অথবা **Username** লিখুন (যেমন: `1262396547` বা `@username`):", { parse_mode: 'Markdown' });
});

bot.action('admin_update_joins', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_new_join_link' });
    return ctx.reply("📡 *Update Force Join Link*\n\nনতুন টেলিগ্রাম চ্যানেল/গ্রুপ জয়েন লিংক বা ইউজারনেম লিখে পাঠান:\n(যেমন: `https://t.me/OWLProxyBotGroup` অথবা `@OWL ProxyGroup`)", { parse_mode: 'Markdown' });
});

bot.action('admin_live_services', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const stock1 = await getPackageStockStatus('pkg_1');
    const stock3 = await getPackageStockStatus('pkg_3');
    const stock5 = await getPackageStockStatus('pkg_5');
    const isMaintenance = await getMaintenanceMode();
    const isSellingHours = await getSellingHoursStatus();

    const liveText = 
        `🛰️ *Live Bot Services Status*\n\n` +
        `• **Core System:** ${isMaintenance ? '🔴 Maintenance' : '🟢 Operational'}\n` +
        `• **Selling Schedule:** ${isSellingHours ? '🕒 11am-11pm Limit' : '⚡ 24 Hours Active'}\n` +
        `• **Package 1 Acc:** ${stock1 ? '🟢 Available' : '🔴 Out of Stock'}\n` +
        `• **Package 3 Acc:** ${stock3 ? '🟢 Available' : '🔴 Out of Stock'}\n` +
        `• **Package 5 Acc:** ${stock5 ? '🟢 Available' : '🔴 Out of Stock'}\n\n` +
        `কন্ট্রোল প্যানেল থেকে স্টক বা টাইমিং পরিবর্তন করতে পারবেন।`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📦 Manage Stock', 'stock_menu')],
        [Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]
    ]);

    return ctx.editMessageText(liveText, { parse_mode: 'Markdown', ...keyboard });
});

const CUSTOMIZABLE_ITEMS = {
    // User Bot Main Buttons & Screens
    'WELCOME': { name: '💎 Welcome Message (/start)', defaultMsg: 'স্বাগতম আমাদের শপে!', defaultLabel: 'Welcome Message' },
    'DETAILS': { name: '📦 OWL Proxy Details (Package Info Screen)', defaultMsg: 'OWL Proxy এন্টি-ডিটেক্ট ব্রাউজার প্যাকেজ বিবরণ:', defaultLabel: 'OWL Proxy Details' },
    'BUY_NOW': { name: '🛒 BUY NOW (Main Button & Options Title)', defaultMsg: 'OWL Proxy প্যাকেজসমূহ সিলেক্ট করুন:', defaultLabel: 'Buy Now' },
    'PROFILE': { name: '👤 PROFILE (Main Button & Screen Title)', defaultMsg: 'আপনার অ্যাকাউন্ট প্রোফাইল বিবরণ:', defaultLabel: 'My Profile' },
    'MY_ORDER': { name: '🛍 MY ORDER (Main Button & Screen Title)', defaultMsg: 'আপনার পূর্বের অর্ডারসমূহ:', defaultLabel: 'My Order' },
    'NOTICE': { name: '📢 OFFERS & NOTICE (Main Button & Notice Title)', defaultMsg: 'সাম্প্রতিক নোটিশ ও অফার:', defaultLabel: 'Offers & Notice' },
    'FAQ': { name: '❓ FAQ & HELP GUIDE (FAQ Screen Text)', defaultMsg: 'সাধারণ জিজ্ঞাসা ও সাহায্য নির্দেশিকা:', defaultLabel: 'FAQ & Help Guide' },
    'LEADERBOARD': { name: '🏆 LEADERBOARD (Leaderboard Screen Title)', defaultMsg: 'সর্বোচ্চ ক্রয়কারী গ্রাহকদের তালিকা:', defaultLabel: 'Leaderboard' },
    'SUPPORT': { name: '📞 SUPPORT (Admin 1 Telegram Username)', defaultMsg: '@prime8088', defaultLabel: 'Contact Support' },
    'SUPPORT_USER_2': { name: '👨‍💻 SUPPORT: Admin 2 Telegram Username', defaultMsg: '@prime8088', defaultLabel: 'Admin 2 Support' },
    'SUPPORT_WA': { name: '📲 SUPPORT: WhatsApp Number', defaultMsg: '8801864339154', defaultLabel: 'WhatsApp Support' },
    'VERIFY_JOIN': { name: '🔄 VERIFY JOIN (Force Join Screen Title)', defaultMsg: 'গ্রুপে জয়েন করে ভেরিফাই করুন:', defaultLabel: 'Verify / Check Join' },
    'REF_BONUS': { name: '🎁 REFERRAL (Referral Reward Amount)', defaultMsg: '৩ টাকা ডিসকাউন্ট কুপন বোনাস', defaultLabel: 'Referral Bonus' },

    // Gateways
    'BKASH': { name: '🌸 PAYMENT: bKash Gateway Number', defaultMsg: '01864339154', defaultLabel: 'bKash Gateway' },
    'NAGAD': { name: '🍑 PAYMENT: Nagad Gateway Number', defaultMsg: '01864339154', defaultLabel: 'Nagad Gateway' },
    'BINANCE': { name: '🟡 PAYMENT: Binance Pay ID', defaultMsg: '955102483', defaultLabel: 'Binance Pay' },
    'PAYONEER': { name: '🔷 PAYMENT: Payoneer Email', defaultMsg: 'mithuchandra647@gmail.com', defaultLabel: 'Payoneer Email' },

    // Reseller & Package Buttons
    'RESELLER_BADGE': { name: '👔 RESELLER: VIP Reseller Rank Badge', defaultMsg: 'VIP VERIFIED RESELLER', defaultLabel: 'VIP Reseller Badge' },
    'PKG_1': { name: '🦉 PACKAGE 1: OWL Proxy Account (35 TK)', defaultMsg: 'OWL Proxy Account — 35 TK [200MB]', defaultLabel: 'OWL Proxy Account — 35 TK' },
    'PKG_2': { name: '🦉 PACKAGE 2: OWL Proxy 1 Pis (30 TK)', defaultMsg: 'OWL Proxy 1 Pis — 30 TK [200MB]', defaultLabel: 'OWL Proxy 1 Pis — 30 TK' },
    'PKG_3': { name: '🆓 PACKAGE 3: FREE PROXY 10 IPs (20 TK)', defaultMsg: 'FREE PROXY — 10 IPs — 20 TK [1GB]', defaultLabel: 'FREE PROXY 10 IPs — 20 TK' },

    // Admin Control Panel Buttons & Actions
    'ADMIN_PENDING_ORDERS': { name: '📥 ADMIN: Pending Orders Menu', defaultMsg: 'পেন্ডিং অর্ডার এপ্রুভাল প্যানেল', defaultLabel: 'Pending Orders' },
    'ADMIN_TOTAL_USERS': { name: '👥 ADMIN: Total Users Stats', defaultMsg: 'বটের নিবন্ধিত কাস্টমার পরিসংখ্যান', defaultLabel: 'Total Bot Users' },
    'ADMIN_BROADCAST': { name: '📢 ADMIN: Broadcast Message', defaultMsg: 'ইউজারদের বাল্ক মেসেজ নোটিফিকেশন', defaultLabel: 'Broadcast' },
    'ADMIN_SALES_REPORT': { name: '📊 ADMIN: Sales Report', defaultMsg: 'বিক্রির বিবরণ ও সেলস রিপোর্ট', defaultLabel: 'Sales Report' },
    'ADMIN_COUPONS': { name: '🎟️ ADMIN: Discount Coupons', defaultMsg: 'ডিসকাউন্ট কুপন ম্যানেজমেন্ট', defaultLabel: 'Coupons' },
    'ADMIN_TODAY_STATUS': { name: '📈 ADMIN: Today All Status', defaultMsg: 'আজকের ওভারঅল স্ট্যাটাস রিপোর্ট', defaultLabel: 'Today All Status' },
    'ADMIN_USER_STATUS': { name: '👤 ADMIN: User Status Check', defaultMsg: 'ইউজার অ্যাকাউন্ট তথ্য ও ব্যালেন্স', defaultLabel: 'User Status Check' },
    'ADMIN_UPDATE_JOINS': { name: '📡 ADMIN: Update Joins', defaultMsg: 'চ্যানেল/গ্রুপ জয়েনিং লিংক আপডেট', defaultLabel: 'Update Joins' },
    'ADMIN_LIVE_SERVICES': { name: '🛰️ ADMIN: Live Services', defaultMsg: 'বট সার্ভিসের লাইভ মনিটরিং', defaultLabel: 'Live Services' },
    'ADMIN_BAN_USER': { name: '⛔ ADMIN: Ban User', defaultMsg: 'ইউজার ব্যান করার অ্যাকশন', defaultLabel: 'Ban User' },
    'ADMIN_UNBAN_USER': { name: '🔓 ADMIN: Unban User', defaultMsg: 'ইউজার আনব্যান করার অ্যাকশন', defaultLabel: 'Unban User' },
    'ADMIN_BAN_LIST': { name: '📜 ADMIN: Ban User List', defaultMsg: 'ব্যানড ইউজারের তালিকা প্যানেল', defaultLabel: 'Ban User List' },
    'ADMIN_ADD_BALANCE': { name: '➕ ADMIN: Add Balance', defaultMsg: 'ইউজার অ্যাকাউন্টে ব্যালেন্স যোগ', defaultLabel: 'Add Balance' },
    'ADMIN_REMOVE_BALANCE': { name: '➖ ADMIN: Remove Balance', defaultMsg: 'ইউজার অ্যাকাউন্ট থেকে ব্যালেন্স কর্তন', defaultLabel: 'Remove Balance' },
    'ADMIN_STOCK_MGMT': { name: '📦 ADMIN: Manage Stock', defaultMsg: 'প্যাকেজের স্টক ইন/আউট কন্ট্রোল', defaultLabel: 'Manage Stock' }
};

async function showCustomizeItemCard(ctx, itemKey) {
    const item = CUSTOMIZABLE_ITEMS[itemKey] || { name: itemKey, defaultMsg: 'ডিফল্ট টেক্সট', defaultLabel: itemKey };
    
    let defaultVal = item.defaultMsg;
    if (['BKASH', 'NAGAD', 'BINANCE', 'PAYONEER'].includes(itemKey)) {
        defaultVal = await getWallet(itemKey.toLowerCase());
    }

    const label = await getCustomText(`LABEL_${itemKey}`, item.defaultLabel);
    const msg = await getCustomText(`MSG_${itemKey}`, defaultVal);
    const emojiId = await getCustomText(`EMOJIID_${itemKey}`, '');
    const emojiTag = await getItemEmojiTag(itemKey, '💡');

    const cardText = 
        `╔══════════════════════════╗\n` +
        `👑 <b>LIVE ITEM CUSTOMIZER HUB</b>\n` +
        `╚══════════════════════════╝\n\n` +
        `🏷️ <b>Target Feature:</b> <code>${item.name}</code>\n` +
        `🆔 <b>Key ID:</b> <code>${itemKey}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📌 <b>Current Button Title / Label:</b>\n` +
        `<code>${label}</code>\n\n` +
        `📝 <b>Current Display Message:</b>\n` +
        `<blockquote>${emojiTag} ${msg}</blockquote>\n\n` +
        `✨ <b>Active Premium Custom Emoji:</b>\n` +
        `${emojiTag} (ID: <code>${emojiId || 'Default Animated Emoji'}</code>)\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👇 <i>নিচের বাটনগুলো ক্লিক করে মুহূর্তেই এডিট বা পরিবর্তন করুন:</i>`;

    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('🏷️ Edit Button Label', `edit_item_label_${itemKey}`),
            Markup.button.callback('📝 Edit Display Message', `edit_item_msg_${itemKey}`)
        ],
        [
            Markup.button.callback('✨ Set Premium Emoji ID', `edit_item_emojiid_${itemKey}`)
        ],
        [
            Markup.button.callback('⬅️ Back to Customizer List', 'admin_customize_texts'),
            Markup.button.callback('🎛️ Admin Control Panel', 'open_admin_mgmt_menu')
        ]
    ]);

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(cardText, { parse_mode: 'HTML', ...keyboard });
        } catch(e) {
            await ctx.reply(cardText, { parse_mode: 'HTML', ...keyboard });
        }
    } else {
        await ctx.reply(cardText, { parse_mode: 'HTML', ...keyboard });
    }
}

bot.action(/^admin_customize_texts(?:_page_(\d+))?$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const page = parseInt(ctx.match[1] || '1');
    const itemsPerPage = 8;
    const keys = Object.keys(CUSTOMIZABLE_ITEMS);
    const totalPages = Math.ceil(keys.length / itemsPerPage);
    const startIdx = (page - 1) * itemsPerPage;
    const currentKeys = keys.slice(startIdx, startIdx + itemsPerPage);

    const inlineButtons = currentKeys.map(k => [
        Markup.button.callback(`⚙️ ${CUSTOMIZABLE_ITEMS[k].name}`, `cust_card_${k}`)
    ]);

    const navRow = [];
    if (page > 1) {
        navRow.push(Markup.button.callback('⬅️ Previous Page', `admin_customize_texts_page_${page - 1}`));
    }
    if (page < totalPages) {
        navRow.push(Markup.button.callback('Next Page ➡️', `admin_customize_texts_page_${page + 1}`));
    }
    if (navRow.length > 0) {
        inlineButtons.push(navRow);
    }

    inlineButtons.push([Markup.button.callback('🔙 Back to Control Panel', 'open_admin_mgmt_menu')]);

    const textMsg = `🛠️ *LIVE BOT TEXTS & BUTTON CUSTOMIZER* 🛠️\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `> *বটের সকল বাটন, মেসেজ ও কাস্টম অ্যানিমেটেড প্রিমিয়াম ইমোজি ১-ক্লিকে এডিট করার প্যানেল (Page ${page}/${totalPages}):*\n\n` +
                    `📌 *নিচের আইটেমগুলো থেকে যেটি এডিট করতে চান সেটিতে ক্লিক করুন:*`;

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(textMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(inlineButtons) });
        } catch(e) {
            await ctx.reply(textMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(inlineButtons) });
        }
    } else {
        await ctx.reply(textMsg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(inlineButtons) });
    }
});

bot.action(/^cust_card_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const itemKey = ctx.match[1];
    return showCustomizeItemCard(ctx, itemKey);
});

bot.action(/^edit_item_(label|msg|emojiid)_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const field = ctx.match[1];
    const itemKey = ctx.match[2];
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: `waiting_for_card_${field}_${itemKey}` });
    
    if (field === 'label') {
        return ctx.reply(`🏷️ *Edit Label for ${itemKey}*\n\nনতুন **Label / বাটন নাম** লিখে পাঠান:`, { parse_mode: 'Markdown' });
    } else if (field === 'msg') {
        return ctx.reply(`📝 *Edit Message for ${itemKey}*\n\nনতুন **Message / টেক্সট বিবরণ** লিখে পাঠান:`, { parse_mode: 'Markdown' });
    } else if (field === 'emojiid') {
        return ctx.reply(`✨ *Edit Premium Emoji ID for ${itemKey}*\n\nনতুন **Telegram Premium Emoji ID** লিখে পাঠান (যেমন: \`6206112371308500200\`):`, { parse_mode: 'Markdown' });
    }
});

bot.action('edit_welcome_msg', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_welcome_msg' });
    return ctx.reply("💎 *Edit Welcome Message*\n\nনতুন **Welcome Message** লিখে পাঠান (ইউজারের নাম দেখাতে `{name}` ব্যবহার করতে পারেন):", { parse_mode: 'Markdown' });
});

bot.action('edit_buy_now_title', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_buy_now_title' });
    return ctx.reply("🛒 *Edit Buy Now Title*\n\nনতুন **Buy Now/প্যাকেজ টেক্সট** লিখে পাঠান:", { parse_mode: 'Markdown' });
});

bot.action('edit_profile_title', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_profile_title' });
    return ctx.reply("👤 *Edit Profile Title*\n\nনতুন **Profile টেক্সট** লিখে পাঠান:", { parse_mode: 'Markdown' });
});

bot.action('edit_my_order_title', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_my_order_title' });
    return ctx.reply("🛍 *Edit My Order Title*\n\nনতুন **My Order টেক্সট** লিখে পাঠান:", { parse_mode: 'Markdown' });
});

bot.action('edit_faq_text', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_faq_text' });
    return ctx.reply("❓ *Edit FAQ Text*\n\nনতুন **FAQ & Help Guide টেক্সট** লিখে পাঠান:", { parse_mode: 'Markdown' });
});

bot.action('edit_leaderboard_title', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_leaderboard_title' });
    return ctx.reply("🏆 *Edit Leaderboard Title*\n\nনতুন **Leaderboard টেক্সট** লিখে পাঠান:", { parse_mode: 'Markdown' });
});

bot.action('edit_support_username', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    await updateAdminSession(ctx.from.id.toString(), { step: 'waiting_for_support_username' });
    return ctx.reply("📞 *Edit Support Admin Username*\n\nনতুন **Admin Username** লিখে পাঠান (যেমন: `@prime8088`):", { parse_mode: 'Markdown' });
});

bot.action('admin_ban_user', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_ban_user_id' });
    return ctx.reply("⛔ *Ban User*\n\nযে ইউজারকে ব্যান করতে চান তার **Telegram User ID** লিখুন:", { parse_mode: 'Markdown' });
});

bot.action('admin_unban_user', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_unban_user_id' });
    return ctx.reply("🔓 *Unban User*\n\nযে ইউজারকে আনব্যান করতে চান তার **Telegram User ID** লিখুন:", { parse_mode: 'Markdown' });
});

bot.action('admin_ban_list', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();

    const bannedList = await db.getAllBannedUsers();
    if (!bannedList || bannedList.length === 0) {
        const emptyMsg = `📜 *Banned Users List*\n\nবর্তমানে কোনো ইউজার ব্যান তালিকায় নেই। 🟢`;
        return ctx.editMessageText(emptyMsg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]])
        });
    }

    let listText = `📜 *Banned Users List (${bannedList.length})*\n\n`;
    const buttons = [];
    bannedList.forEach(id => {
        listText += `• User ID: \`${id}\`\n`;
        buttons.push([Markup.button.callback(`🔓 Unban User ${id}`, `unban_id_${id}`)]);
    });

    buttons.push([Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]);

    return ctx.editMessageText(listText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^ban_id_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const targetId = ctx.match[1];
    await db.banUser(targetId);
    await ctx.answerCbQuery(`User ${targetId} Banned!`);
    return ctx.reply(`⛔ ইউজার ID \`${targetId}\` কে সফলভাবে **ব্যান** করা হয়েছে!`, { parse_mode: 'Markdown' });
});

bot.action(/^unban_id_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    const targetId = ctx.match[1];
    await db.unbanUser(targetId);
    await ctx.answerCbQuery(`User ${targetId} Unbanned!`);
    return ctx.reply(`🔓 ইউজার ID \`${targetId}\` কে সফলভাবে **আনব্যান** করা হয়েছে!`, { parse_mode: 'Markdown' });
});

bot.action('admin_add_balance', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_add_balance' });
    return ctx.reply("➕ *Add User Balance*\n\nইউজার ID এবং টাকার পরিমাণ স্পেস দিয়ে লিখে পাঠান:\n*(ফরম্যাট: `User_ID Amount` - যেমন: `1262396547 500`)*", { parse_mode: 'Markdown' });
});

bot.action('admin_remove_balance', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_remove_balance' });
    return ctx.reply("➖ *Remove User Balance*\n\nইউজার ID এবং টাকার পরিমাণ স্পেস দিয়ে লিখে পাঠান:\n*(ফরম্যাট: `User_ID Amount` - যেমন: `1262396547 100`)*", { parse_mode: 'Markdown' });
});

bot.action('admin_pending_orders', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showPendingOrdersMenu(ctx);
});

bot.action('admin_total_users', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showTotalUsersStats(ctx);
});

bot.action('admin_broadcast_prompt', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const adminId = ctx.from.id.toString();
    await updateAdminSession(adminId, { step: 'waiting_for_broadcast' });
    return ctx.reply("📢 *Broadcast Message*\n\nআপনার ব্রডকাস্ট মেসেজটি (লেখা বা ছবি) পাঠান যা সকল ইউজারের কাছে একসাথে চলে যাবে:", { parse_mode: 'Markdown' });
});

bot.action('admin_coupons_menu', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    return showCouponsMenu(ctx);
});

bot.action('admin_sales_report', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery();
    const stats = await getSalesReportStats();
    const reportText = 
        `📊 *OWL Proxy Bot Sales Report* 📊\n\n` +
        `• Total Completed Sales: *${stats.totalCount}*\n` +
        `• Total Revenue: *${stats.totalRevenue} TK*\n\n` +
        `• Today's Sales: *${stats.todayRevenue} TK*\n` +
        `• This Month's Sales: *${stats.monthRevenue} TK*\n\n` +
        `❤️ Keep hustling! Keep selling! 🚀`;
    return ctx.reply(reportText, { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📥 Download CSV Report', 'download_sales_csv')],
            [Markup.button.callback('🔙 Back to Management', 'open_admin_mgmt_menu')]
        ])
    });
});

bot.action('admin_close', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Unauthorized!", { show_alert: true });
    await ctx.answerCbQuery("Admin Panel Closed.");
    try {
        await ctx.deleteMessage();
    } catch(e) {}
});

async function runExpiryCheck(req, res) {
    try {
        if (!db.isConfigured()) {
            return res.status(200).json({ message: "Database not configured, skipping cron." });
        }
        
        const completedOrders = await db.getCompletedOrders();
        if (!completedOrders || completedOrders.length === 0) {
            return res.status(200).json({ status: "success", message: "No completed orders found." });
        }
        
        const now = new Date();
        let remindersSent = 0;
        
        for (const ord of completedOrders) {
            if (!ord.created_at || !ord.user_id) continue;
            
            const orderDate = new Date(ord.created_at);
            const diffTime = Math.abs(now - orderDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            // If it has been exactly 9 days (warning)
            if (diffDays === 9) {
                try {
                    await bot.telegram.sendMessage(
                        ord.user_id,
                        `⚠️ *OWL Proxy Package Expiry Reminder* ⚠️\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `প্রিয় গ্রাহক, আপনার ক্রয়কৃত প্যাকেজ \`${ord.package_name || 'OWL Proxy'}\` এর মেয়াদ আগামীকাল শেষ হতে যাচ্ছে।\n\n` +
                        `🛒 নির্বিঘ্ন সেবা বজায় রাখতে এখনই রিনিউ করতে /start এ যান! 🚀`,
                        { parse_mode: 'Markdown' }
                    );
                    remindersSent++;
                } catch (err) {
                    console.error(`Failed to send renewal reminder to ${ord.user_id}:`, err.message);
                }
            }
        }
        
        return res.status(200).json({ status: "success", remindersSent });
    } catch (err) {
        console.error("Cron expiry check error:", err.message);
        return res.status(500).json({ error: err.message });
    }
}

// Vercel Serverless Function Handler
module.exports = async (req, res) => {
    if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN.includes('YOUR_BOT_TOKEN') || process.env.BOT_TOKEN.trim().length < 10) {
        return res.status(200).json({
            status: 'warning',
            message: '⚠️ BOT_TOKEN is missing in Vercel Environment Variables! Please add BOT_TOKEN in Vercel Settings -> Environment Variables and Redeploy.'
        });
    }

    if (req.method === 'POST') {
        try {
            const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            if (update) {
                await bot.handleUpdate(update);
            }
            return res.status(200).json({ status: 'ok' });
        } catch (e) {
            console.error("Webhook handleUpdate error:", e.message);
            return res.status(200).json({ status: 'error', message: e.message });
        }
    } else {
        try {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            if (url.searchParams.get('cron') === 'expiry_check') {
                return await runExpiryCheck(req, res);
            }
            if (url.searchParams.get('cron') === 'fake_sales') {
                const count = parseInt(url.searchParams.get('count') || '2');
                for (let i = 0; i < Math.min(count, 5); i++) {
                    await sendFakeSaleToGroup();
                    if (i < count - 1) await new Promise(r => setTimeout(r, 3000));
                }
                return res.status(200).json({ status: "success", message: `Fake sales triggered (${count} posts sent to group).` });
            }

            let webhookStatus = "not_set";
            if (req.headers.host && !req.headers.host.includes('localhost') && !req.headers.host.includes('127.0.0.1')) {
                try {
                    await bot.telegram.setMyCommands([
                        { command: 'start', description: 'Start the bot / প্রধান মেনু 🚀' }
                    ]);
                    const hostName = req.headers.host;
                    const webhookUrl = `https://${hostName}/api/bot.js`;
                    await bot.telegram.setWebhook(webhookUrl, {
                        allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query', 'inline_query', 'my_chat_member', 'chat_member']
                    });
                    webhookStatus = `Webhook updated to ${webhookUrl}`;
                } catch (setupErr) {
                    webhookStatus = `Webhook error: ${setupErr.message}`;
                }
            }
            return res.status(200).json({
                message: 'OWL Proxy Bot is running successfully!',
                webhook: webhookStatus
            });
        } catch (err) {
            console.error("GET handler error:", err.message);
            return res.status(200).json({ message: 'OWL Proxy Bot is running successfully!' });
        }
    }
};

// Catch Telegraf errors to prevent process crash on network glitches
bot.catch((err, ctx) => {
    console.error(`Telegraf error for ${ctx ? ctx.updateType : 'unknown'}:`, err.message);
});

// Start persistent launch if run directly (VPS / Local Hosting) with auto-retry
async function launchWithRetry() {
    try {
        try {
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            console.log("Cleared old webhook for long-polling mode.");
        } catch (wErr) {
            console.log("Webhook delete notice:", wErr.message);
        }

        // Start fake sales interval before bot.launch (which blocks until stop)
        setInterval(async () => {
            await sendFakeSaleToGroup();
        }, 30000);
        // Send initial fake sale right away on start
        sendFakeSaleToGroup().catch(e => console.error("Initial fake sale error:", e.message));

        console.log("Bot launching in persistent mode (Long-Polling)...");
        console.log("Notice: Long-polling temporarily overrides Vercel Webhook. Visit your Vercel URL to restore Webhook when done.");
        await bot.launch();
    } catch (err) {
        console.error("Bot launch failed (network timeout), retrying in 5 seconds...", err.message);
        setTimeout(launchWithRetry, 5000);
    }
}

try {
    const isDirectRun = (typeof require !== 'undefined' && require.main === module);
    if (isDirectRun || process.env.PERSISTENT === 'true') {
        launchWithRetry();
    }
} catch (e) {
    console.error("Failed to check direct run mode:", e.message);
}

