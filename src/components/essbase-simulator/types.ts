export type VisualType = 'intro' | 'cube' | 'architecture' | 'roadmap' | 'gains' | 'summary';

export interface PresentationScene {
  id: number;
  title: string;
  subtitle: string;
  description: string;
  voiceText: string;
  durationMs: number;
  visualType: VisualType;
}
