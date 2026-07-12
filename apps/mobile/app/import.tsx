import React, { useState } from 'react';
import { FlatList, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { Header } from '../components/Header';
import { Button, Card, Chip, EmptyState, Screen, Spinner, T } from '../components/primitives';
import {
  useCancelImport,
  useConfirmImport,
  useFeatureFlags,
  useImport,
  useImportItems,
  useUploadImport,
} from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { showError } from '../lib/dialog';
import { useTranslation } from 'react-i18next';

export default function ImportScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['import', 'common']);
  const [importId, setImportId] = useState<string | null>(null);
  const upload = useUploadImport();
  const importQ = useImport(importId ?? undefined);
  const itemsQ = useImportItems(importId ?? '', undefined, undefined);
  const flags = useFeatureFlags();
  const importsEnabled = flags.data?.imports_enabled ?? true;

  const STATUS_LABEL: Record<string, string> = {
    UPLOADED: t('import:status.uploaded'),
    QUEUED: t('import:status.queued'),
    EXTRACTING: t('import:status.extracting'),
    PARSING: t('import:status.parsing'),
    NORMALIZING: t('import:status.normalizing'),
    MATCHING: t('import:status.matching'),
    READY_FOR_REVIEW: t('import:status.ready'),
    IMPORTING: t('import:status.importing'),
    COMPLETED: t('import:status.completed'),
    FAILED: t('import:status.failed'),
    CANCELLED: t('import:status.cancelled'),
    ROLLED_BACK: t('import:status.rolledBack'),
  };

  const status = importQ.data?.status;
  const isProcessing = status && !['READY_FOR_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK'].includes(status);

  const pickFile = async () => {
    try {
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,.csv,.json';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          const fd = new FormData();
          fd.append('file', file);
          try {
            const r = await upload.mutateAsync(fd);
            setImportId(r.importId);
            importQ.refetch();
          } catch (e: any) {
            showError({ title: t('import:uploadFailed'), description: e?.message ?? t('import:couldNotUpload') });
          }
        };
        input.click();
        return;
      }

      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/zip', 'text/csv', 'application/json', 'application/x-zip-compressed'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const file = res.assets[0];
      const fd = new FormData();
      fd.append('file', { uri: file.uri, name: file.name, type: file.mimeType || 'application/octet-stream' } as any);
      const r = await upload.mutateAsync(fd);
      setImportId(r.importId);
      importQ.refetch();
    } catch (e: any) {
      showError({ title: t('import:uploadFailed'), description: e?.message ?? t('import:couldNotUpload') });
    }
  };

  const confirm = useConfirmImport();
  const cancel = useCancelImport();
  const qc = useQueryClient();

  if (!importId) {
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        {importsEnabled ? (
          <View style={{ padding: spacing.lg, gap: spacing.lg }}>
            <Card>
              <T variant="h2">{t('import:importFromTvTime')}</T>
              <T variant="caption" muted style={{ marginTop: spacing.sm }}>
                Upload the <T variant="caption" style={{ fontWeight: '700', color: tokens.primary }}>{t('import:zipFile')}</T> you received from TV Time's GDPR data export.
                {t('import:howItWorks')}
              </T>
              <Button title={t('import:selectZip')} icon="document-outline" onPress={pickFile} loading={upload.isPending} style={{ marginTop: spacing.md }} />
            </Card>
            <T variant="micro" muted>
              {t('import:limits')}
            </T>
          </View>
        ) : (
          <View style={{ padding: spacing.xl }}>
            <EmptyState title={t('import:disabledTitle')} subtitle={t('import:disabledDesc')} icon="cloud-offline-outline" />
          </View>
        )}
      </Screen>
    );
  }

  if (isProcessing) {
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl }}>
          <Spinner />
          <T variant="h2" style={{ marginTop: spacing.lg }}>{STATUS_LABEL[status] ?? t('import:processing')}</T>
          <T variant="caption" muted style={{ marginTop: spacing.sm, textAlign: 'center' }}>
            {t('import:matchingDesc')}
          </T>
          <Button title={t('import:cancel')} variant="ghost" onPress={() => cancel.mutate(importId)} style={{ marginTop: spacing.lg }} />
        </View>
      </Screen>
    );
  }

  if (status === 'FAILED') {
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        <EmptyState title={t('import:importFailed')} subtitle={importQ.data?.errorMessage ?? t('import:tryAgain')} icon="alert-circle-outline" cta={t('common:startOver')} onCta={() => setImportId(null)} />
      </Screen>
    );
  }

  if (status === 'COMPLETED') {
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        <View style={{ padding: spacing.lg, gap: spacing.lg }}>
          <Card>
            <T variant="h2">{t('import:importComplete')}</T>
            <T variant="body" style={{ marginTop: spacing.sm }}>{t('import:created', { value: confirm.data?.created ?? '—' })}</T>
            <T variant="body" muted>{t('import:skipped', { value: confirm.data?.skipped ?? '—' })}</T>
            <Button title={t('import:done')} onPress={() => {
              qc.invalidateQueries();
              setImportId(null);
            }} style={{ marginTop: spacing.md }} />
          </Card>
        </View>
      </Screen>
    );
  }

  // READY_FOR_REVIEW
  const imp = importQ.data;
  return (
    <Screen>
      <Header title={t('import:reviewImport')} showBack />
      <View style={styles.summary}>
        <Stat label={t('import:matched')} value={imp?.matchedCount} color={tokens.watched} />
        <Stat label={t('import:needsReview')} value={imp?.needsReviewCount} color={tokens.orange} />
        <Stat label={t('import:unmatched')} value={imp?.unmatchedCount} color={tokens.danger} />
        <Stat label={t('import:duplicates')} value={imp?.duplicateCount} color={tokens.textMuted} />
      </View>
      <ReviewItems importId={importId} tokens={tokens} />
      <View style={[styles.actions, { borderTopColor: tokens.divider }]}>
        <Button
          title={t('import:confirmImport')}
          variant="watched"
          icon="checkmark"
          loading={confirm.isPending}
          onPress={() =>
            confirm.mutate(importId, {
              onError: (e: any) => showError({ title: t('import:importFailed'), description: e?.message ?? t('common:tryAgain') }),
            })
          }
          style={{ flex: 1 }}
        />
        <Button title={t('import:cancel')} variant="ghost" onPress={() => cancel.mutate(importId)} style={{ marginLeft: spacing.sm }} />
      </View>
    </Screen>
  );
}

function Stat({ label, value, color }: { label: string; value?: number; color: string }) {
  return (
    <View style={styles.stat}>
      <T variant="title" style={{ color }}>{value ?? 0}</T>
      <T variant="micro" muted>{label}</T>
    </View>
  );
}

function ReviewItems({ importId, tokens }: { importId: string; tokens: ReturnType<typeof useAppearance>['tokens'] }) {
  const { t } = useTranslation(['import', 'common']);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [entityFilter, setEntityFilter] = useState<string | undefined>(undefined);
  const q = useImportItems(importId, statusFilter, entityFilter);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  const ENTITY_FILTERS: { key: string | undefined; label: string }[] = [
    { key: undefined, label: t('import:allTypes') },
    { key: 'WATCHLIST_SHOW', label: t('import:shows') },
    { key: 'WATCHLIST_MOVIE', label: t('import:movies') },
    { key: 'WATCHED_MOVIE', label: t('import:watchedMovies') },
    { key: 'WATCHED_EPISODE', label: t('import:episodes') },
  ];

  const FILTERS: { key: string | undefined; label: string }[] = [
    { key: undefined, label: t('import:filters.all') },
    { key: 'matched', label: t('import:filters.matched') },
    { key: 'needs_review', label: t('import:filters.needsReview') },
    { key: 'unmatched', label: t('import:filters.unmatched') },
    { key: 'duplicate', label: t('import:filters.duplicates') },
  ];

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ height: 40, justifyContent: 'center' }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.lg }}>
          {ENTITY_FILTERS.map((f) => (
            <Chip key={f.label} label={f.label} active={entityFilter === f.key} onPress={() => setEntityFilter(f.key)} />
          ))}
        </ScrollView>
      </View>
      <View style={{ height: 40, justifyContent: 'center', marginTop: 4 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.lg }}>
          {FILTERS.map((f) => (
            <Chip key={f.label} label={f.label} active={statusFilter === f.key} onPress={() => setStatusFilter(f.key)} />
          ))}
        </ScrollView>
      </View>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
        onEndReachedThreshold={0.4}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 120 }}
        renderItem={({ item }) => {
          const norm = item.normalizedData ?? {};
          return (
            <Card style={styles.row}>
              <View style={{ flex: 1 }}>
                <T variant="body" numberOfLines={1}>{norm.title ?? t('import:noTitle')}</T>
                <T variant="micro" muted>
                  {item.sourceEntityType.replace(/_/g, ' ').toLowerCase()}
                  {norm.season ? ` · S${norm.season}E${norm.episode ?? ''}` : ''}
                </T>
              </View>
              <T variant="micro" style={{ color: statusColor(item.status, tokens) }}>{item.status}</T>
            </Card>
          );
        }}
        ListFooterComponent={q.isFetchingNextPage ? <Spinner /> : null}
        ListEmptyComponent={
          q.isLoading ? <Spinner /> : <T variant="caption" muted style={{ padding: spacing.xl, textAlign: 'center' }}>{t('import:noItems')}</T>
        }
      />
    </View>
  );
}

function statusColor(s: string, tokens: ReturnType<typeof useAppearance>['tokens']): string {
  switch (s) {
    case 'MATCHED': return tokens.watched;
    case 'NEEDS_REVIEW': return tokens.orange;
    case 'UNMATCHED': return tokens.danger;
    case 'DUPLICATE': return tokens.textMuted;
    default: return tokens.textMuted;
  }
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', justifyContent: 'space-around', padding: spacing.md },
  stat: { alignItems: 'center' },
  actions: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderTopWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
});