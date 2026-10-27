/* MAIN world: captures /api/timedtext responses made by the player, exposes caption tracks, can enable captions. */
(function () {
  'use strict';
  if (window.__YVD_INJECTED__) return;
  window.__YVD_INJECTED__ = true;

  const post = (obj) => window.postMessage(Object.assign({ source: 'YVD' }, obj), '*');
  const buffer = []; // recent captures, replayed when the content script asks (it loads later than us)

  function isTimedtext(url) {
    return typeof url === 'string' && url.indexOf('/api/timedtext') !== -1;
  }

  function capture(url, body) {
    if (!body || typeof body !== 'string') return;
    const item = { url, body };
    buffer.push(item);
    if (buffer.length > 6) buffer.shift();
    post({ type: 'timedtext', url, body });
  }

  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      if (input && typeof input.href === 'string') return input.href;
    } catch (e) {}
    return '';
  }

  // fetch hook
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const url = urlOf(args[0]);
        if (isTimedtext(url)) {
          p.then((res) => res.clone().text().then((t) => capture(url, t)).catch(() => {})).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }

  // XHR hook
  const xo = XMLHttpRequest.prototype.open;
  const xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__yvdUrl = urlOf(url);
    } catch (e) {}
    return xo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      if (isTimedtext(this.__yvdUrl)) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') capture(this.__yvdUrl, this.responseText);
          } catch (e) {}
        });
      }
    } catch (e) {}
    return xs.apply(this, arguments);
  };

  function getPlayerResponse() {
    let r = null;
    try {
      const p = document.getElementById('movie_player');
      if (p && typeof p.getPlayerResponse === 'function') r = p.getPlayerResponse() || null;
    } catch (e) {}
    // the live player response may not carry captions yet; the initial one for the same video might
    const init = window.ytInitialPlayerResponse;
    const vid = (x) => x && x.videoDetails && x.videoDetails.videoId;
    if (init && init.captions && (!r || (!r.captions && vid(r) === vid(init)))) return init;
    return r || init || null;
  }

  function postTracks() {
    const pr = getPlayerResponse();
    const list =
      (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    post({
      type: 'tracks',
      videoId: (pr && pr.videoDetails && pr.videoDetails.videoId) || null,
      tracks: list.map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        kind: t.kind || '',
        isTranslatable: !!t.isTranslatable
      }))
    });
  }

  function enableCaptions(languageCode) {
    const p = document.getElementById('movie_player');
    if (!p) return;
    try {
      if (languageCode && typeof p.setOption === 'function') p.setOption('captions', 'track', { languageCode });
    } catch (e) {}
    try {
      const on = typeof p.isSubtitlesOn === 'function' ? p.isSubtitlesOn() : false;
      if (!on) {
        if (typeof p.toggleSubtitlesOn === 'function') p.toggleSubtitlesOn();
        else if (typeof p.toggleSubtitles === 'function') p.toggleSubtitles();
      }
    } catch (e) {}
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'YVD-CMD') return;
    const d = ev.data;
    if (d.type === 'requestTracks') {
      postTracks();
      buffer.forEach((b) => post({ type: 'timedtext', url: b.url, body: b.body }));
    } else if (d.type === 'enableCaptions') {
      enableCaptions(d.languageCode);
    }
  });

  window.addEventListener('yt-navigate-finish', () => setTimeout(postTracks, 300));
  document.addEventListener('DOMContentLoaded', () => setTimeout(postTracks, 500));
})();
