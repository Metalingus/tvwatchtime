import { Paginated, PaginationQuery } from './common';
import { ListVisibility, MediaType } from './enums';
import { PublicUserDto } from './auth';

/** Sort order for comment feeds and reply threads. */
export type CommentSort = 'LATEST' | 'MOST_LIKED';

/** Image attachment metadata surfaced on a comment DTO. */
export interface CommentImageDto {
  id: string;
  status: string;
  width?: number | null;
  height?: number | null;
  blurhash?: string | null;
}

export interface CommentDto {
  id: string;
  parentId?: string | null;
  threadType: 'SHOW' | 'MOVIE' | 'EPISODE';
  threadId: string;
  author: PublicUserDto;
  body: string;
  imageUrl?: string | null;
  /** Final GIPHY media URL when the comment carries a GIF attachment (https *.giphy.com). */
  gifUrl?: string | null;
  image?: CommentImageDto | null;
  likesCount: number;
  repliesCount: number;
  likedByMe: boolean;
  reportedByMe: boolean;
  /** True when the author soft-deleted the comment (tombstone): body/attachments are hidden. */
  deletedByUser: boolean;
  /** True when the comment has been edited at least once. */
  isEdited: boolean;
  editedAt?: string | null;
  createdAt: string;
}

export interface CommentQuery extends PaginationQuery {
  sort?: CommentSort;
}

export interface CommentRepliesQuery extends PaginationQuery {
  sort?: CommentSort;
}

export interface CreateCommentDto {
  threadType: 'SHOW' | 'MOVIE' | 'EPISODE';
  threadId: string;
  body?: string;
  imageUrl?: string;
  /** Final GIPHY media URL. Must be https and hosted on giphy.com / *.giphy.com. */
  gifUrl?: string;
  parentId?: string;
}

export interface UpdateCommentDto {
  body?: string;
  /** Set to null to clear an existing GIF attachment. */
  gifUrl?: string | null;
  /** When true, detaches (deletes) the current image attachment. */
  detachImage?: boolean;
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
