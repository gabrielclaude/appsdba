interface VideoPlayerProps {
  url: string;
  title: string;
}

export function VideoPlayer({ url, title }: VideoPlayerProps) {
  return (
    <div className="mb-8 rounded-xl overflow-hidden border border-gray-200 bg-black">
      <video
        controls
        preload="metadata"
        className="w-full"
        aria-label={title}
      >
        <source src={url} type="video/mp4" />
        Your browser does not support the video tag.
      </video>
    </div>
  );
}
