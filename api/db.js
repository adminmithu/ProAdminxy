const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// High-Speed In-Memory Cache for DB Read Operations (TTL: 60 seconds)
const dbCache = {
  coupons: new Map(), // code -> { value, expiry }
  allCoupons: null,   // { value, expiry }
  banned: new Map()    // userId -> { value, expiry }
};

function getFromCache(map, key) {
  const cached = map.get(key);
  if (cached && Date.now() < cached.expiry) {
    return cached.value;
  }
  if (cached) map.delete(key);
  return undefined;
}

function setToCache(map, key, value, ttlMs = 60000) {
  map.set(key, { value, expiry: Date.now() + ttlMs });
}

function invalidateDBCache(codeKey = null) {
  dbCache.allCoupons = null;
  if (codeKey) {
    dbCache.coupons.delete(codeKey.toUpperCase());
  } else {
    dbCache.coupons.clear();
  }
}

function isConfigured() {
  return supabase !== null;
}

// User Helpers
async function saveUser(userId, firstName, username) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('users')
      .upsert({
        user_id: userId,
        first_name: firstName,
        username: username,
        last_active: new Date().toISOString()
      }, { onConflict: 'user_id' });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Supabase saveUser error:', err.message);
    return null;
  }
}

async function getAllUsers() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Supabase getAllUsers error:', err.message);
    return null;
  }
}

// Order Helpers
async function createOrder(orderData) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('orders')
      .insert({
        user_id: orderData.userId,
        name: orderData.name,
        username: orderData.username,
        package_name: orderData.packageName,
        method: orderData.method,
        proof: orderData.proof,
        status: 'Pending Verification',
        price_paid: orderData.pricePaid || 30
      });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Supabase createOrder error:', err.message);
    return null;
  }
}

async function getUserOrders(userId) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Supabase getUserOrders error:', err.message);
    return null;
  }
}

async function clearUserOrders(userId) {
  if (!supabase) return null;
  try {
    const { error } = await supabase
      .from('orders')
      .delete()
      .eq('user_id', userId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Supabase clearUserOrders error:', err.message);
    return null;
  }
}

async function getPendingOrders() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('status', 'Pending Verification')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Supabase getPendingOrders error:', err.message);
    return null;
  }
}

async function getOrderForUser(userId) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'Pending Verification')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    console.error('Supabase getOrderForUser error:', err.message);
    return null;
  }
}

async function updateOrderStatus(userId, status, customEmail, customPass) {
  if (!supabase) return null;
  try {
    const { error } = await supabase
      .from('orders')
      .update({
        status: status,
        custom_email: customEmail,
        custom_pass: customPass
      })
      .eq('user_id', userId)
      .eq('status', 'Pending Verification');
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Supabase updateOrderStatus error:', err.message);
    return null;
  }
}

async function updateOrderLoginCode(userId, loginCode) {
  if (!supabase) return null;
  try {
    const { error } = await supabase
      .from('orders')
      .update({ login_code: loginCode })
      .eq('user_id', userId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Supabase updateOrderLoginCode error:', err.message);
    return null;
  }
}

async function cancelOrder(userId) {
  if (!supabase) return null;
  try {
    const { error } = await supabase
      .from('orders')
      .update({ status: 'Cancelled' })
      .eq('user_id', userId)
      .eq('status', 'Pending Verification');
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Supabase cancelOrder error:', err.message);
    return null;
  }
}

async function getSalesReport() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('status', 'Completed');
    if (error) throw error;

    let totalCount = data.length;
    let totalRevenue = 0;
    let todayRevenue = 0;
    let monthRevenue = 0;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    data.forEach(ord => {
      const price = (ord.price_paid !== undefined && ord.price_paid !== null) ? ord.price_paid : 30;
      totalRevenue += price;

      const orderDate = new Date(ord.created_at);
      if (orderDate >= startOfToday) {
        todayRevenue += price;
      }
      if (orderDate >= startOfMonth) {
        monthRevenue += price;
      }
    });

    return { totalCount, totalRevenue, todayRevenue, monthRevenue };
  } catch (err) {
    console.error('Supabase getSalesReport error:', err.message);
    return null;
  }
}

// Coupon Helpers
async function getCoupon(code) {
  if (!supabase) return null;
  const upperCode = code.toUpperCase();
  const cached = getFromCache(dbCache.coupons, upperCode);
  if (cached !== undefined) return cached;

  try {
    const { data, error } = await supabase
      .from('coupons')
      .select('*')
      .eq('code', upperCode)
      .limit(1);
    if (error) throw error;
    const result = data && data.length > 0 ? data[0] : null;
    setToCache(dbCache.coupons, upperCode, result, 60000);
    return result;
  } catch (err) {
    console.error('Supabase getCoupon error:', err.message);
    return null;
  }
}

async function createCoupon(code, discountAmount) {
  if (!supabase) return null;
  const upperCode = code.toUpperCase();
  try {
    const { data, error } = await supabase
      .from('coupons')
      .upsert({
        code: upperCode,
        discount_amount: parseInt(discountAmount)
      }, { onConflict: 'code' });
    if (error) throw error;
    invalidateDBCache(upperCode);
    setToCache(dbCache.coupons, upperCode, { code: upperCode, discount_amount: parseInt(discountAmount) }, 60000);
    return true;
  } catch (err) {
    console.error('Supabase createCoupon error:', err.message);
    return null;
  }
}

async function deleteCoupon(code) {
  if (!supabase) return null;
  const upperCode = code.toUpperCase();
  try {
    const { error } = await supabase
      .from('coupons')
      .delete()
      .eq('code', upperCode);
    if (error) throw error;
    invalidateDBCache(upperCode);
    return true;
  } catch (err) {
    console.error('Supabase deleteCoupon error:', err.message);
    return null;
  }
}

async function getAllCoupons() {
  if (!supabase) return null;
  if (dbCache.allCoupons && Date.now() < dbCache.allCoupons.expiry) {
    return dbCache.allCoupons.value;
  }
  try {
    const { data, error } = await supabase
      .from('coupons')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    dbCache.allCoupons = { value: data, expiry: Date.now() + 60000 };
    return data;
  } catch (err) {
    console.error('Supabase getAllCoupons error:', err.message);
    return null;
  }
}

// User Session Helpers
async function getUserSession(userId) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('user_sessions')
      .select('*')
      .eq('user_id', userId)
      .limit(1);
    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    console.error('Supabase getUserSession error:', err.message);
    return null;
  }
}

async function updateUserSession(userId, updateData) {
  if (!supabase) return null;
  try {
    // Map to snake_case database columns
    const dbData = { user_id: userId };
    if (updateData.method !== undefined) dbData.method = updateData.method;
    if (updateData.waitingFor !== undefined) dbData.waiting_for = updateData.waitingFor;
    if (updateData.proof !== undefined) dbData.proof = updateData.proof;
    dbData.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from('user_sessions')
      .upsert(dbData, { onConflict: 'user_id' });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Supabase updateUserSession error:', err.message);
    return null;
  }
}

// Admin Session Helpers
async function getAdminSession(userId) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('admin_sessions')
      .select('*')
      .eq('user_id', userId)
      .limit(1);
    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  } catch (err) {
    console.error('Supabase getAdminSession error:', err.message);
    return null;
  }
}

async function updateAdminSession(userId, updateData) {
  if (!supabase) return null;
  try {
    const dbData = { user_id: userId };
    if (updateData.step !== undefined) dbData.step = updateData.step;
    if (updateData.targetUserId !== undefined) dbData.target_user_id = updateData.targetUserId;
    if (updateData.customEmail !== undefined) dbData.custom_email = updateData.customEmail;
    dbData.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from('admin_sessions')
      .upsert(dbData, { onConflict: 'user_id' });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Supabase updateAdminSession error:', err.message);
    return null;
  }
}

async function clearAdminSession(userId) {
  if (!supabase) return null;
  try {
    const { error } = await supabase
      .from('admin_sessions')
      .delete()
      .eq('user_id', userId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Supabase clearAdminSession error:', err.message);
    return null;
  }
}

async function getCompletedOrders() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('status', 'Completed');
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Supabase getCompletedOrders error:', err.message);
    return null;
  }
}

async function checkIfProofExists(proof) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('proof')
      .eq('proof', proof)
      .limit(1);
    if (error) throw error;
    return data && data.length > 0;
  } catch (err) {
    console.error('Supabase checkIfProofExists error:', err.message);
    return null;
  }
}

async function getAllOrders() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Supabase getAllOrders error:', err.message);
    return null;
  }
}

// Ban Management Helpers (using coupon storage fallback for zero schema disruption)
async function banUser(userId) {
  if (!supabase) return true;
  try {
    await createCoupon(`BAN_USER|${userId}`, 0);
    setToCache(dbCache.banned, userId.toString(), true, 60000);
    return true;
  } catch (err) {
    console.error('Supabase banUser error:', err.message);
    return false;
  }
}

async function unbanUser(userId) {
  if (!supabase) return true;
  try {
    await deleteCoupon(`BAN_USER|${userId}`);
    setToCache(dbCache.banned, userId.toString(), false, 60000);
    return true;
  } catch (err) {
    console.error('Supabase unbanUser error:', err.message);
    return false;
  }
}

async function isUserBanned(userId) {
  if (!supabase) return false;
  const strId = userId.toString();
  const cached = getFromCache(dbCache.banned, strId);
  if (cached !== undefined) return cached;

  try {
    const coupon = await getCoupon(`BAN_USER|${strId}`);
    const banned = !!coupon;
    setToCache(dbCache.banned, strId, banned, 60000);
    return banned;
  } catch (err) {
    return false;
  }
}

async function getAllBannedUsers() {
  if (!supabase) return [];
  try {
    const coupons = await getAllCoupons();
    if (!coupons) return [];
    return coupons.filter(c => c.code.startsWith('BAN_USER|')).map(c => c.code.split('BAN_USER|')[1]);
  } catch (err) {
    return [];
  }
}

// Balance Management Helpers
let memoryUserBalance = {};

async function getUserBalance(userId) {
  if (!userId) return 0;
  const strId = userId.toString();
  if (!supabase) return memoryUserBalance[strId] || 0;
  try {
    const coupons = await getAllCoupons();
    if (!coupons) return memoryUserBalance[strId] || 0;
    const balCoupon = coupons.find(c => c.code.startsWith(`USER_BAL|${strId}|`));
    if (!balCoupon) return memoryUserBalance[strId] || 0;
    const parts = balCoupon.code.split('|');
    return parseInt(parts[2]) || 0;
  } catch (err) {
    return memoryUserBalance[strId] || 0;
  }
}

async function setUserBalance(userId, amount) {
  if (!userId) return false;
  const strId = userId.toString();
  const val = Math.max(0, parseInt(amount) || 0);
  memoryUserBalance[strId] = val;
  if (!supabase) return true;
  try {
    const coupons = await getAllCoupons();
    if (coupons) {
      const oldBal = coupons.filter(c => c.code.startsWith(`USER_BAL|${strId}|`));
      for (const old of oldBal) {
        await deleteCoupon(old.code);
      }
    }
    await createCoupon(`USER_BAL|${strId}|${val}`, 0);
    return true;
  } catch (err) {
    console.error('Supabase setUserBalance error:', err.message);
    return false;
  }
}

async function addBalanceToUser(userId, amount) {
  const current = await getUserBalance(userId);
  const newBal = current + Math.max(0, parseInt(amount) || 0);
  await setUserBalance(userId, newBal);
  return newBal;
}

async function deductBalanceFromUser(userId, amount) {
  const current = await getUserBalance(userId);
  const newBal = Math.max(0, current - Math.max(0, parseInt(amount) || 0));
  await setUserBalance(userId, newBal);
  return newBal;
}

// Stock Pool Helpers
let memoryStockPool = [];

async function addStockAccount(accountData, pkgType = 'pkg_1') {
  const stockId = `${Date.now()}_${Math.floor(Math.random() * 10000)}_${Math.floor(Math.random() * 1000)}`;
  const code = `STOCK_ITEM|${pkgType}|${stockId}|${accountData.trim()}`;
  if (!supabase) {
    memoryStockPool.push({ id: stockId, pkgType, code, data: accountData.trim(), available: true });
    return true;
  }
  try {
    await createCoupon(code, 1); // 1 = Available
    return true;
  } catch (err) {
    console.error('Supabase addStockAccount error:', err.message);
    return false;
  }
}

async function getAllStockAccounts(targetPkgType = null) {
  if (!supabase) {
    const list = memoryStockPool.map(item => ({
      id: item.id,
      pkgType: item.pkgType || 'pkg_1',
      code: item.code,
      data: item.data,
      available: item.available
    }));
    return targetPkgType ? list.filter(i => i.pkgType === targetPkgType) : list;
  }
  try {
    const coupons = await getAllCoupons();
    if (!coupons) return [];
    const stockCoupons = coupons.filter(c => c.code.startsWith('STOCK_ITEM|'));
    const list = stockCoupons.map(c => {
      const parts = c.code.split('|');
      let pkgType = 'pkg_1';
      let id = parts[1];
      let data = parts.slice(2).join('|');

      if (parts[1] && parts[1].startsWith('pkg_')) {
        pkgType = parts[1];
        id = parts[2];
        data = parts.slice(3).join('|');
      }

      return {
        id: id,
        pkgType: pkgType,
        code: c.code,
        data: data,
        available: c.discount_amount === 1
      };
    });
    return targetPkgType ? list.filter(i => i.pkgType === targetPkgType) : list;
  } catch (err) {
    console.error('Supabase getAllStockAccounts error:', err.message);
    return [];
  }
}

async function popStockAccount(assignedUserId, targetPkgType = 'pkg_1') {
  if (!supabase) {
    const availableIndex = memoryStockPool.findIndex(item => item.available && (item.pkgType || 'pkg_1') === targetPkgType);
    if (availableIndex === -1) return null;
    memoryStockPool[availableIndex].available = false;
    memoryStockPool[availableIndex].assignedTo = assignedUserId;
    return memoryStockPool[availableIndex].data;
  }
  try {
    const allStock = await getAllStockAccounts(targetPkgType);
    const available = allStock.find(item => item.available);
    if (!available) return null;

    // Mark as used/reserved by deleting available item and adding STOCK_USED
    await deleteCoupon(available.code);
    const reservedCode = `STOCK_USED|${available.pkgType}|${available.id}|${assignedUserId}|${available.data}`;
    await createCoupon(reservedCode, 0);

    return available.data;
  } catch (err) {
    console.error('Supabase popStockAccount error:', err.message);
    return null;
  }
}

async function popStockForPlan3(assignedUserId, count = 10) {
  const poppedLines = [];
  for (let i = 0; i < count; i++) {
    const item = await popStockAccount(assignedUserId, 'pkg_3');
    if (item) {
      poppedLines.push(item);
    }
  }
}

async function getAvailableStockCount(targetPkgType = null) {
  const stock = await getAllStockAccounts(targetPkgType);
  return stock.filter(i => i.available).length;
}

// System Allow Custom Email Helper
let memoryAllowCustomEmail = true;

async function getAllowCustomEmailStatus() {
  if (!supabase) return memoryAllowCustomEmail;
  try {
    const coupon = await getCoupon('SYSTEM_ALLOW_CUSTOM_EMAIL');
    if (coupon) {
      return coupon.discount_amount === 1;
    }
    return true; // default enabled
  } catch (err) {
    return true;
  }
}

async function setAllowCustomEmailStatus(enabled) {
  const val = enabled ? 1 : 0;
  if (!supabase) {
    memoryAllowCustomEmail = enabled;
    return true;
  }
  try {
    await createCoupon('SYSTEM_ALLOW_CUSTOM_EMAIL', val);
    return true;
  } catch (err) {
    console.error('Supabase setAllowCustomEmailStatus error:', err.message);
    return false;
  }
}

// Extra Admin Management Helpers
let memoryExtraAdmins = new Set();

async function getExtraAdmins() {
  if (!supabase) return Array.from(memoryExtraAdmins);
  try {
    const coupons = await getAllCoupons();
    if (!coupons) return Array.from(memoryExtraAdmins);
    const adminCoupons = coupons.filter(c => c.code.startsWith('EXTRA_ADMIN|'));
    return adminCoupons.map(c => c.code.split('|')[1]);
  } catch (err) {
    console.error('Supabase getExtraAdmins error:', err.message);
    return Array.from(memoryExtraAdmins);
  }
}

async function addExtraAdmin(userId) {
  memoryExtraAdmins.add(userId.toString());
  if (!supabase) return true;
  try {
    await createCoupon(`EXTRA_ADMIN|${userId}`, 1);
    return true;
  } catch (err) {
    console.error('Supabase addExtraAdmin error:', err.message);
    return false;
  }
}

async function removeExtraAdmin(userId) {
  memoryExtraAdmins.delete(userId.toString());
  if (!supabase) return true;
  try {
    await deleteCoupon(`EXTRA_ADMIN|${userId}`);
    return true;
  } catch (err) {
    console.error('Supabase removeExtraAdmin error:', err.message);
    return false;
  }
}

// Reseller Management Helpers
let memoryResellers = new Set();
let memoryResellerPrices = {
  'pkg_1': 28,
  'pkg_2': 24,
  'pkg_3': 15
};

async function getResellerList() {
  if (!supabase) return Array.from(memoryResellers);
  try {
    const coupons = await getAllCoupons();
    if (!coupons) return Array.from(memoryResellers);
    const resellerCoupons = coupons.filter(c => c.code.startsWith('RESELLER_USER|'));
    return resellerCoupons.map(c => c.code.split('|')[1]);
  } catch (err) {
    console.error('Supabase getResellerList error:', err.message);
    return Array.from(memoryResellers);
  }
}

async function isResellerUser(userId) {
  if (!userId) return false;
  const list = await getResellerList();
  return list.includes(userId.toString());
}

async function addResellerUser(userId) {
  memoryResellers.add(userId.toString());
  if (!supabase) return true;
  try {
    await createCoupon(`RESELLER_USER|${userId}`, 1);
    return true;
  } catch (err) {
    console.error('Supabase addResellerUser error:', err.message);
    return false;
  }
}

async function removeResellerUser(userId) {
  memoryResellers.delete(userId.toString());
  if (!supabase) return true;
  try {
    await deleteCoupon(`RESELLER_USER|${userId}`);
    return true;
  } catch (err) {
    console.error('Supabase removeResellerUser error:', err.message);
    return false;
  }
}

async function getResellerPrice(pkgKey) {
  const dbKey = `RESELLER_PRICE_${pkgKey.toUpperCase()}`;
  if (!supabase) {
    return memoryResellerPrices[pkgKey] !== undefined ? memoryResellerPrices[pkgKey] : (pkgKey === 'pkg_1' ? 28 : (pkgKey === 'pkg_2' ? 24 : 15));
  }
  try {
    const coupon = await getCoupon(dbKey);
    if (coupon && coupon.discount_amount) {
      return coupon.discount_amount;
    }
    return pkgKey === 'pkg_1' ? 28 : (pkgKey === 'pkg_2' ? 24 : 15);
  } catch (err) {
    return pkgKey === 'pkg_1' ? 28 : (pkgKey === 'pkg_2' ? 24 : 15);
  }
}

async function setResellerPrice(pkgKey, price) {
  const dbKey = `RESELLER_PRICE_${pkgKey.toUpperCase()}`;
  memoryResellerPrices[pkgKey] = parseInt(price);
  if (!supabase) return true;
  try {
    await createCoupon(dbKey, parseInt(price));
    return true;
  } catch (err) {
    console.error('Supabase setResellerPrice error:', err.message);
    return false;
  }
}

async function popSpecificStockAccount(stockId, assignedUserId) {
  if (!supabase) {
    const item = memoryStockPool.find(i => i.id === stockId && i.available);
    if (!item) return null;
    item.available = false;
    item.assignedTo = assignedUserId;
    return item.data;
  }
  try {
    const allStock = await getAllStockAccounts();
    const target = allStock.find(item => item.id === stockId && item.available);
    if (!target) return null;

    await deleteCoupon(target.code);
    const reservedCode = `STOCK_USED|${target.id}|${assignedUserId}|${target.data}`;
    await createCoupon(reservedCode, 0);

    return target.data;
  } catch (err) {
    console.error('Supabase popSpecificStockAccount error:', err.message);
    return null;
  }
}

async function deleteStockAccount(code) {
  if (!supabase) {
    memoryStockPool = memoryStockPool.filter(i => i.code !== code);
    return true;
  }
  return await deleteCoupon(code);
}

async function getTopVIPBuyers() {
  try {
    let orders = [];
    if (supabase) {
      orders = await getAllOrders() || [];
    }
    const completed = orders.filter(o => o.status === 'Completed');
    const userStats = {};

    completed.forEach(ord => {
      const uid = ord.user_id;
      if (!userStats[uid]) {
        userStats[uid] = {
          userId: uid,
          name: ord.name || 'User',
          username: ord.username || 'N/A',
          count: 0,
          totalSpent: 0
        };
      }
      userStats[uid].count += 1;
      userStats[uid].totalSpent += parseInt(ord.price_paid || ord.pricePaid || 30);
    });

    const list = Object.values(userStats);
    list.sort((a, b) => b.totalSpent - a.totalSpent);
    return list.slice(0, 10);
  } catch (err) {
    console.error('getTopVIPBuyers error:', err.message);
    return [];
  }
}

async function getFullDatabaseBackupData() {
  try {
    let users = [];
    let orders = [];
    let coupons = [];
    let stock = [];

    if (supabase) {
      users = (await getAllUsers()) || [];
      orders = (await getAllOrders()) || [];
      coupons = (await getAllCoupons()) || [];
      stock = (await getAllStockAccounts()) || [];
    }

    return {
      exportedAt: new Date().toISOString(),
      system: "AdsPower Seller BD Bot",
      totalUsersCount: users.length,
      totalOrdersCount: orders.length,
      users,
      orders,
      coupons,
      stockPool: stock
    };
  } catch (err) {
    console.error('getFullDatabaseBackupData error:', err.message);
    return { exportedAt: new Date().toISOString(), error: err.message };
  }
}

module.exports = {
  isConfigured,
  saveUser,
  getAllUsers,
  createOrder,
  getUserOrders,
  clearUserOrders,
  getPendingOrders,
  getOrderForUser,
  updateOrderStatus,
  updateOrderLoginCode,
  cancelOrder,
  getSalesReport,
  getCoupon,
  createCoupon,
  deleteCoupon,
  getAllCoupons,
  getUserSession,
  updateUserSession,
  getAdminSession,
  updateAdminSession,
  clearAdminSession,
  getCompletedOrders,
  checkIfProofExists,
  getAllOrders,
  banUser,
  unbanUser,
  isUserBanned,
  getAllBannedUsers,
  getUserBalance,
  setUserBalance,
  addBalanceToUser,
  deductBalanceFromUser,
  getResellerList,
  isResellerUser,
  addResellerUser,
  removeResellerUser,
  getResellerPrice,
  setResellerPrice,
  addStockAccount,
  getAllStockAccounts,
  getAvailableStockCount,
  popStockAccount,
  popStockForPlan3,
  popSpecificStockAccount,
  deleteStockAccount,
  getAllowCustomEmailStatus,
  setAllowCustomEmailStatus,
  getExtraAdmins,
  addExtraAdmin,
  removeExtraAdmin,
  getTopVIPBuyers,
  getFullDatabaseBackupData
};




