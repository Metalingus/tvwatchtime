import React from 'react';
import { Pressable, StyleSheet, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing, typography } from '../theme/theme';

export function TextField({
  label,
  value,
  editable,
  onChangeText,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
  multiline,
  placeholder,
  style,
  containerStyle,
  trailingIcon,
  onContentSizeChange,
}: {
  label?: string;
  value?: string;
  editable?: boolean;
  onChangeText?: (t: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words';
  multiline?: boolean;
  placeholder?: string;
  style?: any;
  containerStyle?: any;
  trailingIcon?: { name: string; onPress: () => void };
  onContentSizeChange?: (e: any) => void;
}) {
  const { tokens } = useAppearance();
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
          editable={editable}
          onChangeText={onChangeText}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize ?? 'sentences'}
          placeholder={placeholder}
          placeholderTextColor={tokens.placeholder}
          multiline={multiline}
          onContentSizeChange={onContentSizeChange}
          style={[
            styles.input,
            { backgroundColor: tokens.inputBackground, color: tokens.textPrimary, borderColor: tokens.border },
            multiline && { minHeight: 90, textAlignVertical: 'top' },
            trailingIcon && { paddingRight: 44 },
            style,
          ]}
        />
        {trailingIcon ? (
          <Pressable onPress={trailingIcon.onPress} style={{ position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' }}>
            <Ionicons name={trailingIcon.name as any} size={20} color={tokens.textMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderWidth: 1,
    ...typography.body,
  },
});
