import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Card, T } from '../primitives';
import { spacing } from '../../theme/theme';

/**
 * Consistent rounded card that wraps a voting category: localized title +
 * optional subtitle + content (the option grid). Loading content should be
 * supplied by the caller via <VoteLoadingState />.
 */
export function VotingSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <View style={styles.header}>
        <T variant="h2">{title}</T>
        {subtitle ? <T variant="caption" style={styles.subtitle}>{subtitle}</T> : null}
      </View>
      <View style={styles.body}>{children}</View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { marginBottom: spacing.sm },
  subtitle: { marginTop: 2 },
  body: { marginTop: spacing.xs },
});
