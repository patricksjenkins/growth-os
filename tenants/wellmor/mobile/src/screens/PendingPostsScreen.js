import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, spacing, borderRadius, shadows } from '../constants/theme';
import StatusBadge from '../components/StatusBadge';
import PlatformIcon from '../components/PlatformIcon';
import { fetchDrafts, fetchApproved, fetchRejected, getImageUrl } from '../services/api';

const FILTERS = [
  { key: 'pending', label: 'Pending', fetcher: fetchDrafts },
  { key: 'approved', label: 'Approved', fetcher: fetchApproved },
  { key: 'rejected', label: 'Rejected', fetcher: fetchRejected },
];

const EMPTY_STATES = {
  pending: { title: 'All caught up', text: 'No posts waiting for approval.' },
  approved: { title: 'No approved posts yet', text: 'Approved posts will show up here once you take action.' },
  rejected: { title: 'No rejected posts', text: 'Posts you reject will be listed here.' },
};

export default function PendingPostsScreen({ navigation }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('pending');

  const load = useCallback(async (isRefresh = false, filterKey = filter) => {
    try {
      if (isRefresh) setRefreshing(true);
      const f = FILTERS.find((x) => x.key === filterKey) || FILTERS[0];
      const result = await f.fetcher();
      setPosts(result.queue || []);
    } catch (err) {
      console.error('Failed to load drafts:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onFilterChange = useCallback((key) => {
    if (key === filter) return;
    setFilter(key);
    setLoading(true);
    load(false, key);
  }, [filter, load]);

  const renderItem = ({ item }) => {
    const imageUrl = getImageUrl(item.image_file_name);

    return (
      <TouchableOpacity
        style={[styles.card, shadows.md]}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('PostDetail', { postId: item.id })}
      >
        {imageUrl && (
          <Image source={{ uri: imageUrl }} style={styles.image} resizeMode="cover" />
        )}
        <View style={styles.cardBody}>
          <View style={styles.cardTop}>
            <PlatformIcon platform={item.platform} size={15} showLabel />
            <StatusBadge status={item.status} size="small" />
          </View>

          <Text style={styles.headline} numberOfLines={2}>
            {item.headline || 'Untitled post'}
          </Text>

          {item.hook && (
            <Text style={styles.hook} numberOfLines={2}>{item.hook}</Text>
          )}

          <View style={styles.cardFooter}>
            <Text style={styles.footerText}>
              {new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </Text>
            {item.best_time && (
              <>
                <View style={styles.footerDot} />
                <Text style={styles.footerText}>{item.best_time}</Text>
              </>
            )}
          </View>
        </View>
        <View style={styles.chevron}>
          <Ionicons name="chevron-forward" size={18} color={colors.gray300} />
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  const empty = EMPTY_STATES[filter] || EMPTY_STATES.pending;

  return (
    <View style={styles.container}>
      <View style={styles.filterBar}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <TouchableOpacity
              key={f.key}
              activeOpacity={0.7}
              onPress={() => onFilterChange(f.key)}
              style={[styles.filterButton, active && styles.filterButtonActive]}
            >
              <Text style={[styles.filterText, active && styles.filterTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <FlatList
        data={posts}
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
              <Ionicons name="checkmark-done-circle-outline" size={40} color={colors.gray300} />
            </View>
            <Text style={styles.emptyTitle}>{empty.title}</Text>
            <Text style={styles.emptyText}>{empty.text}</Text>
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
  filterBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
    backgroundColor: colors.background,
  },
  filterButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.gray100,
    alignItems: 'center',
  },
  filterButtonActive: {
    backgroundColor: colors.navy,
  },
  filterText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.gray500,
    letterSpacing: -0.1,
  },
  filterTextActive: {
    color: colors.card,
  },
  list: {
    padding: spacing.lg,
    paddingTop: spacing.md,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    marginBottom: spacing.md,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  image: {
    width: 88,
    height: '100%',
    minHeight: 110,
  },
  cardBody: {
    flex: 1,
    padding: spacing.md,
    paddingLeft: spacing.md,
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
  hook: {
    fontSize: fontSize.sm,
    color: colors.gray500,
    lineHeight: 19,
    marginBottom: spacing.sm,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 'auto',
  },
  footerText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: colors.gray400,
  },
  footerDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.gray300,
  },
  chevron: {
    justifyContent: 'center',
    paddingRight: spacing.md,
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
