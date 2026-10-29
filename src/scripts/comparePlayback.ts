/** Minimal player contract makes synchronized switching independently testable. */
export interface ComparablePlayer {
  currentTime: number;
  duration: number;
  playing: boolean;
  pause(): void;
  play(): void;
  seekTo(seconds: number): Promise<void>;
}

/** Pause the old source and resume the other at the same timeline position. */
export async function switchPlayback(current: ComparablePlayer, next: ComparablePlayer): Promise<void> {
  const wasPlaying = current.playing;
  const time = Math.max(0, Number.isFinite(current.currentTime) ? current.currentTime : 0);
  const position = next.duration > 0 ? Math.min(time, next.duration) : time;
  current.pause();
  try {
    await next.seekTo(position);
    if (wasPlaying) next.play();
  } catch (error) {
    // Don't strand the listener in silence if the new player can't seek.
    if (wasPlaying) current.play();
    throw error;
  }
}
