import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, fontSize, fontWeight, spacing } from '../constants/theme';

export default function SectionHeader({ title, action, onAction }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {action && (
        <TouchableOpacity onPress={onAction} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.action}>{action}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.navy,
    letterSpacing: -0.3,
  },
  action: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.brand,
  },
});
