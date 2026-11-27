(() => {
  if (window.__XNC_NET_HOOKED) return;
  window.__XNC_NET_HOOKED = true;

  const NOTIFICATION_RE = /\/graphql\/[^/?]+\/NotificationsTimeline(?=[/?#]|$)/;

  function emitIfNotificationTimeline(url, json) {
    if (!json || typeof json !== 'object') return;
    try {
      if (!/^\/notifications(?:\/|$)/i.test(location.pathname || '')) return;
      const parsed = new URL(String(url), location.origin);
      if (parsed.origin !== location.origin || !NOTIFICATION_RE.test(parsed.pathname)) return;
      window.postMessage({ __xncNotifications: true, json }, location.origin);
    } catch {}
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      let url = '';
      try {
        const input = args[0];
        url = typeof input === 'string' ? input : input?.url || input?.href || '';
      } catch {}

      const promise = origFetch.apply(this, args);
      if (NOTIFICATION_RE.test(String(url))) {
        promise
          .then((res) => {
            if (!res || res.status < 200 || res.status >= 300) return;
            res
              .clone()
              .json()
              .then((json) => emitIfNotificationTimeline(url, json))
              .catch(() => {});
          })
          .catch(() => {});
      }
      return promise;
    };
  }

  const xhrProto = window.XMLHttpRequest?.prototype;
  if (xhrProto && typeof xhrProto.open === 'function' && typeof xhrProto.send === 'function') {
    const origOpen = xhrProto.open;
    const origSend = xhrProto.send;

    xhrProto.open = function (method, url, ...rest) {
      this.__xncUrl = String(url || '');
      return origOpen.call(this, method, url, ...rest);
    };

    xhrProto.send = function (...args) {
      if (NOTIFICATION_RE.test(this.__xncUrl || '')) {
        this.addEventListener('load', () => {
          if (this.status < 200 || this.status >= 300) return;
          try {
            const json = JSON.parse(this.responseText);
            emitIfNotificationTimeline(this.__xncUrl, json);
          } catch {}
        });
      }
      return origSend.apply(this, args);
    };
  }
})();
