import { fetchFxTwitterStatus, normalizeStatusUrl } from './parser.js';

const CACHE_KEY = 'xnc_post_cache_v1';
const MAX_CACHE_ENTRIES = 500;
const MAX_TARGETS_PER_BATCH = 12;
const FETCH_CONCURRENCY = 3;

let writeQueue = Promise.resolve();

function isAllowedSender(sender) {
  try {
    const url = new URL(sender?.url || sender?.tab?.url || '');
    return /^(?:x|twitter)\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

async function readCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const raw = stored?.[CACHE_KEY];
  return raw && typeof raw === 'object' ? raw : {};
}

async function mergeIntoCache(updates) {
  const entries = Object.entries(updates || {}).filter(
    ([tid, info]) => /^\d{1,25}$/.test(tid) && typeof info?.text === 'string' && info.text.trim()
  );
  if (!entries.length) return;

  writeQueue = writeQueue.then(async () => {
    const cache = await readCache();
    const now = Date.now();
    for (const [tid, info] of entries) {
      cache[tid] = {
        text: info.text.trim(),
        url: String(info.url || cache[tid]?.url || ''),
        updatedAt: now
      };
    }

    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHE_ENTRIES) {
      keys
        .sort((a, b) => (cache[a]?.updatedAt || 0) - (cache[b]?.updatedAt || 0))
        .slice(0, keys.length - MAX_CACHE_ENTRIES)
        .forEach((k) => {
          delete cache[k];
        });
    }

    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  });

  await writeQueue;
}

async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(workers);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isAllowedSender(sender)) {
    sendResponse({ ok: false, error: 'Unauthorized origin' });
    return false;
  }

  if (message?.type === 'CACHE_POSTS') {
    mergeIntoCache(message.posts)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'RESOLVE_TWEETS') {
    Promise.resolve()
      .then(async () => {
        const rawTargets = Array.isArray(message.targets) ? message.targets : [];
        const deduped = [];
        const seen = new Set();
        for (const item of rawTargets) {
          const tid = String(item?.tweetId || '').trim();
          if (!/^\d{1,25}$/.test(tid) || seen.has(tid)) continue;
          seen.add(tid);
          deduped.push({
            tweetId: tid,
            handle: String(item?.handle || '').trim().replace(/^@+/, '')
          });
        }

        const cache = await readCache();
        const posts = {};
        const toFetch = [];

        for (const target of deduped) {
          const hit = cache[target.tweetId];
          if (hit?.text) {
            posts[target.tweetId] = {
              text: String(hit.text),
              url: String(hit.url || normalizeStatusUrl('', target.tweetId, target.handle))
            };
          } else if (toFetch.length < MAX_TARGETS_PER_BATCH) {
            toFetch.push(target);
          }
        }

        const newlyFetched = {};
        const unresolved = [];

        await runWithConcurrency(toFetch, FETCH_CONCURRENCY, async (target) => {
          const res = await fetchFxTwitterStatus(target.handle || 'i', target.tweetId);
          if (res.ok && res.exists && res.text) {
            const url = res.url || normalizeStatusUrl('', target.tweetId, target.handle);
            posts[target.tweetId] = { text: res.text, url };
            newlyFetched[target.tweetId] = { text: res.text, url };
          } else {
            unresolved.push(target.tweetId);
          }
        });

        if (Object.keys(newlyFetched).length) {
          await mergeIntoCache(newlyFetched);
        }

        sendResponse({ ok: true, posts, unresolved });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: String(error?.message || error) });
      });
    return true;
  }

  return false;
});
