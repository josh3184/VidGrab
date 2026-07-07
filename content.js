// VidGrab content script: reports <video> elements (and their <source>
// children) to the background worker. Runs in every frame.

(() => {
  let lastReport = '';

  function collect() {
    const items = [];
    const seen = new Set();

    const push = (url, video, explicitType) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      items.push({
        url,
        contentType: explicitType || '',
        width: video ? video.videoWidth || 0 : 0,
        height: video ? video.videoHeight || 0 : 0,
        duration:
          video && isFinite(video.duration) ? Math.round(video.duration) : 0,
        title: (video && (video.title || video.getAttribute('aria-label'))) || '',
      });
    };

    for (const video of document.querySelectorAll('video')) {
      const src = video.currentSrc || video.src;
      if (src) push(src, video);
      for (const source of video.querySelectorAll('source')) {
        if (source.src) push(source.src, video, source.type || '');
      }
    }

    return items;
  }

  function report() {
    const items = collect();
    const fingerprint = JSON.stringify(items.map((i) => i.url));
    if (items.length === 0 && fingerprint === lastReport) return;
    lastReport = fingerprint;
    chrome.runtime
      .sendMessage({
        type: 'page-media',
        items,
        pageUrl: location.href,
        pageTitle: document.title,
      })
      .catch(() => {});
  }

  // Initial scan plus a delayed pass for players that attach late.
  report();
  setTimeout(report, 2000);
  setTimeout(report, 6000);

  // Watch for players added or re-sourced after load.
  let debounce = null;
  const queueReport = () => {
    clearTimeout(debounce);
    debounce = setTimeout(report, 800);
  };

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (
          node.nodeType === 1 &&
          (node.tagName === 'VIDEO' ||
            node.tagName === 'SOURCE' ||
            (node.querySelector && node.querySelector('video')))
        ) {
          queueReport();
          return;
        }
      }
      if (
        m.type === 'attributes' &&
        m.target.tagName === 'VIDEO'
      ) {
        queueReport();
        return;
      }
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  // Metadata (dimensions/duration) becomes available after loadedmetadata.
  document.addEventListener('loadedmetadata', queueReport, true);
  document.addEventListener('play', queueReport, true);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'rescan') {
      lastReport = '';
      report();
      sendResponse({ ok: true });
    }
  });
})();
