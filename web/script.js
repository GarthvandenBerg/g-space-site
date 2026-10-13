(() => {
  'use strict';

  const POSTS_DIR = 'posts/';
  const WORDS_PER_MINUTE = 200;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const searchInput = $('searchInput');
  const tagFiltersEl = $('tagFilters');
  const postsEl = $('posts');
  const emptyStateEl = $('emptyState');
  const hamburgerBtn = $('hamburgerBtn');
  const navMenu = $('navMenu');
  const modal = $('postModal');
  const modalCloseBtn = $('modalCloseBtn');
  const modalDate = $('modalDate');
  const modalReadTime = $('modalReadTime');
  const modalTitle = $('modalTitle');
  const modalTags = $('modalTags');
  const modalBody = $('modalBody');

  const state = {
    posts: [],
    bySlug: new Map(),
    activeTag: 'all',
    lastFocus: null,
  };

  // ---------- Small helpers ----------
  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof content === 'string') node.textContent = content;
    else if (Array.isArray(content)) content.forEach((c) => node.append(c));
    return node;
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function fetchText(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.text();
  }

  // ---------- Markdown (small, safe subset) ----------
  // Supports: headings, paragraphs, **bold**, *italic*, `code`, [links](url),
  // fenced code blocks, bullet/numbered lists, blockquotes.
  // All raw HTML in posts is escaped, so a post can never inject markup.
  function renderInline(text) {
    let s = escapeHtml(text);
    const codeSpans = [];
    s = s.replace(/`([^`]+)`/g, (_, code) => {
      codeSpans.push(code);
      return `\u0000${codeSpans.length - 1}\u0000`;
    });
    s = s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*|#[^\s)]*)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      );
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codeSpans[i]}</code>`);
  }

  function renderMarkdown(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    const isBlockStart = (l) =>
      /^```/.test(l) || /^#{1,4}\s/.test(l) || /^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l) || /^>/.test(l);
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      // Fenced code block
      if (/^```/.test(line)) {
        const lang = line.slice(3).trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; // closing fence
        const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
        out.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
        continue;
      }

      // Heading (# and ## both become h2 because the post title is the h1)
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const level = Math.max(2, h[1].length);
        out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
        i++;
        continue;
      }

      // Bullet list
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
          i++;
        }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      // Numbered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
          i++;
        }
        out.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      // Blockquote
      if (/^>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push(`<blockquote>${renderInline(buf.join(' '))}</blockquote>`);
        continue;
      }

      // Paragraph
      const buf = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${renderInline(buf.join(' '))}</p>`);
    }

    return out.join('\n');
  }

  // ---------- Post parsing ----------
  function parseTags(value) {
    return (value || '')
      .split(/[,\s]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean);
  }

  function parsePost(slug, raw) {
    const text = raw.replace(/\r\n/g, '\n');
    const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const meta = {};
    let body = text;

    if (match) {
      body = match[2];
      match[1].split('\n').forEach((line) => {
        const kv = line.match(/^([\w-]+):\s*(.*)$/);
        if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
      });
    }

    body = body.trim();
    const words = body.split(/\s+/).filter(Boolean).length;
    const firstPara = body.split(/\n\s*\n/)[0] || '';
    const plainFirst = firstPara.replace(/[`*#>\[\]()]/g, '').replace(/\s+/g, ' ').trim();

    const tagList = parseTags(meta.tags);

    return {
      slug,
      title: meta.title || slug,
      date: meta.date || '',
      summary: meta.summary || (plainFirst.length > 160 ? plainFirst.slice(0, 157) + '…' : plainFirst),
      readTime: parseInt(meta.readTime, 10) || Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)),
      tags: tagList.map((t) => t.toLowerCase()),
      tagLabels: tagList, // original casing, used for filter buttons
      draft: /^(true|yes)$/i.test(meta.draft || ''),
      body,
      card: null,
      haystack: '',
    };
  }

  // ---------- Rendering ----------
  function buildCard(post) {
    const card = el('article', 'post-card', [
      el('div', 'card-meta', [el('span', 'date', post.date), el('span', 'read-time', `${post.readTime} min read`)]),
      el('h2', '', post.title),
      el('p', '', post.summary),
      el('div', 'card-tags', post.tags.map((t) => el('span', 'tag', `#${t}`))),
    ]);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.dataset.slug = post.slug;
    return card;
  }

  function buildTagFilters() {
    const labels = new Map(); // lowercase -> display label
    state.posts.forEach((p) => p.tagLabels.forEach((l) => {
      if (!labels.has(l.toLowerCase())) labels.set(l.toLowerCase(), l);
    }));

    const makeBtn = (tag, label) => {
      const b = el('button', 'tag-btn' + (tag === 'all' ? ' active' : ''), label);
      b.type = 'button';
      b.dataset.tag = tag;
      return b;
    };

    tagFiltersEl.replaceChildren(
      makeBtn('all', 'All'),
      ...[...labels.entries()].sort().map(([tag, label]) => makeBtn(tag, label))
    );
  }

  function filterPosts() {
    const query = searchInput.value.toLowerCase().trim();
    let visible = 0;

    state.posts.forEach((post) => {
      const matchesTag = state.activeTag === 'all' || post.tags.includes(state.activeTag);
      const matchesQuery = !query || post.haystack.includes(query);
      const show = matchesTag && matchesQuery;
      post.card.hidden = !show;
      if (show) visible++;
    });

    emptyStateEl.hidden = visible !== 0 || state.posts.length === 0;
  }

  // ---------- Modal ----------
  function showModal(post) {
    modalTitle.textContent = post.title;
    modalDate.textContent = post.date;
    modalReadTime.textContent = `${post.readTime} min read`;
    modalTags.replaceChildren(...post.tags.map((t) => el('span', 'tag', `#${t}`)));
    modalBody.innerHTML = renderMarkdown(post.body);
    modal.classList.add('active');
    document.body.classList.add('modal-open');
    modal.querySelector('.modal-content').scrollTop = 0;
    modalCloseBtn.focus();
  }

  function hideModal() {
    if (!modal.classList.contains('active')) return;
    modal.classList.remove('active');
    document.body.classList.remove('modal-open');
    if (state.lastFocus) state.lastFocus.focus();
  }

  function openPost(slug, opener) {
    const post = state.bySlug.get(slug);
    if (!post) return;
    state.lastFocus = opener || null;
    history.pushState({ modal: true }, '', `#post/${slug}`);
    showModal(post);
  }

  function closeModal() {
    if (history.state && history.state.modal) {
      history.back(); // popstate handler hides the modal
    } else {
      history.replaceState(null, '', location.pathname + location.search);
      hideModal();
    }
  }

  function syncModalWithUrl() {
    const m = location.hash.match(/^#post\/([\w-]+)$/);
    const post = m && state.bySlug.get(m[1]);
    if (post) showModal(post);
    else hideModal();
  }

  // ---------- Loading ----------
  async function loadPosts() {
    const slugs = JSON.parse(await fetchText(POSTS_DIR + 'index.json'));

    const results = await Promise.allSettled(
      slugs.map(async (slug) => parsePost(slug, await fetchText(`${POSTS_DIR}${slug}.md`)))
    );

    const posts = [];
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') posts.push(r.value);
      else console.warn(`Skipped post "${slugs[idx]}":`, r.reason);
    });

    return posts
      .filter((p) => !p.draft)
      .sort((a, b) => b.date.localeCompare(a.date)); // newest first
  }

  async function init() {
    try {
      state.posts = await loadPosts();
    } catch (err) {
      console.error(err);
      postsEl.replaceChildren(
        el('p', 'status-msg',
          `Could not load posts (${err.message}). If you opened index.html by double-clicking it, serve the folder over HTTP instead (e.g. python3 -m http.server, or VS Code's Live Server).`)
      );
      return;
    }

    state.posts.forEach((post) => {
      post.card = buildCard(post);
      post.haystack = [post.title, post.summary, post.body, post.date, ...post.tags.map((t) => `#${t}`)]
        .join(' ')
        .toLowerCase();
      state.bySlug.set(post.slug, post);
    });

    postsEl.replaceChildren(...state.posts.map((p) => p.card));
    buildTagFilters();
    filterPosts();
    syncModalWithUrl(); // supports deep links like /#post/nginx-hardening
  }

  // ---------- Events ----------
  postsEl.addEventListener('click', (e) => {
    const card = e.target.closest('.post-card');
    if (card) openPost(card.dataset.slug, card);
  });

  postsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.post-card');
    if (card) {
      e.preventDefault();
      openPost(card.dataset.slug, card);
    }
  });

  modalCloseBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) closeModal();
  });
  window.addEventListener('popstate', syncModalWithUrl);

  hamburgerBtn.addEventListener('click', () => navMenu.classList.toggle('active'));
  navMenu.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') navMenu.classList.remove('active');
  });

  searchInput.addEventListener('input', filterPosts);
  tagFiltersEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.tag-btn');
    if (!btn) return;
    tagFiltersEl.querySelectorAll('.tag-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeTag = btn.dataset.tag;
    filterPosts();
  });

  init();
})();