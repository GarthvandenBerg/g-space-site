document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('searchInput');
  const tagButtons = document.querySelectorAll('.tag-btn');
  const posts = document.querySelectorAll('.post-card');

  let activeTag = 'all';

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