import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, View, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { T, Spinner } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';

const BASE_URL = (Constants.expoConfig?.extra as any)?.apiBaseUrl || 'http://localhost:4000/api';

export function CommentImage({ imageId, width = 120, height = 80, blurhash }: { imageId: string; width?: number; height?: number; blurhash?: string | null }) {
  const [viewer, setViewer] = useState(false);
  const [fullLoaded, setFullLoaded] = useState(false);
  const { tokens } = useAppearance();
  const blurhashFilter = blurhash ? { blurhash, blurhashRadius: 20 } : undefined;

  return (
    <>
      <Pressable onPress={() => setViewer(true)}>
        <Image
          source={{ uri: `${BASE_URL}/comment-images/${imageId}`}}
          style={{ width, height, borderRadius: 8, backgroundColor: tokens.surfaceElevated }}
          contentFit="cover"
          placeholder={blurhash ? { blurhash, blurhashRadius: 20 } : undefined}
          transition={200}
        />
      </Pressable>

      <Modal visible={viewer} animationType="fade" transparent onRequestClose={() => setViewer(false)}>
        <View style={styles.fullBg}>
          <Pressable style={styles.closeBtn} onPress={() => setViewer(false)}>
            <Ionicons name="close" size={28} color={tokens.mediaText} />
          </Pressable>
          {!fullLoaded ? <Spinner /> : null}
          <Image
            source={{ uri: `${BASE_URL}/comment-images/${imageId}` }}
            style={styles.fullImage}
            contentFit="contain"
            onLoad={() => setFullLoaded(true)}
            cachePolicy="memory-disk"
          />
        </View>
      </Modal>
    </>
  );
}

const { width: screenW, height: screenH } = Dimensions.get('window');

const styles = StyleSheet.create({
  // eslint-disable-next-line local/no-hardcoded-colors -- intentional full-screen black canvas for image viewer
  fullBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' },
  closeBtn: { position: 'absolute', top: 50, right: 20, zIndex: 10, padding: 8 },
  fullImage: { width: screenW, height: screenH * 0.8 },
});
