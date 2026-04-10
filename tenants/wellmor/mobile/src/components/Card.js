import React from 'react';
import { View, StyleSheet } from 'react-native';
import { colors, borderRadius, spacing, shadows } from '../constants/theme';

export default function Card({ children, style, elevation = 'md' }) {
  return (
    <View style={[styles.card, shadows[elevation], style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
});
