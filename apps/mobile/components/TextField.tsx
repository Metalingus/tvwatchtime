import React from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T } from './primitives';
import { colors, radius, spacing, typography } from '../theme/theme';

export function TextField({
  label,
  value,
  onChangeText,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
  multiline,
  placeholder,
  style,
  containerStyle,
  trailingIcon,
}: {
  label?: string;
  value?: string;
  onChangeText?: (t: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address' | 'numeric';
  autoCapitalize?: 'none' | 'sentences' | 'words';
  multiline?: boolean;
  placeholder?: string;
  style?: any;
  containerStyle?: any;
  trailingIcon?: { name: string; onPress: () => void };
}) {
  return (
    <View style={[{ marginBottom: spacing.md }, containerStyle]}>
      {label ? (
        <T variant="caption" muted style={{ marginBottom: 4 }}>
          {label}
        </T>
      ) : null}
      <View style={{ position: 'relative' }}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize ?? 'sentences'}
          placeholder={placeholder}
          placeholderTextColor={colors.textDim}
          multiline={multiline}
          style={[styles.input, multiline && { minHeight: 90, textAlignVertical: 'top' }, trailingIcon && { paddingRight: 44 }, style]}
        />
        {trailingIcon ? (
          <Pressable onPress={trailingIcon.onPress} style={{ position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' }}>
            <Ionicons name={trailingIcon.name as any} size={20} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: colors.surfaceAlt,
    color: colors.text,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...typography.body,
  },
});
