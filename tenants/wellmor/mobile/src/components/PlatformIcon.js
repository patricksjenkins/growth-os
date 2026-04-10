import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, borderRadius, spacing } from '../constants/theme';

const platformConfig = {
  linkedin:  { icon: 'logo-linkedin',  color: colors.linkedin,  label: 'LinkedIn' },
  instagram: { icon: 'logo-instagram', color: colors.instagram, label: 'Instagram' },
  x:         { icon: 'logo-twitter',   color: colors.x,         label: 'X' },
  threads:   { icon: 'at-outline',     color: colors.threads,   label: 'Threads' },
};

export default function PlatformIcon({ platform, size = 18, showLabel = false }) {
  const config = platformConfig[platform] || platformConfig.linkedin;

  return (
    <View style={styles.container}>
      <View style={[styles.iconWrap, { backgroundColor: config.color + '0A' }]}>
        <Ionicons name={config.icon} size={size} color={config.color} />
      </View>
      {showLabel && (
        <Text style={styles.label}>{config.label}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.gray700,
  },
});
