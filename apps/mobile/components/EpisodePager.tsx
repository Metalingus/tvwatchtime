import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, FlatList, Platform, View } from 'react-native';
import { EpisodeDetailContent } from './EpisodeDetailContent';

/**
 * Horizontal pager of episode details within a season.
 * - Native: pagingEnabled FlatList (swipe); arrows live inside each page so they move
 *   with the content. Arrow taps animate the scroll via scrollToIndex.
 * - Web: single current detail + arrows that change currentIndex.
 *
 * NOTE: we intentionally do NOT call router.replace/setParams during paging. Replacing a
 * dynamic [id] route remounts the whole screen (causing a flicker/jump on every swipe and
 * arrow press). Paging is purely local state; the URL stays at the entry episode.
 */
export function EpisodePager({
  episodeIds,
  initialId,
}: {
  episodeIds: string[];
  initialId: string;
}) {
  const isWeb = Platform.OS === 'web';
  const listRef = useRef<FlatList<string>>(null);

  const initialIndex = useMemo(() => {
    const idx = episodeIds.indexOf(initialId);
    return idx >= 0 ? idx : 0;
  }, [episodeIds, initialId]);

  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [pageWidth, setPageWidth] = useState(Dimensions.get('window').width);

  // Re-align pages on native rotation/resize.
  useEffect(() => {
    if (isWeb) return;
    const handler = ({ window }: { window: { width: number; height: number } }) => {
      setPageWidth(window.width);
      requestAnimationFrame(() => listRef.current?.scrollToIndex({ index: currentIndex, animated: false }));
    };
    const sub = Dimensions.addEventListener('change', handler as any);
    return () => sub?.remove();
  }, [currentIndex, isWeb]);

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= episodeIds.length) return;
      if (!isWeb) {
        // Smoothly scroll to the target page. currentIndex is updated when the scroll
        // settles (onMomentumScrollEnd) so we never re-render mid-animation.
        listRef.current?.scrollToIndex({ index, animated: true });
        return;
      }
      setCurrentIndex(index);
    },
    [episodeIds.length, isWeb],
  );

  const onMomentumScrollEnd = useCallback(
    (e: { nativeEvent: { contentOffset: { x: number } } }) => {
      const index = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
      setCurrentIndex((prev) => (prev === index ? prev : index));
    },
    [pageWidth],
  );

  if (isWeb) {
    return (
      <View style={{ flex: 1 }}>
        <EpisodeDetailContent
          episodeId={episodeIds[currentIndex]}
          onPrev={currentIndex > 0 ? () => setCurrentIndex(currentIndex - 1) : undefined}
          onNext={currentIndex < episodeIds.length - 1 ? () => setCurrentIndex(currentIndex + 1) : undefined}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={listRef}
        data={episodeIds}
        keyExtractor={(id) => id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={initialIndex}
        getItemLayout={(_, index) => ({ length: pageWidth, offset: pageWidth * index, index })}
        onScrollToIndexFailed={({ index, highestMeasuredFrameIndex }) => {
          listRef.current?.scrollToIndex({ index: Math.min(index, highestMeasuredFrameIndex), animated: false });
          setTimeout(() => listRef.current?.scrollToIndex({ index, animated: false }), 60);
        }}
        onMomentumScrollEnd={onMomentumScrollEnd}
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        windowSize={5}
        renderItem={({ item, index }) => (
          <View style={{ width: pageWidth, flex: 1 }}>
            <EpisodeDetailContent
              episodeId={item}
              onPrev={index > 0 ? () => goTo(index - 1) : undefined}
              onNext={index < episodeIds.length - 1 ? () => goTo(index + 1) : undefined}
            />
          </View>
        )}
      />
    </View>
  );
}
