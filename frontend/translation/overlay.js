// Desktop translation lettering: keep source erasure separate from optional
// bubble-interior layout, using the same models and translated strings.

function textColorFor(bg) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(bg || '');
  if (!m) return '#111';
  const lum = 0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3];
  return lum < 128 ? '#fff' : '#111';
}

export function attachOverlay(img) {
  const parent = img.closest('.reader-slide') || img.parentElement;
  const ov = document.createElement('div');
  ov.className = 'tl-overlay';
  parent.appendChild(ov);

  let blocks = [];
  let texts = null;
  let natW = 1;
  let natH = 1;
  let fittedWidth = -1, fittedHeight = -1;

  function sync() {
    if (!img.isConnected) return;
    ov.style.left = img.offsetLeft + 'px';
    ov.style.top = img.offsetTop + 'px';
    ov.style.width = img.offsetWidth + 'px';
    ov.style.height = img.offsetHeight + 'px';
    if (ov.clientWidth !== fittedWidth || ov.clientHeight !== fittedHeight) {
      fittedWidth = ov.clientWidth;
      fittedHeight = ov.clientHeight;
      fitAll();
    }
  }

  const ro = new ResizeObserver(sync);
  ro.observe(img);

  // In webtoon mode the ResizeObserver only fires when THIS image's own box
  // changes; when a sibling page above reflows it shifts our offsetTop without
  // resizing us, so the observer never fires and the bubbles drift. Re-sync on
  // scroll of the webtoon scroll container (throttled to one call per frame)
  // and on window resize.
  const scrollTarget =
    img.closest('.reader.webtoon') || img.closest('.reader') || window;
  let rafPending = 0;
  function onScroll() {
    if (rafPending) return;
    rafPending = requestAnimationFrame(() => {
      rafPending = 0;
      sync();
    });
  }
  scrollTarget.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', sync);

  function place(d, b) {
    d.style.left = (b.x / natW) * 100 + '%';
    d.style.top = (b.y / natH) * 100 + '%';
    d.style.width = (b.w / natW) * 100 + '%';
    d.style.height = (b.h / natH) * 100 + '%';
  }

  function renderBlocks() {
    fittedWidth = -1;
    ov.replaceChildren();
    blocks.forEach((b, i) => {
      const t = texts && texts[i];
      const d = document.createElement('div');
      d.className = 'tl-block' + (t ? '' : ' tl-pending');
      place(d, b);
      if (t) {
        const mask = document.createElement('div');
        mask.className = 'tl-erase';
        mask.style.cssText = 'position:absolute;border-radius:10px;';
        place(mask, b);
        mask.style.background = b.bg;
        mask.style.boxShadow = `0 0 6px 4px ${b.bg}`;
        ov.appendChild(mask);
        d.style.color = textColorFor(b.bg);
        d.style.hyphens = 'none';
        // Any target language may be RTL (Arabic, Hebrew, Persian, Urdu…).
        d.dir = 'auto';
        const lettering = document.createElement('span');
        lettering.style.cssText = 'display:block;width:100%;';
        // Decorative separators are natural phrase breaks, not new hyphens.
        // Text nodes and wbr preserve the exact translated textContent.
        for (const part of t.split(/([☆★])/u)) {
          lettering.appendChild(document.createTextNode(part));
          if (/^[☆★]$/u.test(part)) lettering.appendChild(document.createElement('wbr'));
        }
        d.appendChild(lettering);
      }
      d.__block = b;
      ov.appendChild(d);
    });
  }

  function fits(d) {
    const text = d.firstElementChild;
    return d.scrollHeight <= d.clientHeight + 1 && d.scrollWidth <= d.clientWidth + 1
      && (!text || (text.scrollHeight <= d.clientHeight - 4 + 1 && text.scrollWidth <= d.clientWidth - 8 + 1));
  }
  function measure(d, box, scale) {
    place(d, box);
    const MIN = 6;
    let lo = MIN, hi = Math.max(MIN, Math.min(64, box.h * scale * .92)), best = MIN;
    d.style.overflowWrap = 'normal';
    d.style.fontSize = hi + 'px';
    if (fits(d)) best = hi;
    else for (let i = 0; i < 12 && hi - lo > .2; i++) {
      const mid = (lo + hi) / 2;
      d.style.fontSize = mid + 'px';
      if (fits(d)) { best = mid; lo = mid; } else hi = mid;
    }
    // Round down so rounding itself cannot reintroduce overflow.
    best = Math.floor(best * 10) / 10;
    d.style.fontSize = best + 'px';
    return { box, font: best, fits: fits(d) };
  }
  function fitAll() {
    if (!texts || !ov.clientWidth) return;
    const scale = ov.clientWidth / natW;
    for (const d of ov.children) {
      const b = d.__block;
      if (!b || !d.textContent) continue;
      let chosen = measure(d, b, scale);
      for (const candidate of b.layoutBoxes || []) {
        if (![candidate.x,candidate.y,candidate.w,candidate.h].every(Number.isFinite)
          || candidate.x < 0 || candidate.y < 0 || candidate.w <= 0 || candidate.h <= 0
          || candidate.x + candidate.w > natW || candidate.y + candidate.h > natH) continue;
        const fit = measure(d, candidate, scale);
        if (fit.fits && ((!chosen.fits && fit.font >= chosen.font) || fit.font > chosen.font + .5)) chosen = fit;
      }
      place(d, chosen.box);
      d.style.fontSize = chosen.font + 'px';
      // Only an unbreakable word still too wide at the floor may break. No
      // inserted hyphens; ordinary phrases always retain whole-word wrapping.
      d.style.overflowWrap = chosen.fits ? 'normal' : 'anywhere';
    }
  }

  // Android-style page status pill (top-right of the page): OCR progress
  // counts while bubbles are being read, then "Translating…".
  let pill = null;
  function setProgress(progress) {
    if (!progress) {
      if (pill) { pill.remove(); pill = null; }
      return;
    }
    if (!pill || !pill.isConnected) {
      pill = document.createElement('div');
      pill.className = 'tl-progress';
      ov.appendChild(pill);
    }
    pill.textContent = progress.stage === 'refine'
      ? 'Refining with AI…'
      : progress.stage === 'translate'
        ? 'Translating…'
        : (progress.total ? `Reading text ${progress.done}/${progress.total}…` : 'Finding text…');
  }

  return {
    setBlocks(b, t, progress) {
      blocks = b || [];
      texts = t;
      natW = img.naturalWidth || 1;
      natH = img.naturalHeight || 1;
      renderBlocks();
      sync();
      setProgress(progress || null); // engine sends explicit stage/null
    },
    destroy() {
      ro.disconnect();
      scrollTarget.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', sync);
      if (rafPending) cancelAnimationFrame(rafPending);
      ov.remove();
    },
  };
}
