import { Paginated, PaginationQuery } from './common';
import { NotificationCategory, NotificationSort } from './enums';

export interface NotificationItemDto {
  id: string;
  category: NotificationCategory;
  title: string;
  body?: string | null;
  imageUrl?: string | null;
  iconUrl?: string | null;
  actorAvatarUrl?: string | null;
  link?: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationPreferencesDto {
  preferences: Record<NotificationCategory, { push: boolean; inApp: boolean }>;
  quietHoursEnabled: boolean;
  quietHoursStart?: string | null; // "22:00"
  quietHoursEnd?: string | null; // "08:00"
  timezone?: string | null;
}

export interface NotificationQuery extends PaginationQuery {
  unreadOnly?: boolean;
  sort?: NotificationSort;
}

export interface PaginatedNotifications extends Paginated<NotificationItemDto> {}

export interface UpdateNotificationPreferencesDto {
  preferences?: Record<NotificationCategory, { push: boolean; inApp: boolean }>;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  timezone?: string | null;
}
