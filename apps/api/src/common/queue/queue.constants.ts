export const QUEUES = {
  METADATA: 'metadata',
  NOTIFICATIONS: 'notifications',
  STATS: 'stats',
  IMPORTS: 'imports',
  BADGES: 'badges',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
