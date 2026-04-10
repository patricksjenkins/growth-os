import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, borderRadius, spacing, shadows } from '../constants/theme';

export default function StatCard({ icon, label, value, color = colors.accent }) {
  return (
    <View style={[styles.card, shadows.md]}>
      <View style={styles.topRow}>
        <View style={[styles.iconWrap, { backgroundColor: color + '12' }]}>
          <Ionicons name={icon} size={18} color={color} />
        </View>
        <Text style={styles.value}>{value}</Text>
      </View>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs + 2,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.navy,
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: colors.gray400,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
});
