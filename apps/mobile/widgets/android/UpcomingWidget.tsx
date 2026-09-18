import { formatBroadcastTime } from '../../lib/format';
import React from 'react';
import { FlexWidget, TextWidget, ImageWidget, ListWidget } from 'react-native-android-widget';
import type { Tokens, UpcomingGroupDto, UpcomingItemDto } from '@tvwatch/shared';
import {
  EPISODE_URI,
  SHOWS_URI,
  episodeCode,
  shortAirDate,
  upcomingGroupTitle,
  upcomingEpisodeLabel,
  widgetImage,
  type WidgetLabels,
  type WidgetFetchState,
} from '../data';

const hex = (c: string) => c as `#${string}`;
const img = (u: string) => u as React.ComponentProps<typeof ImageWidget>['image'];

const ROW_H = 68;
const ROW_GAP = 6;
const GROUP_H = 22;
const SECTION_GAP = 8;
const HEADER_H = 26;
const PAD = 12;
const LIST_TOP_GAP = 6;
const MAX_PER_GROUP = 5;

interface Props {
  state: WidgetFetchState<UpcomingGroupDto[]>;
  labels: WidgetLabels;
  tokens: Tokens;
  height: number;
  images: ReadonlyMap<string, string>;
}

function UpcomingRow({
  item,
  labels,
  tokens,
  images,
}: {
  item: UpcomingItemDto;
  labels: WidgetLabels;
  tokens: Tokens;
  images: ReadonlyMap<string, string>;
}) {
  const dateLabel = shortAirDate(item.airDate, !!item.airTime);
  const remotePoster = widgetImage(item.posterUrl, 'w185');
  const poster = remotePoster ? images.get(remotePoster) : undefined;
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: EPISODE_URI(item.id) }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: hex(tokens.surface),
        borderRadius: 12,
        padding: 6,
        height: ROW_H,
        width: 'match_parent',
      }}
    >
      {poster ? (
        <ImageWidget
          image={img(poster)}
          imageWidth={37}
          imageHeight={56}
          radius={6}
          resizeMode="cover"
          style={{ width: 37, height: 56, marginRight: 10 }}
        />
      ) : null}
      <FlexWidget style={{ flexDirection: 'column', flex: 1 }}>
        <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent' }}>
          <FlexWidget style={{ flex: 1 }}>
            <TextWidget
              text={item.title}
              truncate="END"
              maxLines={1}
              style={{ color: hex(tokens.textPrimary), fontSize: 12, fontWeight: '700' }}
            />
          </FlexWidget>
          {item.label ? (
            <TextWidget
              text={upcomingEpisodeLabel(item.label, labels)}
              style={{
                color: hex(tokens.primaryForeground),
                fontSize: 8,
                fontWeight: '700',
                backgroundColor: hex(tokens.primary),
                borderRadius: 6,
                paddingHorizontal: 5,
                paddingVertical: 1,
                marginLeft: 6,
              }}
            />
          ) : null}
        </FlexWidget>
        <TextWidget
          text={`${episodeCode(item.seasonNumber, item.episodeNumber)} · ${item.episodeTitle ?? ''}`}
          truncate="END"
          maxLines={1}
          style={{ color: hex(tokens.textMuted), fontSize: 10, fontWeight: '500', marginTop: 2 }}
        />
        <FlexWidget
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            marginTop: 2,
            width: 'match_parent',
          }}
        >
          <FlexWidget style={{ flex: 1 }}>
            <TextWidget
              text={`${dateLabel}${item.airTime ? ` · ${formatBroadcastTime(item.airDate)}` : ''}`}
              truncate="END"
              maxLines={1}
              style={{ color: hex(tokens.textMuted), fontSize: 10 }}
            />
          </FlexWidget>
          {item.network ? (
            <TextWidget
              text={item.network}
              maxLines={1}
              style={{ color: hex(tokens.primary), fontSize: 9, fontWeight: '700', marginLeft: 6 }}
            />
          ) : null}
        </FlexWidget>
      </FlexWidget>
    </FlexWidget>
  );
}

type FlatRow =
  | { type: 'header'; key: string; title: string }
  | { type: 'item'; key: string; item: UpcomingItemDto };

export function UpcomingWidget({ state, labels, tokens, height, images }: Props) {
  // Full near-term content (scrollable); section headers interleave with their rows.
  const rows: FlatRow[] = [];
  if (state.status === 'ok') {
    for (const g of state.data) {
      rows.push({
        type: 'header',
        key: `h_${g.key}`,
        title: upcomingGroupTitle(g.key, labels, g.label),
      });
      for (const it of g.items.slice(0, MAX_PER_GROUP))
        rows.push({ type: 'item', key: `c_${it.id}`, item: it });
    }
  }

  const listHeight = height - PAD * 2 - HEADER_H - LIST_TOP_GAP;
  // ListWidget items must not exceed the list height — fall back to a
  // height-budgeted column when the widget is resized too short.
  const useList = listHeight >= ROW_H + ROW_GAP;
  let budget = listHeight;
  const fallbackRows: FlatRow[] = [];
  if (!useList) {
    for (const r of rows) {
      const cost = r.type === 'header' ? GROUP_H : ROW_H + ROW_GAP;
      if (budget < cost) break;
      fallbackRows.push(r);
      budget -= cost;
    }
  }

  return (
    <FlexWidget
      style={{
        flexDirection: 'column',
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: hex(tokens.background),
        padding: PAD,
      }}
    >
      <FlexWidget
        clickAction="OPEN_URI"
        clickActionData={{ uri: SHOWS_URI }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          height: HEADER_H,
          width: 'match_parent',
        }}
      >
        <FlexWidget style={{ flex: 1 }}>
          <TextWidget
            text={labels.upcoming}
            style={{ color: hex(tokens.textPrimary), fontSize: 14, fontWeight: '700' }}
          />
        </FlexWidget>
        <TextWidget
          text="↻"
          clickAction="REFRESH"
          accessibilityLabel="Refresh"
          style={{ color: hex(tokens.textMuted), fontSize: 16, marginLeft: 8 }}
        />
      </FlexWidget>

      {rows.length > 0 ? (
        useList ? (
          <ListWidget
            style={{ width: 'match_parent', height: listHeight, marginTop: LIST_TOP_GAP }}
          >
            {rows.map((r, i) =>
              r.type === 'header' ? (
                <FlexWidget
                  key={r.key}
                  style={{
                    height: GROUP_H + (i === 0 ? 0 : SECTION_GAP),
                    paddingTop: i === 0 ? 0 : SECTION_GAP,
                    justifyContent: 'flex-end',
                    width: 'match_parent',
                  }}
                >
                  <TextWidget
                    text={r.title.toUpperCase()}
                    style={{
                      color: hex(tokens.textMuted),
                      fontSize: 10,
                      fontWeight: '700',
                      letterSpacing: 1,
                    }}
                  />
                </FlexWidget>
              ) : (
                <FlexWidget key={r.key} style={{ height: ROW_H + ROW_GAP, width: 'match_parent' }}>
                  <UpcomingRow item={r.item} labels={labels} tokens={tokens} images={images} />
                </FlexWidget>
              ),
            )}
          </ListWidget>
        ) : (
          fallbackRows.map((r, i) =>
            r.type === 'header' ? (
              <FlexWidget
                key={r.key}
                style={{
                  height: GROUP_H + (i === 0 ? 0 : SECTION_GAP),
                  paddingTop: i === 0 ? 0 : SECTION_GAP,
                  justifyContent: 'flex-end',
                  width: 'match_parent',
                }}
              >
                <TextWidget
                  text={r.title.toUpperCase()}
                  style={{
                    color: hex(tokens.textMuted),
                    fontSize: 10,
                    fontWeight: '700',
                    letterSpacing: 1,
                  }}
                />
              </FlexWidget>
            ) : (
              <FlexWidget key={r.key} style={{ marginTop: ROW_GAP, width: 'match_parent' }}>
                <UpcomingRow item={r.item} labels={labels} tokens={tokens} images={images} />
              </FlexWidget>
            ),
          )
        )
      ) : (
        <FlexWidget
          clickAction={state.status === 'auth' ? 'OPEN_APP' : 'OPEN_URI'}
          clickActionData={state.status === 'auth' ? undefined : { uri: SHOWS_URI }}
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', width: 'match_parent' }}
        >
          <TextWidget
            text={state.status === 'auth' ? labels.signIn : labels.emptyUpcoming}
            style={{
              color: hex(state.status === 'auth' ? tokens.primary : tokens.textMuted),
              fontSize: 12,
              fontWeight: '500',
            }}
          />
        </FlexWidget>
      )}
    </FlexWidget>
  );
}
