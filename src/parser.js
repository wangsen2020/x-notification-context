const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID_RE = /^\d{1,25}$/;
const DEFAULT_FX_BASE = 'https://api.fxtwitter.com';

export function unwrapTweet(node) {
  if (!node || typeof node !== 'object') return null;
  return node.tweet && typeof node.tweet === 'object' ? node.tweet : node;
}

export function tweetTextOf(tweet) {
  if (!tweet || typeof tweet !== 'object') return '';
  const note = tweet.note_tweet?.note_tweet_results?.result?.text;
  if (typeof note === 'string' && note.trim()) return note.trim();
  const full = tweet.legacy?.full_text || tweet.legacy?.text || '';
  return typeof full === 'string' ? full.trim() : '';
}

export function normalizeStatusUrl(rawUrl, tweetId, handle = '') {
  const raw = String(rawUrl || '').trim();
  if (raw && /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(raw)) {
    return raw.replace(/^https?:\/\/twitter\.com\//i, 'https://x.com/');
  }
  const cleanId = String(tweetId || '').trim();
  if (!TWEET_ID_RE.test(cleanId)) return '';
  const cleanHandle = String(handle || '').trim().replace(/^@+/, '');
  return HANDLE_RE.test(cleanHandle)
    ? `https://x.com/${encodeURIComponent(cleanHandle)}/status/${cleanId}`
    : `https://x.com/i/web/status/${cleanId}`;
}

export function extractEntries(json) {
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

export function parseNotificationsTimeline(json) {
  const entries = extractEntries(json);
  const posts = {};
  const replies = {};
  const missingMap = new Map();

  for (const entry of entries) {
    const content = entry?.content;
    const itemContent = content?.itemContent;
    if (!itemContent || typeof itemContent !== 'object') continue;
    const element = content.clientEventInfo?.element || '';

    // 1. Collect post texts already present in target_objects (likes, reposts, etc.)
    const targets = itemContent.template?.target_objects;
    if (Array.isArray(targets)) {
      for (const obj of targets) {
        const targetTweet = unwrapTweet(obj?.tweet_results?.result);
        const tid = String(targetTweet?.rest_id || targetTweet?.legacy?.id_str || '');
        const text = tweetTextOf(targetTweet);
        if (TWEET_ID_RE.test(tid) && text && !posts[tid]) {
          const authorRes = targetTweet?.core?.user_results?.result;
          const handle = authorRes?.core?.screen_name || authorRes?.legacy?.screen_name || '';
          const url = normalizeStatusUrl(itemContent.notification_url?.url, tid, handle);
          posts[tid] = { text, url };
        }
      }
    }

    // 2. Collect reply -> parent tweet mapping
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

    const targetHandle = String(legacy?.in_reply_to_screen_name || '').trim().replace(/^@+/, '');
    const cleanHandle = HANDLE_RE.test(targetHandle) ? targetHandle : '';
    const targetUrl = normalizeStatusUrl('', targetTweetId, cleanHandle);
    replies[replyTweetId] = {
      targetTweetId,
      targetHandle: cleanHandle,
      targetUrl
    };

    if (!posts[targetTweetId] && !missingMap.has(targetTweetId)) {
      missingMap.set(targetTweetId, {
        tweetId: targetTweetId,
        handle: cleanHandle
      });
    }
  }

  return {
    posts,
    replies,
    missingTargets: [...missingMap.values()]
  };
}

function extractArticleText(article) {
  if (!article || typeof article !== 'object') return '';
  const title = String(article.title || '').trim();
  const preview = String(article.preview_text || '').trim();
  const parts = [];
  if (title) parts.push(title);
  if (preview && preview !== title) parts.push(preview);
  return parts.join('\n\n').trim();
}

export async function fetchFxTwitterStatus(handle, tweetId, options = {}) {
  const cleanTweetId = String(tweetId || '').trim();
  if (!TWEET_ID_RE.test(cleanTweetId)) {
    return {
      ok: false,
      status: 0,
      exists: null,
      text: '',
      url: '',
      error: 'Invalid tweetId'
    };
  }

  const rawHandle = String(handle || '').trim().replace(/^@+/, '');
  const safeHandle = HANDLE_RE.test(rawHandle) ? rawHandle : 'i';
  const baseUrl = String(options.baseUrl || DEFAULT_FX_BASE).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 12000;

  try {
    const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(safeHandle)}/status/${cleanTweetId}`, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (response.redirected) {
      return { ok: false, status: 0, exists: null, text: '', url: '', error: 'Unexpected redirect' };
    }

    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        status: response.status || 0,
        exists: null,
        text: '',
        url: '',
        error: 'Non-JSON response'
      };
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      return {
        ok: false,
        status: response.status || 0,
        exists: null,
        text: '',
        url: '',
        error: 'Invalid JSON body'
      };
    }

    if (!json || typeof json !== 'object' || !Number.isInteger(json.code)) {
      return {
        ok: false,
        status: response.status || 0,
        exists: null,
        text: '',
        url: '',
        error: 'Unexpected payload shape'
      };
    }

    if (json.code === 404) {
      return {
        ok: true,
        status: 404,
        exists: false,
        text: '',
        url: '',
        error: json.message || 'Not found'
      };
    }

    const tweet = json.tweet;
    if (json.code === 200 && tweet) {
      const articleText = tweet.article ? extractArticleText(tweet.article) : '';
      const text = articleText || String(tweet.raw_text?.text || tweet.text || '').trim();
      const authorHandle = tweet.author?.screen_name || safeHandle;
      const url = normalizeStatusUrl(tweet.url, cleanTweetId, authorHandle === 'i' ? '' : authorHandle);
      return {
        ok: true,
        status: 200,
        exists: true,
        text,
        url,
        error: ''
      };
    }

    return {
      ok: false,
      status: json.code,
      exists: null,
      text: '',
      url: '',
      error: json.message || `FxTwitter status ${json.code}`
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      exists: null,
      text: '',
      url: '',
      error: String(error?.message || error || 'Network error')
    };
  }
}
