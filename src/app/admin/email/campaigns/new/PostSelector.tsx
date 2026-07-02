'use client';

interface Post {
  id: number;
  title: string;
  category: string;
  slug: string;
}

interface PostSelectorProps {
  posts: Post[];
}

export default function PostSelector({ posts }: PostSelectorProps) {
  const categories = Array.from(new Set(posts.map((p) => p.category))).sort();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const postId = parseInt(e.target.value);
    if (!postId) return;
    const post = posts.find((p) => p.id === postId);
    if (!post) return;

    const subjectEl = document.getElementById('subject') as HTMLInputElement | null;
    if (subjectEl) subjectEl.value = post.title;

    const categoryEl = document.getElementById('category') as HTMLInputElement | null;
    if (categoryEl) categoryEl.value = post.category;

    const postIdEl = document.getElementById('postId') as HTMLInputElement | null;
    if (postIdEl) postIdEl.value = String(post.id);

    const bodyEl = document.getElementById('bodyHtml') as HTMLTextAreaElement | null;
    if (bodyEl) {
      bodyEl.value = `<h2>${post.title}</h2>

<p>We have a new post that we think you'll find valuable.</p>

<p>In this article, we cover key insights and practical guidance for Oracle and EBS professionals.</p>

<p><a href="https://appsdba.info/posts/${post.slug}">Read the full article →</a></p>

<hr />

<p style="font-size: 12px; color: #999;">
  You're receiving this because you subscribed to AppsDBA.info updates.<br />
  <a href="https://appsdba.info/unsubscribe">Unsubscribe</a>
</p>`;
    }
  }

  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">
        Generate from Blog Post (optional)
      </label>
      <select
        onChange={handleChange}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        defaultValue=""
      >
        <option value="">— Select a post to auto-fill —</option>
        {categories.map((cat) => (
          <optgroup key={cat} label={cat}>
            {posts
              .filter((p) => p.category === cat)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <p className="text-xs text-gray-400 mt-1">
        Selecting a post will auto-populate subject, category, and email body.
      </p>
    </div>
  );
}
