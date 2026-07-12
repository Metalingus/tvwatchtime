import React, { useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Header } from '../components/Header';
import { Button, Screen, T } from '../components/primitives';
import { TextField } from '../components/TextField';
import { useCreateList } from '../api/hooks';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { showError } from '../lib/dialog';

interface SelectedItem { id: string; title: string; posterUrl?: string | null; type: string }

export default function CreateListScreen() {
  const { tokens } = useAppearance();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [selected, setSelected] = useState<SelectedItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const create = useCreateList();

  const isSearching = searchQuery.trim().length >= 2;
  const search = useQuery({
    queryKey: ['search', 'list-create', searchQuery],
    queryFn: () => api.get<{ items: any[] }>('/search', { q: searchQuery, pageSize: 20 }),
    enabled: isSearching,
  });

  const selectedIds = new Set(selected.map(s => s.id));

  const addItem = (item: any) => {
    if (selectedIds.has(item.id)) return;
    setSelected(prev => [...prev, { id: item.id, title: item.title, posterUrl: item.posterUrl, type: item.type }]);
  };

  const removeItem = (id: string) => setSelected(prev => prev.filter(s => s.id !== id));

  const submit = async () => {
    if (!title.trim()) { showError({ description: 'A title is required' }); return; }
    try {
      const result = await create.mutateAsync({
        title: title.trim(),
        description: description.trim() || undefined,
        visibility: isPublic ? 'PUBLIC' : 'PRIVATE',
        items: selected.map(s => s.id),
      });
      router.replace(`/list/${result.id}`);
    } catch (e: any) {
      showError({ title: 'Failed', description: e?.message ?? 'Try again' });
    }
  };

  const searchResults = (search.data?.items ?? []).filter(i => !selectedIds.has(i.id));

  return (
    <Screen style={{ flex: 1 }}>
      <Header title="Create List" showBack />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, paddingBottom: 100 }} keyboardShouldPersistTaps="handled">
        <TextField label="Title" value={title} onChangeText={setTitle} placeholder="My favorite shows" />
        <TextField label="Description (optional)" value={description} onChangeText={setDescription} placeholder="A collection of..." />

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md }}>
          <T variant="caption" muted>Visibility</T>
          <Pressable onPress={() => setIsPublic(!isPublic)} style={{ flexDirection: 'row', alignItems: 'center' }}>
            <T variant="caption" style={{ marginRight: 8 }}>{isPublic ? 'Public' : 'Private'}</T>
            <View style={[styles.toggle, { backgroundColor: tokens.surface }, isPublic && { backgroundColor: tokens.primary }]}>
              <View style={[styles.toggleKnob, { backgroundColor: tokens.controlThumb }, isPublic && { transform: [{ translateX: 18 }] }]} />
            </View>
          </Pressable>
        </View>

        {/* Search bar */}
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: tokens.surfaceAlt, borderRadius: radius.md, borderWidth: 1, borderColor: tokens.border, paddingRight: 12, marginBottom: spacing.md }}>
          <Ionicons name="search" size={18} color={tokens.textMuted} style={{ marginLeft: 12 }} />
          <TextInput value={searchQuery} onChangeText={setSearchQuery} placeholder="Search shows and movies to add..." placeholderTextColor={tokens.placeholder} autoCapitalize="none" style={{ flex: 1, marginLeft: 8, color: tokens.textPrimary, paddingVertical: spacing.sm + 2 }} />
          {searchQuery.length > 0 ? <Pressable onPress={() => setSearchQuery('')} hitSlop={8}><Ionicons name="close-circle" size={20} color={tokens.textMuted} /></Pressable> : null}
        </View>

        {/* Search results */}
        {isSearching && searchResults.length > 0 ? (
          <View style={{ marginBottom: spacing.md, maxHeight: 350 }}>
            <FlatList
              data={searchResults}
              keyExtractor={(i) => i.id}
              scrollEnabled
              nestedScrollEnabled
              renderItem={({ item }) => (
                <Pressable onPress={() => addItem(item)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, borderBottomColor: tokens.border, borderBottomWidth: 1 }}>
                  <Image source={item.posterUrl ? { uri: item.posterUrl } : undefined} style={{ width: 40, height: 60, borderRadius: 4, backgroundColor: tokens.surfaceElevated }} contentFit="cover" transition={150} />
                  <View style={{ flex: 1, marginLeft: spacing.sm }}>
                    <T variant="caption" numberOfLines={1}>{item.title}</T>
                    <T variant="micro" muted>{item.type}</T>
                  </View>
                  <Ionicons name="add-circle-outline" size={22} color={tokens.primary} />
                </Pressable>
              )}
            />
          </View>
        ) : null}

        {/* Selected items */}
        {selected.length > 0 ? (
          <View style={{ marginBottom: spacing.md }}>
            <T variant="caption" muted style={{ marginBottom: 6 }}>{selected.length} items added</T>
            <FlatList
              horizontal
              data={selected}
              keyExtractor={(i) => i.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingVertical: 8, paddingRight: 20 }}
              renderItem={({ item }) => (
                <View style={{ marginRight: spacing.md }}>
                  <View style={{ position: 'relative' }}>
                    <Image source={item.posterUrl ? { uri: item.posterUrl } : undefined} style={{ width: 70, height: 105, borderRadius: 6, backgroundColor: tokens.surfaceElevated }} contentFit="cover" transition={150} />
                    <Pressable onPress={() => removeItem(item.id)} style={{ position: 'absolute', top: -8, right: -8, backgroundColor: tokens.danger, borderRadius: 12, width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: tokens.background, zIndex: 10 }}>
                      <Ionicons name="close" size={14} color={tokens.mediaText} />
                    </Pressable>
                  </View>
                  <T variant="micro" numberOfLines={1} style={{ width: 70, marginTop: 4 }}>{item.title}</T>
                </View>
              )}
            />
          </View>
        ) : null}
      </ScrollView>

      {/* Sticky bottom button */}
      <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: tokens.background, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderTopColor: tokens.border, borderTopWidth: 1 }}>
        <Button title="Create list" onPress={submit} loading={create.isPending} icon="checkmark-circle-outline" />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  toggle: { width: 44, height: 24, borderRadius: 12, padding: 3 },
  toggleKnob: { width: 18, height: 18, borderRadius: 9 },
});
