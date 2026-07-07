import { Paginated, PaginationQuery } from './common';
import { BadgeCategory } from './enums';

export interface BadgeDto {
  id: string;
  category: BadgeCategory;
  name: string;
  description: string;
  icon: string; // emoji or icon key
  iconColor?: string | null;
  scopeType?: 'GLOBAL' | 'SHOW' | 'MOVIE' | null;
  scopeMediaId?: string | null;
  unlockCondition: string;
  threshold?: number | null;
}

export interface UserBadgeDto extends BadgeDto {
  unlocked: boolean;
  unlockedAt?: string | null;
  progress: number; // 0..1
  current?: number;
  target?: number;
}

export interface BadgeProgressDto {
  badges: UserBadgeDto[];
  totalUnlocked: number;
  totalBadges: number;
}

export interface PaginatedBadges extends Paginated<BadgeDto> {}
