/* ============================================================
   JCW Approved Leaves - shared by the page (index.html) and the
   service worker (sw.js): storage on the phone, server calls,
   and sending the queue of saved changes.
   ============================================================ */

// Paste the URL of the API deployment (Execute as: Me, Who has access: Anyone)
const API_URL = 'PASTE_API_DEPLOYMENT_URL_HERE';

const DB_NAME = 'jcw-leaves', DB_STORE = 'kv';
let _db = null;

function idbOpen() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const q = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function kvSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction(DB_STORE, 'readwrite');
    t.objectStore(DB_STORE).put(val, key);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

// Changes to the queue always go through this lock, so the page and
// the service worker never overwrite each other's edits.
function withQueueLock(fn) {
  if (self.navigator && navigator.locks) return navigator.locks.request('jcw-leave-queue', fn);
  return fn();
}

async function apiCall(action, payload, timeoutMs) {
  if (!/^https:\/\/script\.google\.com\//.test(API_URL)) throw new Error('API_URL is not set in sync.js.');
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 60000) : null;
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // no CORS preflight
      body: JSON.stringify(Object.assign({ action }, payload || {})),
      signal: ctrl ? ctrl.signal : undefined,
      redirect: 'follow'
    });
    if (!r.ok) throw new Error('Server error ' + r.status);
    const text = await r.text();
    try { return JSON.parse(text); }
    catch (e) { throw new Error('Server did not answer properly. Check the API deployment access is "Anyone".'); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The server took too long. Will try again.');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Send waiting changes in order. Returns
// {sent, failed, sentOps, authError} or {busy:true} if another sender is running.
async function syncQueue() {
  const run = async () => {
    const token = await kvGet('token');
    if (!token) return { sent: 0, failed: 0, sentOps: [], noToken: true };
    let sent = 0, failed = 0;
    const sentOps = [];
    for (let round = 0; round < 25; round++) {
      const q = (await kvGet('queue')) || [];
      // up to 40 changes, but keep one call under ~3 MB (photos are big)
      const batch = [];
      let size = 0;
      for (const o of q.filter(o => !o.failed)) {
        const sz = (o.photos || []).reduce((a, p) => a + (p.data ? p.data.length : 0), 0) + 600;
        if (batch.length && (batch.length >= 40 || size + sz > 3000000)) break;
        batch.push(o); size += sz;
      }
      if (!batch.length) break;
      const res = await apiCall('sync', {
        token,
        ops: batch.map(o => ({
          id: o.id, type: o.type, enroll: o.enroll, month: o.month, leaves: o.leaves,
          leaveType: o.leaveType, datesFull: o.datesFull, datesShort: o.datesShort,
          photos: (o.photos || []).map(p => ({ data: p.data }))
        }))
      }, size > 500000 ? 180000 : 60000);
      if (!res.ok) {
        if (res.code === 'AUTH') {
          await kvSet('authError', res.error || 'Please sign in again.');
          return { sent, failed, sentOps, authError: res.error || 'Please sign in again.' };
        }
        throw new Error(res.error || 'Server error');
      }
      const byId = {};
      (res.results || []).forEach(r => { byId[r.id] = r; });
      await withQueueLock(async () => {
        const cur = (await kvGet('queue')) || [];
        const keep = [];
        cur.forEach(o => {
          const r = byId[o.id];
          if (!r) keep.push(o);                         // added meanwhile, or not in this batch
          else if (r.ok) { sent++; sentOps.push(o); }
          else { o.failed = true; o.error = r.error; failed++; keep.push(o); }
        });
        await kvSet('queue', keep);
      });
      await kvSet('lastSync', Date.now());
      if (!(res.results || []).length) break;
    }
    return { sent, failed, sentOps };
  };
  if (self.navigator && navigator.locks) {
    return navigator.locks.request('jcw-leave-send', { ifAvailable: true },
      lock => lock ? run() : { busy: true, sent: 0, failed: 0, sentOps: [] });
  }
  return run();
}
