/**
 * Voice Agent widget loader.
 * <script src="https://YOUR-APP/widget.js" data-key="wk_..." async></script>
 *
 * Injects one iframe (served from the app, so no Retell code or keys run on the host
 * page) and sizes it to the launcher button or the open call panel.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__voiceAgentWidget) return;
  var key = script.getAttribute('data-key');
  if (!key) {
    console.warn('[voice-agent] Missing data-key on the widget script tag.');
    return;
  }
  window.__voiceAgentWidget = true;

  var appOrigin = new URL(script.src).origin;
  var GAP = 16;
  var PANEL_WIDTH = 380;
  var PANEL_HEIGHT = 600;
  var MOBILE_MAX = 480;
  var layout = { open: false, position: 'right', width: 0, height: 0 };

  var iframe = document.createElement('iframe');
  iframe.src =
    appOrigin + '/embed/' + encodeURIComponent(key) +
    '?page=' + encodeURIComponent(location.origin + location.pathname);
  iframe.title = 'Voice support';
  iframe.allow = 'microphone; autoplay';
  iframe.setAttribute('allowtransparency', 'true');
  var base = {
    position: 'fixed',
    zIndex: '2147483000',
    border: '0',
    background: 'transparent',
    colorScheme: 'light',
    width: '0',
    height: '0',
    bottom: GAP + 'px',
    maxWidth: '100vw',
    maxHeight: '100vh',
  };
  for (var prop in base) iframe.style[prop] = base[prop];

  function apply() {
    var s = iframe.style;
    var mobile = window.innerWidth <= MOBILE_MAX;
    s.left = s.right = s.top = 'auto';
    s.borderRadius = '0';
    s.boxShadow = 'none';

    if (layout.open && mobile) {
      s.top = s.left = s.right = s.bottom = '0';
      s.width = '100vw';
      s.height = '100%';
      return;
    }
    s.bottom = GAP + 'px';
    s[layout.position === 'left' ? 'left' : 'right'] = GAP + 'px';
    if (layout.open) {
      s.width = Math.min(PANEL_WIDTH, window.innerWidth - GAP * 2) + 'px';
      s.height = Math.min(PANEL_HEIGHT, window.innerHeight - GAP * 2) + 'px';
      s.borderRadius = '16px';
      s.boxShadow = '0 12px 40px rgba(15, 23, 42, 0.25)';
    } else {
      // The launcher reports its own size (it pads itself, so offset by that)
      s.bottom = s[layout.position === 'left' ? 'left' : 'right'] = GAP - 12 + 'px';
      s.width = layout.width + 'px';
      s.height = layout.height + 'px';
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== iframe.contentWindow || event.origin !== appOrigin) return;
    var data = event.data;
    if (!data || data.source !== 'voice-agent') return;
    if (data.type === 'hide') {
      iframe.style.display = 'none';
    } else if (data.type === 'layout') {
      layout = {
        open: !!data.open,
        position: data.position === 'left' ? 'left' : 'right',
        width: Number(data.width) || layout.width,
        height: Number(data.height) || layout.height,
      };
      apply();
    }
  });
  window.addEventListener('resize', apply);

  function mount() {
    document.body.appendChild(iframe);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
