import { useMemo, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import type {
  ExternalIdDto,
  ProviderOfferType,
  WatchProviderDto,
  WatchProvidersBlockDto,
} from '@tvwatch/shared';
import { Button, PosterImage, T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import {
  useIntegrationOpenTargets,
  useIntegrations,
  useProviderAlerts,
  useProviderCatalog,
  useRemoveProviderAlert,
  useSaveProviderAlert,
} from '../api/hooks';
import { showToast } from '../lib/toast';
import { IntegrationIcon, type IntegrationBrand } from './IntegrationIcon';

function ProviderTile({ p }: { p: WatchProviderDto }) {
  return (
    <View style={{ alignItems: 'center', width: 64, marginRight: spacing.sm }}>
      <PosterImage uri={p.logoUrl} style={{ width: 44, height: 44, borderRadius: radius.sm }} />
      <T variant="micro" muted style={{ textAlign: 'center', marginTop: 2 }} numberOfLines={2}>
        {p.name}
      </T>
    </View>
  );
}
export interface StremioTarget {
  mediaType: 'movie' | 'series';
  title: string;
  externalIds?: ExternalIdDto[];
  season?: number;
  episode?: number;
}

function stremioDeepLink(target?: StremioTarget): string | null {
  if (!target) return null;
  const imdb = target.externalIds?.find((externalId) => externalId.provider === 'IMDB')?.id;
  if (!imdb) return `stremio:///search?search=${encodeURIComponent(target.title)}`;
  if (target.mediaType === 'movie') return `stremio:///detail/movie/${imdb}/${imdb}`;
  if (target.season && target.episode) {
    return `stremio:///detail/series/${imdb}/${imdb}:${target.season}:${target.episode}`;
  }
  return `stremio:///detail/series/${imdb}`;
}

function OpenInTile({
  provider,
  name,
  url,
  fallbackUrl,
}: {
  provider: IntegrationBrand;
  name: string;
  url: string;
  fallbackUrl?: string;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation('common');
  const open = () =>
    Linking.openURL(url).catch(() =>
      fallbackUrl ? Linking.openURL(fallbackUrl) : Promise.resolve(),
    );
  return (
    <Pressable
      onPress={open}
      accessibilityRole="link"
      accessibilityLabel={`${t('providersOpenIn')} ${name}`}
      style={{ alignItems: 'center', width: 64, marginRight: spacing.sm }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens.surfaceElevated,
          borderWidth: 1,
          borderColor: tokens.border,
        }}
      >
        <IntegrationIcon provider={provider} size={24} />
      </View>
      <T variant="micro" muted style={{ textAlign: 'center', marginTop: 2 }} numberOfLines={2}>
        {name}
      </T>
    </Pressable>
  );
}

interface AlertRowProps {
  label: string;
  providers: WatchProviderDto[];
  subscribed: boolean;
  onBell?: () => void;
}

function OfferRow({ label, providers, subscribed, onBell }: AlertRowProps) {
  const { tokens } = useAppearance();
  return (
    <View style={{ marginTop: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
        <T variant="caption" muted>
          {label}:
        </T>
        {onBell ? (
          <Pressable hitSlop={10} onPress={onBell}>
            <Ionicons
              name={subscribed ? 'notifications' : 'notifications-outline'}
              size={16}
              color={subscribed ? tokens.primary : tokens.textMuted}
            />
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginTop: spacing.xs }}
      >
        {providers.map((p) => (
          <ProviderTile key={p.id} p={p} />
        ))}
      </ScrollView>
    </View>
  );
}

/** Compact "bell + label" chip — subscribes to an offer type that has no offers yet. */
function NotifyChip({
  label,
  subscribed,
  onPress,
}: {
  label: string;
  subscribed: boolean;
  onPress: () => void;
}) {
  const { tokens } = useAppearance();
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: subscribed ? tokens.primary : tokens.border,
        marginRight: spacing.sm,
      }}
    >
      <Ionicons
        name={subscribed ? 'notifications' : 'notifications-outline'}
        size={13}
        color={subscribed ? tokens.primary : tokens.textMuted}
      />
      <T variant="micro" muted={!subscribed} style={subscribed ? { color: tokens.primary } : null}>
        {label}
      </T>
    </Pressable>
  );
}

/** Multi-select provider picker for one offer-type alert. */
function ProviderPickerDialog({
  visible,
  offerLabel,
  mediaId,
  offerType,
  country,
  initialIds,
  hadAlert,
  onClose,
}: {
  visible: boolean;
  offerLabel: string;
  mediaId: string;
  offerType: ProviderOfferType;
  country?: string;
  initialIds: number[];
  hadAlert: boolean;
  onClose: () => void;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation('common');
  const catalog = useProviderCatalog(country);
  const save = useSaveProviderAlert();
  const remove = useRemoveProviderAlert();
  const [all, setAll] = useState(initialIds.length === 0);
  const [selected, setSelected] = useState<Set<number>>(new Set(initialIds));

  const toggle = (id: number) => {
    setAll(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = () => {
    const providerIds = all ? [] : [...selected];
    save.mutate(
      { mediaId, offerType, providerIds, country },
      {
        onSuccess: () => {
          showToast(t('providersNotifySet'));
          onClose();
        },
      },
    );
  };

  const removeAlert = () => {
    remove.mutate(
      { mediaId, offerType },
      {
        onSuccess: () => {
          showToast(t('providersNotifyRemoved'));
          onClose();
        },
      },
    );
  };

  const providers = catalog.data ?? [];
  const chipStyle = (active: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: active ? tokens.primary : tokens.border,
    backgroundColor: active ? tokens.surfaceElevated : 'transparent',
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
  });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: tokens.overlay,
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
        }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: tokens.surface,
            borderRadius: radius.lg,
            padding: spacing.lg,
            width: '100%',
            maxWidth: 420,
            maxHeight: '80%',
          }}
        >
          <T variant="h2">
            {t('providersNotifyTitle')} — {offerLabel}
          </T>
          <T variant="caption" muted style={{ marginTop: spacing.xs, marginBottom: spacing.md }}>
            {t('providersNotifyDesc')}
          </T>
          <ScrollView>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              <Pressable onPress={() => setAll(true)} style={chipStyle(all)}>
                <Ionicons
                  name={all ? 'checkmark-circle' : 'ellipse-outline'}
                  size={18}
                  color={all ? tokens.primary : tokens.textMuted}
                />
                <T variant="caption">{t('providersAll')}</T>
              </Pressable>
              {providers.map((p) => {
                const active = !all && selected.has(p.id);
                return (
                  <Pressable key={p.id} onPress={() => toggle(p.id)} style={chipStyle(active)}>
                    <PosterImage
                      uri={p.logoUrl}
                      style={{ width: 20, height: 20, borderRadius: 4 }}
                    />
                    <T variant="caption">{p.name}</T>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              gap: spacing.sm,
              marginTop: spacing.md,
            }}
          >
            {hadAlert ? (
              <Button
                title={t('providersRemove')}
                variant="ghost"
                onPress={removeAlert}
                loading={remove.isPending}
              />
            ) : null}
            <Button title={t('cancel')} variant="ghost" onPress={onClose} />
            <Button
              title={t('save')}
              onPress={confirm}
              loading={save.isPending}
              disabled={!all && selected.size === 0}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Stream/Rent/Buy offer rows for the request-locale country — only sections that
 *  actually have offers render, each with a bell for availability alerts. Sections
 *  without offers collapse into one compact "notify when available" chip row, so
 *  future availability stays subscribable without dangling empty labels.
 *  The JustWatch attribution (required by TMDB terms) shows only when offer data
 *  is actually displayed. */
export function WhereToWatch({
  watchProviders,
  legacyProviders,
  emptyLabel,
  mediaId,
  stremioTarget,
}: {
  watchProviders?: WatchProvidersBlockDto | null;
  legacyProviders?: WatchProviderDto[];
  emptyLabel: string;
  mediaId?: string;
  stremioTarget?: StremioTarget;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation('common');
  const alertsQuery = useProviderAlerts(mediaId ?? '');
  const integrationsQuery = useIntegrations();
  const openTargetsQuery = useIntegrationOpenTargets(mediaId ?? '');
  const stremioConnected =
    integrationsQuery.data?.some(
      (integration) => integration.provider === 'STREMIO' && integration.connected,
    ) ?? false;
  const openInStremio = stremioConnected ? stremioDeepLink(stremioTarget) : null;
  const jellyfinTarget = openTargetsQuery.data?.find((target) => target.provider === 'JELLYFIN');
  const hasOpenTargets = Boolean(openInStremio || jellyfinTarget);
  const [pickerFor, setPickerFor] = useState<ProviderOfferType | null>(null);
  const stream = watchProviders?.stream ?? [];
  const rent = watchProviders?.rent ?? [];
  const buy = watchProviders?.buy ?? [];
  const hasOffers = stream.length > 0 || rent.length > 0 || buy.length > 0;
  const legacy = !hasOffers && !watchProviders ? (legacyProviders ?? []) : [];

  const alerts = mediaId ? (alertsQuery.data ?? []) : [];
  const alertByType = useMemo(() => {
    const map = new Map<ProviderOfferType, { providerIds: number[]; active: boolean }>();
    for (const a of alerts) map.set(a.offerType, { providerIds: a.providerIds, active: a.active });
    return map;
  }, [alerts]);

  const rows: { type: ProviderOfferType; label: string; providers: WatchProviderDto[] }[] = [
    { type: 'STREAM', label: t('providersStream'), providers: stream },
    { type: 'RENT', label: t('providersRent'), providers: rent },
    { type: 'BUY', label: t('providersBuy'), providers: buy },
  ];
  const withOffers = rows.filter((r) => r.providers.length > 0);
  const withoutOffers = rows.filter((r) => r.providers.length === 0);
  const showData = hasOffers || legacy.length > 0;

  if (!showData && !mediaId && !hasOpenTargets) {
    return (
      <T variant="caption" muted>
        {emptyLabel}
      </T>
    );
  }
  return (
    <View>
      {hasOpenTargets ? (
        <View style={{ marginTop: spacing.sm }}>
          <T variant="caption" muted>
            {t('providersOpenIn')}:
          </T>
          <View style={{ flexDirection: 'row', marginTop: spacing.xs }}>
            {openInStremio && stremioTarget ? (
              <OpenInTile
                provider="STREMIO"
                name={'Stremio'}
                url={openInStremio}
                fallbackUrl={`https://web.stremio.com/#/search?search=${encodeURIComponent(
                  stremioTarget.title,
                )}`}
              />
            ) : null}
            {jellyfinTarget ? (
              <OpenInTile provider="JELLYFIN" name={jellyfinTarget.name} url={jellyfinTarget.url} />
            ) : null}
          </View>
        </View>
      ) : null}
      {withOffers.map((row) => (
        <OfferRow
          key={row.type}
          label={row.label}
          providers={row.providers}
          subscribed={alertByType.get(row.type)?.active ?? false}
          onBell={mediaId ? () => setPickerFor(row.type) : undefined}
        />
      ))}
      {!hasOffers && legacy.length > 0 ? (
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm }}
        >
          {legacy.map((p) => (
            <ProviderTile key={p.id} p={p} />
          ))}
        </View>
      ) : null}
      {!showData && !hasOpenTargets ? (
        <T variant="caption" muted style={{ marginTop: spacing.sm }}>
          {emptyLabel}
        </T>
      ) : null}
      {/* Empty sections collapse into one compact subscribe row. */}
      {mediaId && withoutOffers.length > 0 ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            marginTop: spacing.sm,
            rowGap: spacing.xs,
          }}
        >
          <T variant="micro" muted style={{ marginRight: spacing.sm }}>
            {t('providersNotifyWhenAvailable')}
          </T>
          {withoutOffers.map((row) => (
            <NotifyChip
              key={row.type}
              label={row.label}
              subscribed={alertByType.get(row.type)?.active ?? false}
              onPress={() => setPickerFor(row.type)}
            />
          ))}
        </View>
      ) : null}
      {/* JustWatch attribution — TMDB API terms require it wherever offers display;
          nothing sourced is shown when the list is empty, so no attribution then. */}
      {showData ? (
        <Pressable
          onPress={() => Linking.openURL(watchProviders?.link ?? 'https://www.justwatch.com')}
          style={{ marginTop: spacing.sm }}
        >
          <T variant="micro" style={{ color: tokens.textMuted, fontStyle: 'italic' }}>
            {t('providersAttribution')}
          </T>
        </Pressable>
      ) : null}
      {mediaId && pickerFor ? (
        <ProviderPickerDialog
          visible
          offerLabel={rows.find((r) => r.type === pickerFor)?.label ?? ''}
          mediaId={mediaId}
          offerType={pickerFor}
          country={watchProviders?.country}
          initialIds={alertByType.get(pickerFor)?.providerIds ?? []}
          hadAlert={alertByType.has(pickerFor)}
          onClose={() => setPickerFor(null)}
        />
      ) : null}
    </View>
  );
}
