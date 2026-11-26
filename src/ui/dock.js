/**
 * 顶栏流式停靠（优先内嵌于 `@container/titlebar` 按钮组）与浮层防溢出定位控制器。
 */

function findButtonContainerInGroup(group, capsuleHost) {
  if (!group) return null;
  const isVisibleBtn = (el) => {
    if (!el || capsuleHost.contains(el)) return false;
    if (!el.matches?.('button, a, [role="button"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const directBtns = Array.from(group.children || []).filter(isVisibleBtn);
  if (directBtns.length > 0) return group;

  for (const child of Array.from(group.children || [])) {
    if (child === capsuleHost || child.matches?.('button, a, [role="button"]')) continue;
    const nestedBtns = Array.from(child.children || []).filter(isVisibleBtn);
    if (nestedBtns.length > 0) return child;
  }
  return group;
}

function findDockTarget(capsuleHost) {
  const titlebar = document.querySelector('[class*="@container/titlebar"]');
  if (titlebar) {
    const tbRect = titlebar.getBoundingClientRect();
    if (tbRect.width > 0 && tbRect.height > 0) {
      const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
      if (rightGroup && rightGroup !== titlebar.firstElementChild) {
        return { kind: 'flow', container: findButtonContainerInGroup(rightGroup, capsuleHost) };
      }
      return { kind: 'flow', container: titlebar };
    }
  }
  return null;
}

function measureTopRightCluster(vw, capsuleHost, portalHost) {
  const boxes = [];
  const seen = new Set();
  const candidates = document.querySelectorAll(
    '[data-testid="toggle-aux-sidebar"], div.absolute.right-0.top-0 button, div.absolute.right-0.top-0 [role="button"], [class*="@container/titlebar"] button, [class*="@container/titlebar"] a, [class*="@container/titlebar"] [role="button"], header button, button, a, [role="button"]'
  );
  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (capsuleHost.contains(el) || portalHost.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r || r.width < 12 || r.height < 12 || r.width > 320) continue;
    if (r.top < 0 || r.top > 40 || r.bottom > 56) continue;
    if (r.right <= vw * 0.45 || r.right > vw + 2) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
    boxes.push({ left: r.left, top: r.top, right: r.right, height: r.height });
  }

  if (boxes.length === 0) return null;
  boxes.sort((a, b) => b.right - a.right);

  let clusterLeft = boxes[0].left;
  const anchorTop = boxes[0].top;
  const anchorHeight = boxes[0].height;
  let detectedGap = null;
  for (let i = 1; i < boxes.length; i += 1) {
    const b = boxes[i];
    if (b.right >= clusterLeft - 56) {
      const gap = Math.round(clusterLeft - b.right);
      if (gap >= 2 && gap <= 24 && (detectedGap === null || gap < detectedGap)) {
        detectedGap = gap;
      }
      if (b.left < clusterLeft) clusterLeft = b.left;
    } else {
      break;
    }
  }
  return { clusterLeft, anchorTop, anchorHeight, clusterGap: detectedGap ?? 6 };
}

/** 创建顶栏停靠与浮层防溢出位置控制器 */
export function createDockController({
  capsuleHost,
  capsuleBtn,
  portalHost,
  popoverEl,
  getContext,
  isPopoverOpen,
  onClosePopover,
}) {
  function syncFlowButtonMetrics(container) {
    const siblingBtns = [];
    for (const child of Array.from(container.children || [])) {
      if (child === capsuleHost) continue;
      const r = child.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) continue;
      const st = getComputedStyle(child);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      siblingBtns.push({
        left: r.left,
        right: r.right,
        height: r.height,
        marginLeft: parseFloat(st.marginLeft || '0') || 0,
      });
    }

    let btnHeight = 28;
    if (siblingBtns.length > 0) {
      const heights = siblingBtns.map((b) => Math.round(b.height)).filter((ht) => ht >= 20 && ht <= 36);
      if (heights.length > 0) btnHeight = Math.max(24, Math.min(34, heights[0]));
    }
    capsuleHost.style.height = `${btnHeight}px`;
    capsuleBtn.style.height = `${btnHeight}px`;

    const cStyle = getComputedStyle(container);
    const isFlex = cStyle.display.includes('flex');
    const colGap = parseFloat(cStyle.columnGap || '0');
    const firstSiblingMarginLeft = siblingBtns[0]?.marginLeft || 0;
    if ((isFlex && Number.isFinite(colGap) && colGap >= 2) || firstSiblingMarginLeft >= 2) {
      capsuleHost.style.marginRight = '0px';
    } else {
      let measuredGap = 6;
      if (siblingBtns.length >= 2) {
        siblingBtns.sort((a, b) => a.left - b.left);
        const g = Math.round(siblingBtns[1].left - siblingBtns[0].right);
        if (g >= 2 && g <= 24) measuredGap = g;
      }
      capsuleHost.style.marginRight = `${measuredGap}px`;
    }
    capsuleHost.style.marginLeft = '0px';
    capsuleHost.style.top = '';
    capsuleHost.style.right = '';
  }

  function updateFixedPosition() {
    if (capsuleHost.getAttribute('data-dock') !== 'fixed') return;
    const vw = Number(window.innerWidth || 1280);
    const cluster = measureTopRightCluster(vw, capsuleHost, portalHost);
    let topOffset = 8;
    let rightOffset = 18;
    let btnHeight = 28;
    if (cluster) {
      btnHeight = Math.max(24, Math.min(34, Math.round(cluster.anchorHeight || 28)));
      topOffset = Math.max(2, Math.round(cluster.anchorTop + (cluster.anchorHeight - btnHeight) / 2));
      rightOffset = Math.max(12, Math.ceil(vw - cluster.clusterLeft + cluster.clusterGap));
    }
    capsuleHost.style.marginRight = '';
    capsuleHost.style.marginLeft = '';
    capsuleHost.style.top = `${topOffset}px`;
    capsuleHost.style.right = `${rightOffset}px`;
    capsuleHost.style.height = `${btnHeight}px`;
    capsuleBtn.style.height = `${btnHeight}px`;
  }

  function positionPopover() {
    if (!isPopoverOpen()) return;
    const bRect = capsuleBtn.getBoundingClientRect();
    if (bRect.width === 0 && bRect.height === 0) return;

    const vw = Number(window.innerWidth || 1280);
    const vh = Number(window.innerHeight || 800);
    let minLeft = 12;
    const navEl = document.querySelector('div[role="navigation"]');
    if (navEl) {
      const nr = navEl.getBoundingClientRect();
      if (nr.width > 0 && nr.left <= 8 && nr.right < vw - 280) {
        minLeft = Math.max(12, Math.ceil(nr.right + 12));
      }
    }

    const panelW = Math.min(390, Math.max(280, vw - minLeft - 12));
    popoverEl.style.width = `${panelW}px`;
    const top = Math.max(38, Math.round(bRect.bottom + 6));
    const maxH = Math.max(220, vh - top - 12);
    popoverEl.style.maxHeight = `${maxH}px`;

    let left = Math.round(bRect.right - panelW);
    left = Math.min(left, vw - panelW - 12);
    left = Math.max(minLeft, left);
    popoverEl.style.top = `${top}px`;
    popoverEl.style.left = `${left}px`;
  }

  function ensureDocked() {
    const body = document.body || document.documentElement;
    if (!body) return false;
    if (!portalHost.isConnected) body.appendChild(portalHost);

    const ctx = getContext();
    const shouldShow = ctx.inConversation;
    if (capsuleHost.hidden !== !shouldShow) {
      capsuleHost.hidden = !shouldShow;
    }
    if (!shouldShow && isPopoverOpen()) {
      onClosePopover();
    }

    const dock = findDockTarget(capsuleHost);
    if (dock) {
      if (capsuleHost.parentElement !== dock.container || dock.container.firstChild !== capsuleHost) {
        if (dock.container.firstChild) {
          dock.container.insertBefore(capsuleHost, dock.container.firstChild);
        } else {
          dock.container.appendChild(capsuleHost);
        }
      }
      if (capsuleHost.getAttribute('data-dock') !== 'flow') {
        capsuleHost.setAttribute('data-dock', 'flow');
      }
      syncFlowButtonMetrics(dock.container);
    } else {
      if (capsuleHost.parentElement !== body) {
        body.appendChild(capsuleHost);
      }
      if (capsuleHost.getAttribute('data-dock') !== 'fixed') {
        capsuleHost.setAttribute('data-dock', 'fixed');
      }
      if (shouldShow) {
        updateFixedPosition();
      }
    }
    if (isPopoverOpen()) positionPopover();
    return Boolean(capsuleHost.isConnected && portalHost.isConnected);
  }

  return { ensureDocked, positionPopover, updateFixedPosition };
}
