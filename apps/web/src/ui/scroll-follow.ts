
export const FOLLOW_SLACK_PX = 70;

export const READER_GESTURE_MS = 300;

export type FollowSignal = {
  escaped: boolean;
  distance: number;
  gestureAgo: number;
};

export function shouldRefollow({ escaped, distance, gestureAgo }: FollowSignal): boolean {
  if (!escaped) return false;
  if (gestureAgo <= READER_GESTURE_MS) return false;
  return distance <= FOLLOW_SLACK_PX;
}
