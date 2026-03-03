(function() {
  // Guard against double-injection
  if (window.__cmuxInspectActive) return;
  window.__cmuxInspectActive = true;

  const OVERLAY_COLOR_BG = 'rgba(59, 130, 246, 0.15)';
  const OVERLAY_COLOR_BORDER = 'rgba(59, 130, 246, 0.6)';
  const FLASH_COLOR_BORDER = 'rgba(34, 197, 94, 0.3)';
  const TOOLTIP_BG = 'rgba(0,0,0,0.85)';
  const Z = 2147483647;
  const ATTR = 'data-cmux-inspect';

  // --- Inject crosshair cursor style ---
  const cursorStyle = document.createElement('style');
  cursorStyle.setAttribute(ATTR, 'cursor');
  cursorStyle.textContent = '* { cursor: crosshair !important; }';
  document.head.appendChild(cursorStyle);

  // --- Create overlay ---
  const overlay = document.createElement('div');
  overlay.setAttribute(ATTR, 'overlay');
  overlay.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'background:' + OVERLAY_COLOR_BG,
    'border:2px solid ' + OVERLAY_COLOR_BORDER,
    'z-index:' + Z,
    'top:0', 'left:0', 'width:0', 'height:0',
    'display:none',
    'box-sizing:border-box',
    'transition:none'
  ].join(';');
  document.body.appendChild(overlay);

  // --- Create tooltip ---
  const tooltip = document.createElement('div');
  tooltip.setAttribute(ATTR, 'tooltip');
  tooltip.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'background:' + TOOLTIP_BG,
    'color:white',
    'font-size:11px',
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
    'padding:4px 8px',
    'border-radius:4px',
    'z-index:' + Z,
    'white-space:nowrap',
    'display:none',
    'max-width:400px',
    'overflow:hidden',
    'text-overflow:ellipsis'
  ].join(';');
  document.body.appendChild(tooltip);

  let lastTarget = null;

  // --- Role detection ---
  function detectRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    const implicitRoles = {
      'button': 'button',
      'a': 'link',
      'select': 'combobox',
      'img': 'img',
      'textarea': 'textbox',
      'h1': 'heading',
      'h2': 'heading',
      'h3': 'heading',
      'h4': 'heading',
      'h5': 'heading',
      'h6': 'heading'
    };

    if (implicitRoles[tag]) return implicitRoles[tag];

    if (tag === 'input') {
      const inputRoles = {
        'text': 'textbox',
        'search': 'textbox',
        'email': 'textbox',
        'url': 'textbox',
        'tel': 'textbox',
        'password': 'textbox',
        'number': 'textbox',
        'checkbox': 'checkbox',
        'radio': 'radio'
      };
      return inputRoles[type] || 'textbox';
    }

    return tag;
  }

  // --- Label extraction ---
  function extractLabel(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      const parts = [];
      for (let i = 0; i < ids.length; i++) {
        const ref = document.getElementById(ids[i]);
        if (ref) parts.push(ref.textContent.trim());
      }
      if (parts.length) return parts.join(' ');
    }

    const text = (el.textContent || '').trim();
    if (text.length > 80) return text.substring(0, 80) + '\u2026';
    return text;
  }

  // --- Selector generation ---
  function isUnique(selector) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1;
    } catch (e) {
      return false;
    }
  }

  function escapeCSSValue(val) {
    return val.replace(/"/g, '\\"');
  }

  function buildSelector(el) {
    // Prefer data-testid
    const testId = el.getAttribute('data-testid');
    if (testId) {
      const sel = '[data-testid="' + escapeCSSValue(testId) + '"]';
      if (isUnique(sel)) return sel;
    }

    // Then #id
    if (el.id) {
      const idSel = '#' + CSS.escape(el.id);
      if (isUnique(idSel)) return idSel;
    }

    // Try tag.class combos
    const tag = el.tagName.toLowerCase();
    if (el.classList && el.classList.length) {
      for (let i = 0; i < el.classList.length; i++) {
        const cls = tag + '.' + CSS.escape(el.classList[i]);
        if (isUnique(cls)) return cls;
      }
      // Try all classes combined
      const allClasses = tag + '.' + Array.prototype.map.call(el.classList, function(c) {
        return CSS.escape(c);
      }).join('.');
      if (isUnique(allClasses)) return allClasses;
    }

    // Try tag[attr] combos for common attributes
    const tryAttrs = ['name', 'type', 'href', 'src', 'placeholder'];
    for (let a = 0; a < tryAttrs.length; a++) {
      const attrVal = el.getAttribute(tryAttrs[a]);
      if (attrVal) {
        const attrSel = tag + '[' + tryAttrs[a] + '="' + escapeCSSValue(attrVal) + '"]';
        if (isUnique(attrSel)) return attrSel;
      }
    }

    // Walk up ancestors (max 3 levels) for uniqueness
    function selfPart(elem) {
      const t = elem.tagName.toLowerCase();
      if (elem.id) return '#' + CSS.escape(elem.id);
      if (elem.classList && elem.classList.length) {
        return t + '.' + Array.prototype.map.call(elem.classList, function(c) {
          return CSS.escape(c);
        }).join('.');
      }
      return t;
    }

    const parts = [selfPart(el)];
    let current = el.parentElement;
    let depth = 0;
    while (current && current !== document.body && current !== document.documentElement && depth < 3) {
      parts.unshift(selfPart(current));
      const candidate = parts.join(' > ');
      if (isUnique(candidate)) return candidate;
      current = current.parentElement;
      depth++;
    }

    // Fallback: just tagName
    return tag;
  }

  // --- Collect attributes ---
  function collectAttributes(el) {
    const attrs = {};
    const pick = ['type', 'class', 'id', 'name', 'href', 'src', 'alt', 'placeholder', 'data-testid', 'value', 'aria-label'];
    for (let i = 0; i < pick.length; i++) {
      const key = pick[i];
      let val;
      if (key === 'value' && ('value' in el)) {
        val = el.value;
      } else {
        val = el.getAttribute(key);
      }
      if (val != null && val !== '') {
        attrs[key] = val;
      }
    }
    return attrs;
  }

  // --- Mousemove handler ---
  function onMouseMove(e) {
    const target = e.target;
    // Skip our own injected elements
    if (target.hasAttribute && target.hasAttribute(ATTR)) return;

    lastTarget = target;
    const rect = target.getBoundingClientRect();

    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    overlay.style.display = 'block';

    // Build tooltip text
    const role = detectRole(target);
    const label = extractLabel(target);
    const isIframe = target.tagName.toLowerCase() === 'iframe';

    if (isIframe) {
      tooltip.textContent = 'iframe \u2014 inner elements not supported';
    } else {
      tooltip.textContent = role + ': "' + (label || '') + '"';
    }

    // Position tooltip below element
    let tooltipTop = rect.bottom + 6;
    let tooltipLeft = rect.left;
    // Keep tooltip within viewport
    if (tooltipTop + 24 > window.innerHeight) {
      tooltipTop = rect.top - 28;
    }
    if (tooltipLeft < 0) tooltipLeft = 4;

    tooltip.style.top = tooltipTop + 'px';
    tooltip.style.left = tooltipLeft + 'px';
    tooltip.style.display = 'block';
  }

  // --- Click handler (capture phase) ---
  function onClickCapture(e) {
    e.preventDefault();
    e.stopImmediatePropagation();

    const target = e.target;
    if (target.hasAttribute && target.hasAttribute(ATTR)) return;

    const data = {
      selector: buildSelector(target),
      text: extractLabel(target),
      role: detectRole(target),
      tagName: target.tagName,
      attributes: collectAttributes(target),
      url: window.location.href,
      pageTitle: document.title
    };

    // Post to Swift or fallback to console
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cmuxInspect) {
      window.webkit.messageHandlers.cmuxInspect.postMessage(data);
    } else {
      console.log('[cmuxInspect]', JSON.stringify(data, null, 2));
    }

    // Flash green on picked element
    const prevOutline = target.style.outline;
    const prevOutlineOffset = target.style.outlineOffset;
    target.style.outline = '2px solid ' + FLASH_COLOR_BORDER;
    target.style.outlineOffset = '-1px';
    setTimeout(function() {
      target.style.outline = prevOutline;
      target.style.outlineOffset = prevOutlineOffset;
    }, 200);
  }

  // --- Hide overlay when mouse leaves the page ---
  function onMouseLeave() {
    overlay.style.display = 'none';
  }

  // --- Register listeners ---
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClickCapture, true);
  document.documentElement.addEventListener('mouseleave', onMouseLeave, false);

  // --- Cleanup function ---
  window.__cmuxInspectCleanup = function() {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClickCapture, true);
    document.documentElement.removeEventListener('mouseleave', onMouseLeave, false);

    // Remove all injected DOM elements
    const injected = document.querySelectorAll('[' + ATTR + ']');
    for (let i = 0; i < injected.length; i++) {
      injected[i].parentNode.removeChild(injected[i]);
    }

    window.__cmuxInspectActive = false;
    delete window.__cmuxInspectCleanup;
  };
})();
