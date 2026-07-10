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
import { colors, radius, spacing } from '../theme/theme';
import { showError } from '../lib/dialog';

const STATUS_LABEL: Record<string, string> = {
  UPLOADED: 'Uploaded',
  QUEUED: 'Queued',
  EXTRACTING: 'Extracting archive…',
  PARSING: 'Parsing files…',
  NORMALIZING: 'Normalizing rows…',
  MATCHING: 'Matching shows & movies…',
  READY_FOR_REVIEW: 'Ready for review',
  IMPORTING: 'Importing…',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  ROLLED_BACK: 'Rolled back',
};

const FILTERS: { key: string | undefined; label: string }[] = [
  { key: undefined, label: 'All' },
  { key: 'matched', label: 'Matched' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'unmatched', label: 'Unmatched' },
  { key: 'duplicate', label: 'Duplicates' },
];

export default function ImportScreen() {
  const [importId, setImportId] = useState<string | null>(null);
  const upload = useUploadImport();
  const importQ = useImport(importId ?? undefined);
  const itemsQ = useImportItems(importId ?? '', undefined, undefined);
  const flags = useFeatureFlags();
  const importsEnabled = flags.data?.imports_enabled ?? true;

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
            showError({ title: 'Upload failed', description: e?.message ?? 'Could not upload the file' });
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
      showError({ title: 'Upload failed', description: e?.message ?? 'Could not upload the file' });
    }
  };

  const confirm = useConfirmImport();
  const cancel = useCancelImport();
  const qc = useQueryClient();

  if (!importId) {
    return (
      <Screen>
        <Header title="Import" showBack />
        {importsEnabled ? (
          <View style={{ padding: spacing.lg, gap: spacing.lg }}>
            <Card>
              <T variant="h2">Import from TV Time</T>
              <T variant="caption" muted style={{ marginTop: spacing.sm }}>
                Upload the <T variant="caption" style={{ fontWeight: '700', color: colors.primary }}>.zip file</T> you received from TV Time's GDPR data export.
                We'll match your watched episodes, watchlist, and favorites by title, show you a preview, then import after you confirm.
              </T>
              <Button title="Select .zip file" icon="document-outline" onPress={pickFile} loading={upload.isPending} style={{ marginTop: spacing.md }} />
            </Card>
            <T variant="micro" muted>
              Limits: 25 MB · zip must contain only CSV files · 3 imports/day. Comments, ratings, reactions and badges are
              not imported.
            </T>
          </View>
        ) : (
          <View style={{ padding: spacing.xl }}>
            <EmptyState title="Imports are temporarily disabled" subtitle="Please check back later." icon="cloud-offline-outline" />
          </View>
        )}
      </Screen>
    );
  }

  if (isProcessing) {
    return (
      <Screen>
        <Header title="Import" showBack />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl }}>
          <Spinner />
          <T variant="h2" style={{ marginTop: spacing.lg }}>{STATUS_LABEL[status] ?? 'Processing…'}</T>
          <T variant="caption" muted style={{ marginTop: spacing.sm, textAlign: 'center' }}>
            Matching your library. Large imports hydrate each show from TMDb (throttled), so this can take a few minutes.
          </T>
          <Button title="Cancel" variant="ghost" onPress={() => cancel.mutate(importId)} style={{ marginTop: spacing.lg }} />
        </View>
      </Screen>
    );
  }

  if (status === 'FAILED') {
    return (
      <Screen>
        <Header title="Import" showBack />
        <EmptyState title="Import failed" subtitle={importQ.data?.errorMessage ?? 'Please try again.'} icon="alert-circle-outline" cta="Start over" onCta={() => setImportId(null)} />
      </Screen>
    );
  }

  if (status === 'COMPLETED') {
    return (
      <Screen>
        <Header title="Import" showBack />
        <View style={{ padding: spacing.lg, gap: spacing.lg }}>
          <Card>
            <T variant="h2">Import complete</T>
            <T variant="body" style={{ marginTop: spacing.sm }}>Created: {confirm.data?.created ?? '—'}</T>
            <T variant="body" muted>Skipped (already existed): {confirm.data?.skipped ?? '—'}</T>
            <Button title="Done" onPress={() => {
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
      <Header title="Review import" showBack />
      <View style={styles.summary}>
        <Stat label="Matched" value={imp?.matchedCount} color={colors.watched} />
        <Stat label="Needs review" value={imp?.needsReviewCount} color={colors.orange} />
        <Stat label="Unmatched" value={imp?.unmatchedCount} color={colors.danger} />
        <Stat label="Duplicates" value={imp?.duplicateCount} color={colors.textMuted} />
      </View>
      <ReviewItems importId={importId} />
      <View style={styles.actions}>
        <Button
          title="Confirm import"
          variant="watched"
          icon="checkmark"
          loading={confirm.isPending}
          onPress={() =>
            confirm.mutate(importId, {
              onError: (e: any) => showError({ title: 'Import failed', description: e?.message ?? 'try again' }),
            })
          }
          style={{ flex: 1 }}
        />
        <Button title="Cancel" variant="ghost" onPress={() => cancel.mutate(importId)} style={{ marginLeft: spacing.sm }} />
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

const ENTITY_FILTERS: { key: string | undefined; label: string }[] = [
  { key: undefined, label: 'All types' },
  { key: 'WATCHLIST_SHOW', label: 'Shows' },
  { key: 'WATCHLIST_MOVIE', label: 'Movies' },
  { key: 'WATCHED_MOVIE', label: 'Watched movies' },
  { key: 'WATCHED_EPISODE', label: 'Episodes' },
];

function ReviewItems({ importId }: { importId: string }) {
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [entityFilter, setEntityFilter] = useState<string | undefined>(undefined);
  const q = useImportItems(importId, statusFilter, entityFilter);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

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
                <T variant="body" numberOfLines={1}>{norm.title ?? '(no title)'}</T>
                <T variant="micro" muted>
                  {item.sourceEntityType.replace(/_/g, ' ').toLowerCase()}
                  {norm.season ? ` · S${norm.season}E${norm.episode ?? ''}` : ''}
                </T>
              </View>
              <T variant="micro" style={{ color: statusColor(item.status) }}>{item.status}</T>
            </Card>
          );
        }}
        ListFooterComponent={q.isFetchingNextPage ? <Spinner /> : null}
        ListEmptyComponent={
          q.isLoading ? <Spinner /> : <T variant="caption" muted style={{ padding: spacing.xl, textAlign: 'center' }}>No items in this view.</T>
        }
      />
    </View>
  );
}

function statusColor(s: string): string {
  switch (s) {
    case 'MATCHED': return colors.watched;
    case 'NEEDS_REVIEW': return colors.orange;
    case 'UNMATCHED': return colors.danger;
    case 'DUPLICATE': return colors.textMuted;
    default: return colors.textMuted;
  }
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', justifyContent: 'space-around', padding: spacing.md },
  stat: { alignItems: 'center' },
  actions: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderTopColor: colors.border, borderTopWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
});
