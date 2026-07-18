import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { CommentsFeed } from '../components/comments/CommentsFeed';

export default function CommentsScreen() {
  const { t } = useTranslation(['comments']);
  const params = useLocalSearchParams<{ type: string; threadId: string }>();

  return <CommentsFeed threadType={params.type} threadId={params.threadId} title={t('comments:title')} />;
}
