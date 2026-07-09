import React, { useState, useCallback } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../components/Header';
import { Button, Card, Screen, T } from '../components/primitives';
import { TextField } from '../components/TextField';
import { PosterImage } from '../components/primitives';
import { useCreateList, useMyLists, useAddListItem } from '../api/hooks';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { colors, spacing } from '../theme/theme';

export default function CreateListScreen() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const create = useCreateList();
  const addItem = useAddListItem();

  const search = useQuery({
    queryKey: ['search', 'list-create', searchQuery],
    queryFn: () => api.get<{ items: any[] }>('/search', { q: searchQuery, pageSize: 20 }),
    enabled: searchQuery.length >= 2,
  });

  const toggleSelect = (mediaId: string) => {
    setSelectedIds((prev) => prev.includes(mediaId) ? prev.filter(id => id !== mediaId) : [...prev, mediaId]);
  };

  const submit = async () => {
    if (!title.trim()) { Alert.alert('Title required'); return; }
    try {
      const result = await create.mutateAsync({
        title: title.trim(),
        description: description.trim() || undefined,
        visibility: isPublic ? 'PUBLIC' : 'PRIVATE',
        items: selectedIds,
      });
      router.replace(`/list/${result.id}`);
    } catch (e: any) {
      Alert.alert('Failed', e?.message ?? 'Try again');
    }
  };

  const selectedItems = (search.data?.items ?? []).filter(i => selectedIds.includes(i.id));

  return (
    <Screen>
      <Header title="Create List" showBack />
      <View style={{ padding: spacing.lg }}>
        <TextField label="Title" value={title} onChangeText={setTitle} placeholder="My favorite shows" />
        <TextField label="Description (optional)" value={description} onChangeText={setDescription} placeholder="A collection of..." />

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md }}>
          <T variant="caption" muted>Visibility</T>
          <Pressable onPress={() => setIsPublic(!isPublic)} style={{ flexDirection: 'row', alignItems: 'center' }}>
            <T variant="caption" style={{ marginRight: 8 }}>{isPublic ? 'Public' : 'Private'}</T>
            <View style={[styles.toggle, isPublic && { backgroundColor: colors.primary }]}>
              <View style={[styles.toggleKnob, isPublic && { transform: [{ translateX: 18 }] }]} />
            </View>
          </Pressable>
        </View>

        <TextField label="Add items" value={searchQuery} onChangeText={setSearchQuery} placeholder="Search shows and movies..." autoCapitalize="none" />

        {selectedIds.length > 0 ? (
          <View style={{ marginBottom: spacing.sm }}>
            <T variant="caption" muted style={{ marginBottom: 4 }}>{selectedIds.length} selected</T>
            <FlatList
              horizontal
              data={selectedItems}
              keyExtractor={(i) => i.id}
              renderItem={({ item }) => (
                <View style={{ marginRight: spacing.sm }}>
                  <PosterImage uri={item.posterUrl} style={{ width: 60, height: 90, borderRadius: 6 }} />
                  <Pressable onPress={() => toggleSelect(item.id)} style={{ position: 'absolute', top: -4, right: -4, backgroundColor: colors.danger, borderRadius: 10, width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="close" size={14} color="#fff" />
                  </Pressable>
                </View>
              )}
            />
          </View>
        ) : null}

        {search.data?.items ? (
          <FlatList
            data={search.data.items.filter(i => !selectedIds.includes(i.id))}
            keyExtractor={(i) => i.id}
            style={{ maxHeight: 300 }}
            renderItem={({ item }) => (
              <Pressable onPress={() => toggleSelect(item.id)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, borderBottomColor: colors.border, borderBottomWidth: 1 }}>
                <PosterImage uri={item.posterUrl} style={{ width: 40, height: 60, borderRadius: 4 }} />
                <View style={{ flex: 1, marginLeft: spacing.sm }}>
                  <T variant="caption" numberOfLines={1}>{item.title}</T>
                  <T variant="micro" muted>{item.type}</T>
                </View>
                <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
              </Pressable>
            )}
          />
        ) : null}

        <Button title="Create list" onPress={submit} loading={create.isPending} icon="checkmark-circle-outline" style={{ marginTop: spacing.lg }} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: colors.surface, padding: 3 },
  toggleKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff' },
});
