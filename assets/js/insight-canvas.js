/**
 * Insight Canvas — v1.1 AntV X6 洞察信息图谱前端
 *
 * 改动要点 vs v1.0:
 * - 支持后端新 schema: node.data.layer (0-4), 不再依赖 x/y
 * - 使用 @antv/layout Dagre 自动按 layer 分层布局 (left→right)
 * - 节点用 X6 的 "html" shape 渲染出 5 层差异化视觉
 * - Lightbox 用 CSS position: fixed + translate(-50%, -50%) 显式居中
 * - 顶部工具栏: zoom-out / zoom-in / fit / close
 * - 底部 legend (由 HTML 静态给出)
 * - 打开时保存 scrollY + lock body overflow, 关闭时复位滚动位置
 * - 边: manhattan 路由 + rounded 连接器, 主干 1.5px + 虚线 0.8px
 *
 * 接口 (与 Go 端 internal/canvas/schema.go 对齐):
 *   {
 *     title, summary,
 *     nodes: [{ id, shape: "hero"|"rounded"|"pill", label,
 *       data: { layer: 0-4, tier, description, highlight, source_url? } }],
 *     edges: [{ id, source, target, label?, style?: "solid"|"dashed" }]
 *   }
 */

const X6_CDNS = [
  'https://cdn.jsdelivr.net/npm/@antv/x6@2/dist/x6.min.js',
  'https://unpkg.com/@antv/x6@2/dist/x6.min.js',
];

// v1.1: dagre layout for automatic layered positioning
const LAYOUT_CDNS = [
  'https://cdn.jsdelivr.net/npm/@antv/layout@0.3.25/dist/layout.min.js',
  'https://unpkg.com/@antv/layout@0.3.25/dist/layout.min.js',
];

// 5 层语义标签, 用于节点上的 tag 文字
const LAYER_TAGS = {
  0: '今日主题',
  1: '关键信号',
  2: '趋势',
  3: '机会 / 风险',
  4: '行动',
};

// 每层节点的默认尺寸 (px). Dagre 会用这些做间距计算.
// hero 最宽, pill 最窄, 其余递减.
const LAYER_SIZE = {
  0: { w: 260, h: 84 },
  1: { w: 210, h: 72 },
  2: { w: 200, h: 68 },
  3: { w: 200, h: 64 },
  4: { w: 180, h: 44 },
};

// ---------- 工具 ----------
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(s);
  });
}

async function loadWithFallback(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      await loadScript(url);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All CDN fallbacks failed');
}

let depsPromise = null;
function ensureDeps() {
  if (window.X6 && window.X6.Graph && window.layout) return Promise.resolve();
  if (!depsPromise) {
    depsPromise = (async () => {
      if (!(window.X6 && window.X6.Graph)) {
        await loadWithFallback(X6_CDNS);
      }
      if (!window.layout) {
        try {
          await loadWithFallback(LAYOUT_CDNS);
        } catch (e) {
          console.warn('[insight-canvas] layout lib failed to load, will fall back to static positioning', e);
        }
      }
    })();
  }
  return depsPromise;
}

function isMobile() {
  return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
}

function showError(container, msg = '洞察图谱暂不可用') {
  const preview = container.querySelector('.insight-canvas-preview');
  if (!preview) return;
  preview.innerHTML = `<div class="insight-canvas-error">${msg}</div>`;
  const btn = container.querySelector('.insight-canvas-expand');
  if (btn) btn.style.display = 'none';
}

// 基础 HTML 转义 (label / description 都是 LLM 产物, 要防 XSS)
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- HTML 节点工厂 ----------
// X6 v2 渲染 HTML 节点需要经 Shape.HTML.register({ shape, html }).
// 我们注册 "ic-node", html 回调根据 cell.getData() 构 DOM.
function registerHTMLNodeShape() {
  const { X6 } = window;
  if (!X6 || !X6.Shape || !X6.Shape.HTML) return;
  if (window.__icNodeRegistered) return;
  window.__icNodeRegistered = true;

  X6.Shape.HTML.register({
    shape: 'ic-node',
    width: 200,
    height: 64,
    effect: ['data'], // 当 data 变化时自动重渲染
    html(cell) {
      return buildNodeElement(cell);
    },
  });
}

// 节点 -> DOM Element (用于 X6 HTML.register 回调)
function buildNodeElement(cell) {
  const d = (cell && typeof cell.getData === 'function') ? (cell.getData() || {}) : {};
  const layer = typeof d.layer === 'number' ? d.layer : tierToLayer(d.tier);
  const highlight = d.highlight === true;
  const tag = LAYER_TAGS[layer] || '';
  const label = d.label || '';

  const el = document.createElement('div');
  el.className = 'ic-node-body';
  el.setAttribute('data-layer', String(layer));
  el.setAttribute('data-tier', d.tier || '');
  el.setAttribute('data-highlight', highlight ? 'true' : 'false');
  if (d.description) el.setAttribute('title', d.description);

  // 2026-04-24: 去掉节点顶部的 layer tag — 用户反馈和 edge label 样式
  // 撞色且被连线穿过, 语义冗余 (颜色 + 底部 legend 已经表达层级).
  el.innerHTML = `<span class="ic-node-label">${escapeHtml(label)}</span>`;
  return el;
}

// v1.0 兼容: 若只有 tier 没有 layer, 映射到 layer
function tierToLayer(tier) {
  switch ((tier || '').toLowerCase()) {
    case 'hero': return 0;
    case 'signal': return 1;
    case 'insight':   // v1.0 insight 折到 layer 2
    case 'trend': return 2;
    case 'opportunity':
    case 'risk':
    case 'competitor': return 3; // v1.0 competitor 折到 layer 3
    case 'action': return 4;
    default: return 1;
  }
}

// ---------- 图数据转换 ----------
function flowToX6(flow) {
  const rawNodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const rawEdges = Array.isArray(flow.edges) ? flow.edges : [];

  // 判断是否需要自动布局: 只要任一节点缺 x/y 就整张图自动布局
  const needsLayout = rawNodes.some((n) => {
    const nx = typeof n.x === 'number' ? n.x : 0;
    const ny = typeof n.y === 'number' ? n.y : 0;
    return nx === 0 && ny === 0;
  });

  // 先构 X6 节点 (坐标占位). 用我们注册的 'ic-node' shape, html() 回调
  // 在 registerHTMLNodeShape() 里, 从 cell.getData() 读字段.
  const nodes = rawNodes.map((n) => {
    const data = n.data || {};
    const layer = typeof data.layer === 'number' ? data.layer : tierToLayer(data.tier);
    const size = LAYER_SIZE[layer] || LAYER_SIZE[1];
    const width = n.width || size.w;
    const height = n.height || size.h;
    return {
      id: n.id,
      shape: 'ic-node',
      x: n.x || 0,
      y: n.y || 0,
      width,
      height,
      data: {
        ...data,
        layer,
        label: n.label,
      },
    };
  });

  // 运行 dagre 自动布局 (若需要)
  if (needsLayout && window.layout && window.layout.DagreLayout) {
    const dagreNodes = nodes.map((n) => ({
      id: n.id,
      size: [n.width, n.height],
      // layer field 让 Dagre 把相同 layer 的节点放到同一列 (LR 方向)
      layer: n.data.layer,
    }));
    const dagreEdges = rawEdges.map((e) => ({ source: e.source, target: e.target }));

    try {
      const dagre = new window.layout.DagreLayout({
        type: 'dagre',
        rankdir: 'LR',          // 从左到右: hero → signal → trend → opp/risk → action
        align: undefined,       // 每列垂直居中, hero 自动在整图中心 (思维导图式)
        ranksep: 180,           // 列间距 (240 太空, 180 刚好让 label 不拥挤又不过长)
        nodesep: 78,            // 同列节点间距
        controlPoints: false,
      });
      const out = dagre.layout({ nodes: dagreNodes, edges: dagreEdges });
      // 回写坐标到 nodes
      const pos = new Map((out && out.nodes ? out.nodes : dagreNodes).map((n) => [n.id, n]));
      nodes.forEach((n) => {
        const p = pos.get(n.id);
        if (p && typeof p.x === 'number' && typeof p.y === 'number') {
          // Dagre 返回的是节点中心; X6 要求左上角, 需要减去半 size
          n.x = Math.round(p.x - n.width / 2);
          n.y = Math.round(p.y - n.height / 2);
        }
      });
    } catch (err) {
      console.warn('[insight-canvas] Dagre layout failed, using fallback column layout', err);
      fallbackLayerLayout(nodes);
    }
  } else if (needsLayout) {
    // 没有 layout 库可用, 走简单分列 fallback
    fallbackLayerLayout(nodes);
  }

  const edges = rawEdges.map((e) => {
    const dashed = e.style === 'dashed';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      labels: e.label
        ? [
            {
              // X6 v2 默认 markup: rect[selector="body"] + text[selector="label"].
              // 之前用 attrs.rect/attrs.text 是错的 selector, fill 没生效所以
              // line path 直接穿过文字. 这里改回正确的 body/label + 明确 fill.
              position: 0.5,
              attrs: {
                body: {
                  // 把矩形撑到 label 文字外圈: refX/refY 左上偏移, refWidth2/refHeight2 加 padding
                  ref: 'label',
                  refX: -6,
                  refY: -3,
                  refWidth: '100%',
                  refHeight: '100%',
                  refWidth2: 12,
                  refHeight2: 6,
                  rx: 6,
                  ry: 6,
                  fill: 'var(--ic-edge-label-bg, #FFFFFF)',
                  stroke: 'var(--ic-line, #E5E7EB)',
                  strokeWidth: 1,
                  class: 'ic-edge-label-bg',
                  pointerEvents: 'none',
                },
                label: {
                  text: e.label,
                  fontSize: 10.5,
                  fontWeight: 500,
                  fontFamily: "'Inter', 'Noto Sans SC', sans-serif",
                  fill: 'var(--ic-fg-soft, #334155)',
                  textAnchor: 'middle',
                  textVerticalAnchor: 'middle',
                  class: 'ic-edge-label-text',
                  pointerEvents: 'none',
                },
              },
            },
          ]
        : [],
      attrs: {
        line: {
          strokeWidth: dashed ? 0.9 : 1.5,
          strokeDasharray: dashed ? '4 3' : null,
          targetMarker: { name: 'block', size: 5, offset: 0 },
          class: dashed ? 'ic-edge-line-dashed' : 'ic-edge-line',
        },
      },
      router: { name: 'manhattan', args: { padding: 24, step: 32 } },
      connector: { name: 'rounded', args: { radius: 6 } },
      zIndex: dashed ? 0 : 1,
    };
  });

  return { nodes, edges };
}

// 简单分列兜底: 同 layer 节点排成一列
function fallbackLayerLayout(nodes) {
  const colsByLayer = {};
  nodes.forEach((n) => {
    const l = n.data.layer;
    if (!colsByLayer[l]) colsByLayer[l] = [];
    colsByLayer[l].push(n);
  });
  const sortedLayers = Object.keys(colsByLayer).map(Number).sort((a, b) => a - b);
  let x = 40;
  sortedLayers.forEach((layer) => {
    const col = colsByLayer[layer];
    const maxW = Math.max(...col.map((n) => n.width));
    let y = 40;
    col.forEach((n) => {
      n.x = x + Math.round((maxW - n.width) / 2);
      n.y = y;
      y += n.height + 20;
    });
    x += maxW + 60;
  });
}

// ---------- Graph 工厂 ----------
function createGraph(container, flow, opts = {}) {
  const { X6 } = window;
  if (!X6 || !X6.Graph) throw new Error('X6 not loaded');
  registerHTMLNodeShape();

  const rect = container.getBoundingClientRect();
  const width = Math.max(opts.width || rect.width || 600, 240);
  const height = Math.max(opts.height || rect.height || 320, 200);

  const graph = new X6.Graph({
    container,
    width,
    height,
    background: { color: 'transparent' },
    grid: false,
    interacting: opts.interactive === false
      ? false
      : {
          nodeMovable: false,
          edgeMovable: false,
          edgeLabelMovable: false,
          arrowheadMovable: false,
          vertexMovable: false,
        },
    mousewheel: opts.interactive === false
      ? false
      : { enabled: true, modifiers: null, maxScale: 2.4, minScale: 0.4, zoomAtMousePosition: true },
    panning: opts.interactive === false ? false : { enabled: true },
    connecting: {
      router: { name: 'manhattan', args: { padding: 24, step: 32 } },
      connector: { name: 'rounded', args: { radius: 6 } },
      anchor: 'center',
      connectionPoint: 'boundary',
      allowBlank: false,
      allowEdge: false,
      allowLoop: false,
      allowMulti: 'withPort',
    },
  });

  const { nodes, edges } = flowToX6(flow);
  graph.fromJSON({ nodes, edges });

  // 给每个 X6 node view 加 data-tier / data-highlight (给 CSS 用)
  try {
    graph.getNodes().forEach((node) => {
      const view = graph.findViewByCell(node);
      if (view && view.container) {
        const d = node.getData() || {};
        view.container.setAttribute('data-tier', d.tier || '');
        view.container.setAttribute('data-layer', String(d.layer ?? ''));
        view.container.setAttribute('data-highlight', d.highlight ? 'true' : 'false');
      }
    });
  } catch (e) {
    console.warn('[insight-canvas] setAttribute on node views failed', e);
  }

  try {
    graph.zoomToFit({ padding: opts.interactive === false ? 12 : 24, maxScale: 1.25 });
  } catch (e) {
    /* noop */
  }

  // SVG 没有 z-index, 按 DOM 顺序绘制. X6 manhattan router 多条 edge
  // 会共享 path segment, 其他 edge 的 line 会盖住我的 label rect — 用户
  // 反馈"两个同样式标签, 被线遮挡". 这里把所有 edge label 节点重新
  // appendChild 到 SVG 顶层, 保证它们永远在所有 line path 之上.
  raiseEdgeLabels(graph);

  // Mobile touch gesture: pinch-zoom + 单指 pan.
  // X6 v2 的 mousewheel 配置不识别 touch, 所以 lightbox 在手机上默认无法
  // 缩放画布 — 双指 pinch 不触发 zoom, 仅触发浏览器页面缩放被我们 preventDefault
  // 掉. 这里手动监听 touch 事件把 pinch 距离变化映射到 graph.zoomTo, 单指
  // 拖动走 graph.translateBy 实现 pan. 只在 interactive=true 的 lightbox
  // 上挂, preview 卡片不挂 (preview 不允许缩放).
  if (opts.interactive !== false) {
    attachTouchGestures(graph, container);
  }

  return graph;
}

// raiseEdgeLabels — 把所有 .x6-edge-label DOM 节点移到 SVG 最外层容器
// 的末尾, 确保它们在所有 edges 的 line path 之后绘制 (SVG 按 DOM 顺序).
// 之前用 parent.appendChild(lbl) 只在 edge 自己的 <g> 内移位, 对跨 edge
// 遮挡无效 — 另一条 edge 的 <g> 仍排在后面, 其 path 仍盖 label.
// 这版把 label 统一 appendChild 到 svg 的 viewport (或 svg 本身).
function raiseEdgeLabels(graph) {
  try {
    const svg = graph.container.querySelector('svg');
    if (!svg) return;
    // X6 v2 SVG 结构: svg > g.x6-graph-svg-primer > g.x6-graph-svg-viewport > g.x6-graph-svg-stage
    // label 搬到 stage/viewport 的末尾, 比其他 edge 组都晚绘制.
    const topLayer =
      svg.querySelector('.x6-graph-svg-stage') ||
      svg.querySelector('.x6-graph-svg-viewport') ||
      svg;
    const labels = Array.from(svg.querySelectorAll('.x6-edge-label'));
    labels.forEach((lbl) => topLayer.appendChild(lbl));
  } catch (e) {
    /* noop */
  }
}

// attachTouchGestures — 手机上 X6 v2 默认不识别 pinch 手势, 这里手动
// 把双指 distance 变化映射到 graph.zoomTo, 单指 drag 走 graph.translateBy.
// 结果: iPhone / Android 里 lightbox 可以像原生地图一样双指缩放 + 单指拖动.
function attachTouchGestures(graph, container) {
  let pinchStartDistance = 0;
  let pinchStartScale = 1;
  let pinching = false;
  let panStartX = 0;
  let panStartY = 0;
  let panning = false;

  const target = container;
  if (!target) return;

  const distance = (t0, t1) =>
    Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);

  target.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        pinching = true;
        panning = false;
        pinchStartDistance = distance(e.touches[0], e.touches[1]);
        try {
          pinchStartScale = graph.zoom();
        } catch {
          pinchStartScale = 1;
        }
        e.preventDefault();
      } else if (e.touches.length === 1) {
        panning = true;
        pinching = false;
        panStartX = e.touches[0].clientX;
        panStartY = e.touches[0].clientY;
      }
    },
    { passive: false },
  );

  target.addEventListener(
    'touchmove',
    (e) => {
      if (pinching && e.touches.length === 2) {
        const d = distance(e.touches[0], e.touches[1]);
        if (pinchStartDistance > 0) {
          const scale = pinchStartScale * (d / pinchStartDistance);
          const clamped = Math.max(0.3, Math.min(2.6, scale));
          try {
            graph.zoomTo(clamped);
          } catch {
            /* noop */
          }
        }
        e.preventDefault();
      } else if (panning && e.touches.length === 1) {
        const dx = e.touches[0].clientX - panStartX;
        const dy = e.touches[0].clientY - panStartY;
        panStartX = e.touches[0].clientX;
        panStartY = e.touches[0].clientY;
        try {
          graph.translateBy(dx, dy);
        } catch {
          /* noop */
        }
        e.preventDefault();
      }
    },
    { passive: false },
  );

  const endHandler = (e) => {
    if (e.touches.length < 2) pinching = false;
    if (e.touches.length === 0) panning = false;
  };
  target.addEventListener('touchend', endHandler);
  target.addEventListener('touchcancel', endHandler);
}

// ---------- Lightbox ----------
function openLightbox(container, flow) {
  const dialog = container.querySelector('.insight-canvas-lightbox');
  const full = container.querySelector('.insight-canvas-fullview');
  if (!dialog || !full) return;

  full.innerHTML = '';

  // 保存当前滚动位置, 锁 body
  const savedScrollY = window.scrollY || window.pageYOffset || 0;
  const prevBodyOverflow = document.body.style.overflow;
  const prevBodyPaddingRight = document.body.style.paddingRight;
  dialog.dataset.savedScrollY = String(savedScrollY);
  dialog.dataset.prevBodyOverflow = prevBodyOverflow || '';
  dialog.dataset.prevBodyPaddingRight = prevBodyPaddingRight || '';

  // 补偿滚动条宽度, 防止 body 锁定时页面抖
  const scrollbarW = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.overflow = 'hidden';
  if (scrollbarW > 0) {
    document.body.style.paddingRight = `${scrollbarW}px`;
  }

  const open = () => {
    try {
      if (typeof dialog.showModal === 'function' && !isMobile()) {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    } catch (e) {
      dialog.setAttribute('open', '');
    }

    // Meta: "xx 节点 / xx 关联"
    const metaEl = dialog.querySelector('[data-role="meta"]');
    if (metaEl) {
      const nn = Array.isArray(flow.nodes) ? flow.nodes.length : 0;
      const ne = Array.isArray(flow.edges) ? flow.edges.length : 0;
      metaEl.textContent = `${nn} 节点 · ${ne} 关联`;
    }

    requestAnimationFrame(() => {
      const r = full.getBoundingClientRect();
      try {
        const graph = createGraph(full, flow, { width: r.width, height: r.height, interactive: true });
        dialog._graph = graph;
      } catch (e) {
        console.error('[insight-canvas] Lightbox graph init failed:', e);
        full.innerHTML = '<div class="insight-canvas-error">洞察图谱暂不可用</div>';
      }
    });
  };

  const close = () => {
    try {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    } catch (e) {
      dialog.removeAttribute('open');
    }
    if (dialog._graph) {
      try { dialog._graph.dispose(); } catch (err) {}
      dialog._graph = null;
    }
    full.innerHTML = '';

    // 复位 body + 恢复滚动位置
    document.body.style.overflow = dialog.dataset.prevBodyOverflow || '';
    document.body.style.paddingRight = dialog.dataset.prevBodyPaddingRight || '';
    const sy = parseInt(dialog.dataset.savedScrollY || '0', 10) || 0;
    // 用 auto, 避免 smooth scroll 造成 UX 不稳定
    window.scrollTo({ top: sy, left: 0, behavior: 'auto' });
  };

  const zoom = (delta) => {
    if (!dialog._graph) return;
    try {
      const cur = dialog._graph.zoom();
      dialog._graph.zoomTo(Math.max(0.4, Math.min(2.4, cur + delta)));
    } catch (e) {}
  };

  const fit = () => {
    if (!dialog._graph) return;
    try {
      dialog._graph.zoomToFit({ padding: 24, maxScale: 1.25 });
    } catch (e) {}
  };

  // 只绑定一次
  if (!dialog._bound) {
    dialog._bound = true;

    dialog.addEventListener('click', (e) => {
      // 点 backdrop (dialog 元素本身) 关闭, 点内部工具栏/画布不关
      if (e.target === dialog) close();
    });

    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
      if ((e.key === '+' || e.key === '=') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        zoom(0.15);
      }
      if (e.key === '-' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        zoom(-0.15);
      }
      if (e.key === '0' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        fit();
      }
    });

    // 原生 close 事件 (ESC 或 dialog.close() 都会触发)
    dialog.addEventListener('close', () => {
      if (dialog._graph) {
        try { dialog._graph.dispose(); } catch (err) {}
        dialog._graph = null;
      }
      full.innerHTML = '';
      document.body.style.overflow = dialog.dataset.prevBodyOverflow || '';
      document.body.style.paddingRight = dialog.dataset.prevBodyPaddingRight || '';
      const sy = parseInt(dialog.dataset.savedScrollY || '0', 10) || 0;
      window.scrollTo({ top: sy, left: 0, behavior: 'auto' });
    });

    // 工具栏按钮
    dialog.querySelectorAll('[data-action]').forEach((btn) => {
      const action = btn.getAttribute('data-action');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (action === 'close') close();
        else if (action === 'zoom-in') zoom(0.15);
        else if (action === 'zoom-out') zoom(-0.15);
        else if (action === 'fit') fit();
      });
    });
  }

  open();
}

// ---------- 单容器初始化 ----------
async function initCanvas(container) {
  const src = container.getAttribute('data-src');
  if (!src) {
    showError(container, '洞察图谱暂不可用（缺少数据源）');
    return;
  }

  const preview = container.querySelector('.insight-canvas-preview');
  if (!preview) return;

  let flow;
  try {
    const resp = await fetch(src, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    flow = await resp.json();
    if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
      throw new Error('Invalid flow schema');
    }
    // Sanity floor: even if JSON is well-formed, a canvas with <5 nodes
    // is useless (LLM likely returned a near-empty draft). Treat it as
    // generation failure rather than render a broken diagram.
    if (flow.nodes.length < 5) {
      throw new Error(`Too few nodes (${flow.nodes.length}) — treat as generation failure`);
    }
  } catch (e) {
    console.warn('[insight-canvas] fetch/parse failed:', e);
    showError(container);
    return;
  }

  try {
    await ensureDeps();
  } catch (e) {
    console.error('[insight-canvas] deps load failed:', e);
    showError(container);
    return;
  }

  preview.innerHTML = '';
  let previewGraph = null;
  try {
    previewGraph = createGraph(preview, flow, { interactive: false });
  } catch (e) {
    console.error('[insight-canvas] preview graph init failed:', e);
    showError(container);
    return;
  }

  const openHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openLightbox(container, flow);
  };

  preview.addEventListener('click', openHandler);
  const expandBtn = container.querySelector('.insight-canvas-expand');
  if (expandBtn) expandBtn.addEventListener('click', openHandler);

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (previewGraph) {
        const r = preview.getBoundingClientRect();
        try {
          previewGraph.resize(r.width, r.height);
          previewGraph.zoomToFit({ padding: 12, maxScale: 1.25 });
        } catch (err) {}
      }
    }, 180);
  });
}

// ---------- 入口 ----------
function initAll() {
  const containers = document.querySelectorAll('.insight-canvas');
  containers.forEach((c) => {
    if (c.dataset.icInited === '1') return;
    c.dataset.icInited = '1';
    initCanvas(c).catch((err) => {
      console.error('[insight-canvas] init error:', err);
      showError(c);
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAll);
} else {
  initAll();
}
