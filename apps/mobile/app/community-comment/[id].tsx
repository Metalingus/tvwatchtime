import React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';

/** Compatibility for existing notification/deep links; all rendering lives in /comment/[id]. */
export default function LegacyCommunityCommentLink() {
  const params = useLocalSearchParams<{ id: string; threadType: string; threadId: string }>();
  return (
    <Redirect
      href={{
        pathname: '/comment/[id]',
        params: {
          id: params.id,
          source: 'commsuni',
          threadType: params.threadType,
          threadId: params.threadId,
        },
      }}
    />
  );
}
