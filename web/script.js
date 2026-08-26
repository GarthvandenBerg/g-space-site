const postsData = [
  {
    id: 'renovate-argocd',
    title: 'Automating Image Updates with Argo CD Image Updater',
    date: '2026-08-25',
    readTime: '5 min read',
    tags: ['kubernetes', 'gitops'],
    summary: 'A look into pushing static build artifacts to container registries and triggering seamless GitOps deployments.',
    content: `
      <p>Automating container deployments using GitOps avoids manual <code>kubectl apply</code> invocations while ensuring cluster reproducibility.</p>
      <p>By leveraging <strong>Argo CD Image Updater</strong>, the controller polls container registries directly (such as GHCR) for changes to specified image tags. When a new tag digest or semantic version is detected, Argo CD automatically updates the running workloads without manual intervention.</p>
      <p>This lightens the setup compared to running external pull request bots for static blog builds.</p>
    `
  },
  {
    id: 'nginx-hardening',
    title: 'Hardening Unprivileged Nginx in Kubernetes',
    date: '2026-08-18',
    readTime: '8 min read',
    tags: ['homelab', 'kubernetes'],
    summary: 'Running non-root Nginx containers with strict security contexts, custom port bindings (8080), and read-only root filesystems.',
    content: `
      <p>Standard Nginx containers default to binding on privileged port 80 and execution under root UID 0. In hardened Kubernetes setups, strict security admission policies block root pods.</p>
      <p>Using the official <code>nginxinc/nginx-unprivileged</code> base image allows serving traffic on port 8080 as UID 101. Combining this with <code>readOnlyRootFilesystem: false</code> and <code>allowPrivilegeEscalation: false</code> creates a secure runtime profile.</p>
    `
  }
];

document.addEventListener('DOMContentLoaded', () => {
  const postsGrid = document.getElementById('posts');
  const searchInput = document.getElementById('searchInput');
  const tagButtons = document.querySelectorAll('.tag-btn');
  const hamburgerBtn = document.getElementById('hamburgerBtn');
  const navMenu = document.getElementById('navMenu');

  const modal = document.getElementById('postModal');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const modalDate = document.getElementById('modalDate');
  const modalReadTime = document.getElementById('modalReadTime');
  const modalTitle = document.getElementById('modalTitle');
  const modalTags = document.getElementById('modalTags');
  const modalBody = document.getElementById('modalBody');

  let activeTag = 'all';

  // Render Post Cards
  function renderPosts() {
    postsGrid.innerHTML = '';
    const query = searchInput.value.toLowerCase().trim();

    postsData.forEach(post => {
      const matchesTag = activeTag === 'all' || post.tags.includes(activeTag);
      const matchesQuery = post.title.toLowerCase().includes(query) || post.summary.toLowerCase().includes(query);

      if (matchesTag && matchesQuery) {
        const card = document.createElement('article');
        card.className = 'post-card';
        card.innerHTML = `
          <div class="card-meta">
            <span class="date">${post.date}</span>
            <span class="read-time">${post.readTime}</span>
          </div>
          <h2>${post.title}</h2>
          <p>${post.summary}</p>
          <div class="card-tags">
            ${post.tags.map(t => `<span class="tag">#${t}</span>`).join('')}
          </div>
        `;
        card.addEventListener('click', () => openModal(post));
        postsGrid.appendChild(card);
      }
    });
  }

  // Open Modal
  function openModal(post) {
    modalDate.innerText = post.date;
    modalReadTime.innerText = post.readTime;
    modalTitle.innerText = post.title;
    modalTags.innerHTML = post.tags.map(t => `<span class="tag">#${t}</span>`).join('');
    modalBody.innerHTML = post.content;
    modal.classList.add('active');
  }

  // Close Modal
  modalCloseBtn.addEventListener('click', () => modal.classList.remove('active'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('active');
  });

  // Mobile Hamburger Toggle
  hamburgerBtn.addEventListener('click', () => navMenu.classList.toggle('active'));

  // Search & Filter
  searchInput.addEventListener('input', renderPosts);
  tagButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tagButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTag = btn.dataset.tag;
      renderPosts();
    });
  });

  renderPosts();
});