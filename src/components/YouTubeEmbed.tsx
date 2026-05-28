'use client';

import { extractYoutubeId } from '@/lib/posts';

interface YouTubeEmbedProps {
  url: string;
  title?: string;
}

export function YouTubeEmbed({ url, title = 'YouTube video' }: YouTubeEmbedProps) {
  const videoId = extractYoutubeId(url);
  if (!videoId) return null;

  return (
    <div className="my-8">
      <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
        <iframe
          className="absolute inset-0 w-full h-full rounded-lg shadow-md"
          src={`https://www.youtube.com/embed/${videoId}`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    </div>
  );
}
