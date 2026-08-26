const fullArticleContent = {
  'renovate-argocd': `
    <p>Automating container deployments using GitOps avoids manual <code>kubectl apply</code> commands while keeping cluster configurations auditable in Git repositories.</p>
    <p>By using <strong>Renovate Bot</strong>, dependencies and container image updates generate automated Pull Requests on GitHub. Once code review and GitHub Actions security scans pass, merging into main triggers ArgoCD to synchronize the cluster state.</p>
    <p>This provides an explicit audit trail for every deployed image version.</p>
  `,
  'nginx-hardening': `
    <p>Standard Nginx containers default to binding on privileged port 80 and execution under root UID 0. In hardened Kubernetes setups, strict security policies block root containers.</p>
    <p>Using the official <code>nginxinc/nginx-unprivileged</code> base image allows serving traffic on port 8080 as UID 101. Combining this with <code>allowPrivilegeEscalation: false</code> creates a secure runtime profile.</p>
  `
};

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('searchInput');
  const tagButtons = document.querySelectorAll('.tag-btn');
  const posts = document.querySelectorAll('.post-card');
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

  // Article Search & Filter
  function filterPosts() {
    const query = searchInput.value.toLowerCase().trim();

    posts.forEach(post => {
      const tags = post.dataset.tags ? post.dataset.tags.split(' ') : [];
      const text = post.innerText.toLowerCase();

      const matchesTag = activeTag === 'all' || tags.includes(activeTag);
      const matchesQuery = text.includes(query);

      post.style.display = (matchesTag && matchesQuery) ? 'block' : 'none';
    });
  }

  // Open Full Article Modal
  posts.forEach(post => {
    post.addEventListener('click', () => {
      const postId = post.dataset.postId;
      const title = post.querySelector('h2').innerText;
      const date = post.querySelector('.date').innerText;
      const readTime = post.querySelector('.read-time').innerText;
      const tagsHtml = post.querySelector('.card-tags').innerHTML;

      modalTitle.innerText = title;
      modalDate.innerText = date;
      modalReadTime.innerText = readTime;
      modalTags.innerHTML = tagsHtml;
      modalBody.innerHTML = fullArticleContent[postId] || `<p>${post.querySelector('p').innerText}</p>`;

      modal.classList.add('active');
    });
  });

  // Close Modal
  modalCloseBtn.addEventListener('click', () => modal.classList.remove('active'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('active');
  });

  // Toggle Mobile Navigation
  hamburgerBtn.addEventListener('click', () => navMenu.classList.toggle('active'));

  // Filtering Listeners
  searchInput.addEventListener('input', filterPosts);
  tagButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tagButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTag = btn.dataset.tag;
      filterPosts();
    });
  });
});