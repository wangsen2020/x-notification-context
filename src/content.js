(() => {
  if (window.__xncObserverStarted) return;
  window.__xncObserverStarted = true;

  const CARD_CLASS = 'xnc-quote-card';
  const LEGACY_XEF_CLASS = 'xef-notif-quote-card';
  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
  const TWEET_ID_RE = /^\d{1,25}$/;

  const replyMap = new Map();
  const postTextCache = new Map();
  const pendingTargets = new Set();
  const failedTargets = new Set();

  let renderTimer = null;
  let lastPath = '';

  function isZhUi() {
    return String(document.documentElement?.lang || '').toLowerCase().startsWith('zh');
  }

  function labelOriginalPost(handle) {
    const base = isZhUi() ? '原帖' : 'Original post';
    return handle ? `${base} · @${handle}` : base;
  }

  function labelLoading() {
    return isZhUi() ? '正在获取原帖内容…' : 'Loading original post…';
  }

  function isNotificationsPage() {
    return /^\/notifications(?:\/|$)/i.test(location.pathname || '');
  }

  function isValidContext() {
    return (
      typeof chrome !== 'undefined' &&
      Boolean(chrome.runtime?.id) &&
      typeof chrome.runtime?.sendMessage === 'function'
    );
  }

  function unwrapTweet(node) {
    if (!node || typeof node !== 'object') return null;
    return node.tweet && typeof node.tweet === 'object' ? node.tweet : node;
  }

  function tweetTextOf(tweet) {
    if (!tweet || typeof tweet !== 'object') return '';
    const note = tweet.note_tweet?.note_tweet_results?.result?.text;
    if (typeof note === 'string' && note.trim()) return note.trim();
    const full = tweet.legacy?.full_text || tweet.legacy?.text || '';
    return typeof full === 'string' ? full.trim() : '';
  }

  function normalizeStatusUrl(rawUrl, tweetId, handle = '') {
    const raw = String(rawUrl || '').trim();
    if (raw && /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(raw)) {
      return raw.replace(/^https?:\/\/twitter\.com\//i, 'https://x.com/');
    }
    if (!TWEET_ID_RE.test(String(tweetId || ''))) return '';
    const clean = String(handle || '').trim().replace(/^@+/, '');
    return HANDLE_RE.test(clean)
      ? `https://x.com/${encodeURIComponent(clean)}/status/${tweetId}`
      : `https://x.com/i/web/status/${tweetId}`;
  }

  function extractEntries(json) {
    const timeline = json?.data?.viewer_v2?.user_results?.result?.notification_timeline?.timeline;
    if (!timeline || !Array.isArray(timeline.instructions)) return [];
    const entries = [];
    for (const inst of timeline.instructions) {
      if (!inst || typeof inst !== 'object') continue;
      const type = inst.__typename || inst.type;
      if (type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
        entries.push(...inst.entries);
      } else if (type === 'TimelineReplaceEntry' && inst.entry) {
        entries.push(inst.entry);
      } else if (type === 'TimelineAddToModule' && Array.isArray(inst.moduleItems)) {
        for (const item of inst.moduleItems) {
          if (item?.content) entries.push(item);
          else if (item?.item) entries.push({ entryId: item.entryId, content: item.item });
        }
      }
    }
    return entries;
  }

  function ingestTimelineJson(json) {
    const entries = extractEntries(json);
    if (!entries.length) return { newPosts: {}, missingTargets: [] };

    const newPosts = {};
    const missingMap = new Map();

    for (const entry of entries) {
      const content = entry?.content;
      const itemContent = content?.itemContent;
      if (!itemContent || typeof itemContent !== 'object') continue;
      const element = content.clientEventInfo?.element || '';

      // 1. Passively cache post texts present in target_objects
      const targets = itemContent.template?.target_objects;
      if (Array.isArray(targets)) {
        for (const obj of targets) {
          const targetTweet = unwrapTweet(obj?.tweet_results?.result);
          const tid = String(targetTweet?.rest_id || targetTweet?.legacy?.id_str || '');
          const text = tweetTextOf(targetTweet);
          if (TWEET_ID_RE.test(tid) && text && !postTextCache.get(tid)?.text) {
            const authorRes = targetTweet?.core?.user_results?.result;
            const handle = authorRes?.core?.screen_name || authorRes?.legacy?.screen_name || '';
            const url = normalizeStatusUrl(itemContent.notification_url?.url, tid, handle);
            const record = { text, url };
            postTextCache.set(tid, record);
            failedTargets.delete(tid);
            newPosts[tid] = record;
          }
        }
      }

      // 2. Map replyTweetId -> parent targetTweetId
      const tweet = unwrapTweet(itemContent.tweet_results?.result);
      const legacy = tweet?.legacy;
      const inReplyToId = String(legacy?.in_reply_to_status_id_str || '');
      const conversationId = String(legacy?.conversation_id_str || '');
      const isReply =
        element === 'user_replied_to_your_tweet' ||
        ((itemContent.__typename === 'TimelineTweet' || itemContent.itemType === 'TimelineTweet') &&
          TWEET_ID_RE.test(inReplyToId));
      if (!isReply || !tweet) continue;

      const replyTweetId = String(tweet.rest_id || legacy?.id_str || '');
      const targetTweetId = TWEET_ID_RE.test(inReplyToId)
        ? inReplyToId
        : TWEET_ID_RE.test(conversationId)
          ? conversationId
          : '';
      if (!TWEET_ID_RE.test(replyTweetId) || !TWEET_ID_RE.test(targetTweetId)) continue;

      const rawHandle = String(legacy?.in_reply_to_screen_name || '').trim().replace(/^@+/, '');
      const targetHandle = HANDLE_RE.test(rawHandle) ? rawHandle : '';
      const targetUrl = normalizeStatusUrl('', targetTweetId, targetHandle);
      replyMap.set(replyTweetId, { targetTweetId, targetHandle, targetUrl });

      if (!postTextCache.get(targetTweetId)?.text && !missingMap.has(targetTweetId)) {
        missingMap.set(targetTweetId, { tweetId: targetTweetId, handle: targetHandle });
      }
    }

    return {
      newPosts,
      missingTargets: [...missingMap.values()]
    };
  }

  async function resolveFromBackground(targets = []) {
    if (!isValidContext()) return;
    const batch = [];
    const seen = new Set();

    for (const item of targets) {
      const tid = String(item?.tweetId || '').trim();
      if (
        !TWEET_ID_RE.test(tid) ||
        seen.has(tid) ||
        postTextCache.get(tid)?.text ||
        pendingTargets.has(tid) ||
        failedTargets.has(tid)
      ) {
        continue;
      }
      seen.add(tid);
      pendingTargets.add(tid);
      batch.push({ tweetId: tid, handle: String(item?.handle || '') });
    }

    if (!batch.length) return;
    scheduleRender();

    try {
      const res = await chrome.runtime.sendMessage({ type: 'RESOLVE_TWEETS', targets: batch });
      for (const item of batch) pendingTargets.delete(item.tweetId);

      if (!res?.ok) {
        scheduleRender();
        return;
      }

      if (res.posts && typeof res.posts === 'object') {
        for (const [tid, info] of Object.entries(res.posts)) {
          if (info?.text) {
            const existing = postTextCache.get(tid);
            failedTargets.delete(tid);
            postTextCache.set(tid, {
              text: String(info.text),
              url: String(info.url || existing?.url || '')
            });
          }
        }
      }

      if (Array.isArray(res.unresolved)) {
        for (const tid of res.unresolved) {
          if (!postTextCache.get(tid)?.text) failedTargets.add(String(tid));
        }
      }

      scheduleRender();
    } catch {
      for (const item of batch) pendingTargets.delete(item.tweetId);
      scheduleRender();
    }
  }

  function articleReplyTweetId(article) {
    const anchors = [...article.querySelectorAll('a[href*="/status/"]')].filter(
      (a) =>
        !a.classList.contains(CARD_CLASS) &&
        !a.classList.contains(LEGACY_XEF_CLASS) &&
        !a.closest('[data-testid="tweetText"]') &&
        a.closest('[data-testid="tweet"]') === article
    );
    const preferred = anchors.find((a) => Boolean(a.querySelector('time'))) || anchors[0];
    if (!preferred) return '';
    try {
      const url = new URL(preferred.href, location.origin);
      const match = url.pathname.match(/^\/[A-Za-z0-9_]{1,15}\/status\/(\d+)/i);
      return match ? match[1] : '';
    } catch {
      return '';
    }
  }

  function buildOrUpdateCard(article, meta) {
    if (article.querySelector(`.${LEGACY_XEF_CLASS}`)) return;

    const cached = postTextCache.get(meta.targetTweetId);
    const targetText = cached?.text || '';
    const targetUrl =
      cached?.url || meta.targetUrl || normalizeStatusUrl('', meta.targetTweetId, meta.targetHandle);
    const isPending = !targetText && pendingTargets.has(meta.targetTweetId);
    const state = targetText ? '1' : isPending ? 'loading' : '0';

    const existing = article.querySelector(`.${CARD_CLASS}`);
    if (existing && existing.dataset.targetId === meta.targetTweetId && existing.dataset.hasText === state) {
      return;
    }

    const card = existing || document.createElement('a');
    card.className = CARD_CLASS;
    card.href = targetUrl || '#';
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.dataset.targetId = meta.targetTweetId;
    card.dataset.hasText = state;
    card.title = targetText || targetUrl;

    if (!existing) {
      card.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    }

    card.textContent = '';
    const head = document.createElement('div');
    head.className = 'xnc-quote-head';
    const label = document.createElement('span');
    label.textContent = labelOriginalPost(meta.targetHandle);
    const arrow = document.createElement('span');
    arrow.className = 'xnc-quote-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    head.append(label, arrow);
    card.append(head);

    if (targetText) {
      const p = document.createElement('p');
      p.className = 'xnc-quote-text';
      p.textContent = targetText;
      card.append(p);
    } else if (isPending) {
      const loading = document.createElement('span');
      loading.className = 'xnc-quote-loading';
      loading.textContent = labelLoading();
      card.append(loading);
    } else if (targetUrl) {
      const span = document.createElement('span');
      span.className = 'xnc-quote-url';
      span.textContent = targetUrl;
      card.append(span);
    }

    if (!existing) {
      const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
      if (
        tweetTextEl &&
        tweetTextEl.closest('[data-testid="tweet"]') === article &&
        tweetTextEl.parentElement
      ) {
        tweetTextEl.parentElement.insertBefore(card, tweetTextEl.nextSibling);
        return;
      }
      const actionBar = article.querySelector('[role="group"]');
      if (actionBar && actionBar.closest('[data-testid="tweet"]') === article && actionBar.parentElement) {
        actionBar.parentElement.insertBefore(card, actionBar);
      }
    }
  }

  function renderAll() {
    if (!isNotificationsPage()) return;
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const unknownTargets = [];
    for (const article of articles) {
      const replyTweetId = articleReplyTweetId(article);
      if (!replyTweetId) continue;
      const meta = replyMap.get(replyTweetId);
      if (!meta || !meta.targetTweetId) continue;
      if (
        !postTextCache.get(meta.targetTweetId)?.text &&
        !pendingTargets.has(meta.targetTweetId) &&
        !failedTargets.has(meta.targetTweetId)
      ) {
        unknownTargets.push({ tweetId: meta.targetTweetId, handle: meta.targetHandle });
      }
      buildOrUpdateCard(article, meta);
    }
    if (unknownTargets.length) {
      void resolveFromBackground(unknownTargets);
    }
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAll();
    }, 80);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__xncNotifications !== true) return;
    const json = event.data.json;
    if (!json) return;

    const { newPosts, missingTargets } = ingestTimelineJson(json);
    if (isValidContext() && Object.keys(newPosts).length) {
      chrome.runtime.sendMessage({ type: 'CACHE_POSTS', posts: newPosts }).catch(() => {});
    }

    scheduleRender();
    if (missingTargets.length) {
      void resolveFromBackground(missingTargets);
    }
  });

  function checkRoute() {
    const path = location.pathname || '';
    if (path !== lastPath) {
      lastPath = path;
      if (isNotificationsPage() && replyMap.size > 0) {
        scheduleRender();
      }
    }
  }

  const observer = new MutationObserver(() => {
    checkRoute();
    if (isNotificationsPage() && replyMap.size > 0) {
      scheduleRender();
    }
  });

  const startObserver = () => {
    const root = document.body || document.documentElement;
    if (!root) return;
    observer.observe(root, { childList: true, subtree: true });
    checkRoute();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }
  window.addEventListener('popstate', checkRoute);
})();
