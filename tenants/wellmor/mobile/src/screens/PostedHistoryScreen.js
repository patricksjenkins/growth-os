import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, spacing, borderRadius, shadows } from '../constants/theme';
import StatusBadge from '../components/StatusBadge';
import PlatformIcon from '../components/PlatformIcon';
import { fetchPosted } from '../services/api';

export default function PostedHistoryScreen({ navigation }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      const result = await fetchPosted();
      setPosts(result.queue || []);
    } catch (err) {
      console.error('Failed to load posted:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const platforms = ['all', 'linkedin', 'instagram', 'x', 'threads'];
  const filtered = filter === 'all' ? posts : posts.filter(p => p.platform === filter);

  const renderItem = ({ item }) => (
    <TouchableOpacity
      style={[styles.card, shadows.md]}
      activeOpacity={0.7}
      onPress={() => navigation.navigate('PostDetail', { postId: item.id })}
    >
      <View style={styles.cardTop}>
        <PlatformIcon platform={item.platform} size={15} showLabel />
        <StatusBadge status={item.status} size="small" />
      </View>
      <Text style={styles.headline} numberOfLines={2}>
        {item.headline || 'Untitled post'}
      </Text>
      {item.post_copy && (
        <Text style={styles.caption} numberOfLines={2}>{item.post_copy}</Text>
      )}
      <View style={styles.cardFooter}>
        <Text style={styles.footerText}>
          {item.posted_at
            ? new Date(item.posted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : new Date(item.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </Text>
      </View>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Platform Filter */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
      >
        {platforms.map((p) => {
          const isActive = filter === p;
          return (
            <TouchableOpacity
              key={p}
              style={[styles.filterChip, isActive && styles.filterChipActive]}
              onPress={() => setFilter(p)}
              activeOpacity={0.7}
            >
              <Text style={[styles.filterText, isActive && styles.filterTextActive]}>
                {p === 'all' ? 'All' : p.charAt(0).toUpperCase() + p.slice(1)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.brand} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="newspaper-outline" size={40} color={colors.gray300} />
            </View>
            <Text style={styles.emptyTitle}>No posted content</Text>
            <Text style={styles.emptyText}>Posts will appear here after publishing.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  filterRow: {
    flexDirection: 'row',
    paddingLeft: spacing.lg,
    paddingRight: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.gray200,
  },
  filterChipActive: {
    backgroundColor: colors.navy,
    borderColor: colors.navy,
  },
  filterText: {
    fontSize: fontSize.sm,
    color: colors.gray600,
    fontWeight: fontWeight.medium,
  },
  filterTextActive: {
    color: colors.white,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm + 2,
  },
  headline: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.navy,
    lineHeight: 21,
    marginBottom: spacing.xs,
    letterSpacing: -0.2,
  },
  caption: {
    fontSize: fontSize.sm,
    color: colors.gray500,
    lineHeight: 19,
    marginBottom: spacing.sm,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  footerText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: colors.gray400,
  },
  empty: {
    alignItems: 'center',
    paddingTop: 120,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.gray100,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.navy,
  },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.gray500,
    marginTop: spacing.xs,
  },
});
