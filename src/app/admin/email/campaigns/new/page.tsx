import { redirect } from 'next/navigation';
import { db } from '@/db';
import { emailCampaigns, posts } from '@/db/schema';
import { auth } from '@clerk/nextjs/server';
import { eq, desc } from 'drizzle-orm';
import PostSelector from './PostSelector';

async function createCampaign(formData: FormData) {
  'use server';
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');

  const name = formData.get('name') as string;
  const subject = formData.get('subject') as string;
  const previewText = formData.get('previewText') as string;
  const postIdStr = formData.get('postId') as string;
  const category = formData.get('category') as string;
  let bodyHtml = formData.get('bodyHtml') as string;

  if (!name || !subject || !bodyHtml) return;

  const postId = postIdStr ? parseInt(postIdStr) : undefined;

  if (postId) {
    const [post] = await db
      .select({ title: posts.title, slug: posts.slug, excerpt: posts.excerpt })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    if (post) {
      const header = `<h2>${post.title}</h2>\n${post.excerpt ? `<p>${post.excerpt}</p>\n` : ''}<p><a href="${process.env.NEXT_PUBLIC_URL ?? 'https://appsdba.vercel.app'}/posts/${post.slug}">Read the full article →</a></p>\n\n`;
      if (!bodyHtml.includes(post.title)) {
        bodyHtml = header + bodyHtml;
      }
    }
  }

  await db.insert(emailCampaigns).values({
    name,
    subject,
    previewText: previewText || null,
    bodyHtml,
    postId: postId ?? null,
    category: category || null,
    status: 'draft',
  });

  redirect('/admin/email/campaigns');
}

export default async function NewCampaignPage() {
  const publishedPosts = await db
    .select({ id: posts.id, title: posts.title, category: posts.category, slug: posts.slug })
    .from(posts)
    .where(eq(posts.published, true))
    .orderBy(desc(posts.publishedAt));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Create Campaign</h1>

      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-6">New Email Campaign</h2>
        <form action={createCampaign} className="space-y-5">
          {/* Hidden postId field (populated by PostSelector) */}
          <input type="hidden" name="postId" id="postId" />

          {/* Campaign Name */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Campaign Name *</label>
            <input
              name="name"
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="July Newsletter — Oracle Performance Tips"
            />
          </div>

          {/* Post Selector */}
          <PostSelector posts={publishedPosts} />

          {/* Subject Line */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Subject Line *</label>
            <input
              id="subject"
              name="subject"
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="New post: Oracle AWR Tablespace Relocation Guide"
            />
          </div>

          {/* Preview Text */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Preview Text</label>
            <input
              name="previewText"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="Appears after subject in inbox"
            />
            <p className="text-xs text-gray-400 mt-1">Appears after subject line in email clients</p>
          </div>

          {/* Category */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
            <input
              id="category"
              name="category"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="oracle-database"
            />
          </div>

          {/* Email Body HTML */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Email Body (HTML) *</label>
            <textarea
              id="bodyHtml"
              name="bodyHtml"
              rows={15}
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-400"
              placeholder="<p>Hello,</p>&#10;<p>We have a new article for you...</p>"
            />
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Save as Draft
            </button>
            <a
              href="/admin/email/campaigns"
              className="px-6 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </a>
          </div>
        </form>
      </div>
    </div>
  );
}
