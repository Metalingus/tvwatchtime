import { Paginated, PaginationQuery } from './common';
import { ListVisibility, MediaType, NotificationSort } from './enums';
import { PublicUserDto } from './auth';

export interface CommentDto {
  id: string;
  parentId?: string | null;
  threadType: 'SHOW' | 'MOVIE' | 'EPISODE';
  threadId: string;
  author: PublicUserDto;
  body: string;
  imageUrl?: string | null;
  likesCount: number;
  repliesCount: number;
  likedByMe: boolean;
  reportedByMe: boolean;
  createdAt: string;
}

export interface CommentQuery extends PaginationQuery {
  sort?: NotificationSort;
}

export interface CreateCommentDto {
  threadType: 'SHOW' | 'MOVIE' | 'EPISODE';
  threadId: string;
  body: string;
  imageUrl?: string;
  parentId?: string;
}

export interface PaginatedComments extends Paginated<CommentDto> {}

export interface RatingDto {
  mediaType: MediaType;
  mediaId: string;
  rating: number; // 1..5
}

export interface ReactionDto {
  episodeId: string;
  reaction: string;
}

export interface CharacterVoteDto {
  episodeId: string;
  characterId: string;
}

export interface CustomListSummaryDto {
  id: string;
  title: string;
  description?: string | null;
  coverUrl?: string | null;
  visibility: ListVisibility;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomListDto extends CustomListSummaryDto {
  items: {
    id: string;
    mediaType: MediaType;
    mediaId: string;
    title: string;
    posterUrl?: string | null;
  }[];
}

export interface CreateListDto {
  title: string;
  description?: string;
  coverUrl?: string;
  visibility?: ListVisibility;
}

export interface AddListItemDto {
  mediaType: MediaType;
  mediaId: string;
}

export interface FollowDto {
  userId: string;
}

export interface FollowCountsDto {
  followingCount: number;
  followersCount: number;
}

export interface ActivityItemDto {
  id: string;
  type: 'WATCHED' | 'RATED' | 'FAVORITED' | 'ADDED_LIST' | 'BADGE';
  text: string;
  mediaTitle?: string | null;
  mediaPoster?: string | null;
  createdAt: string;
}

export interface SearchQuery extends PaginationQuery {
  q: string;
  type?: MediaType | 'ALL';
}
