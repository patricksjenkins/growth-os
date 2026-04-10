import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, fontSize, fontWeight, borderRadius, spacing } from '../constants/theme';

const statusConfig = {
  draft:    { bg: colors.amberBg,  text: colors.amber,  dot: colors.amber,  label: 'Pending' },
  approved: { bg: colors.greenBg,  text: colors.green,  dot: colors.green,  label: 'Approved' },
  posted:   { bg: colors.accentLight, text: colors.accent, dot: colors.accent, label: 'Posted' },
  rejected: { bg: colors.redBg,    text: colors.red,    dot: colors.red,    label: 'Rejected' },
};

export default function StatusBadge({ status, size = 'default' }) {
  const config = statusConfig[status] || statusConfig.draft;
  const isSmall = size === 'small';

  return (
    <View style={[styles.badge, { backgroundColor: config.bg }, isSmall && styles.badgeSmall]}>
      <View style={[styles.dot, { backgroundColor: config.dot }, isSmall && styles.dotSmall]} />
      <Text style={[styles.text, { color: config.text }, isSmall && styles.textSmall]}>
        {config.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.full,
    gap: 6,
    alignSelf: 'flex-start',
  },
  badgeSmall: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotSmall: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  text: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.3,
  },
  textSmall: {
    fontSize: 10,
  },
});
