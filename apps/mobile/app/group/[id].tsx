import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { isCommunityGroupId } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { CommentsFeed } from '../../components/comments/CommentsFeed';
import { EmptyState, Screen } from '../../components/primitives';

export default function GroupScreen() {
  const { t } = useTranslation(['groups']);
  const { id } = useLocalSearchParams<{ id: string }>();

  if (!id || !isCommunityGroupId(id)) {
    return (
      <Screen>
        <Header title={t('groups:title')} showBack />
        <EmptyState title={t('groups:notFound')} icon="people-outline" />
      </Screen>
    );
  }

  return <CommentsFeed threadType="GROUP" threadId={id} title={t(`groups:names.${id}`)} />;
}
