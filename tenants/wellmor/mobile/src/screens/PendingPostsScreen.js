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
import { fetchDrafts, getImageUrl } from '../services/api';

export default function PendingPostsScreen({ navigation }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      const result = await fetchDrafts();
      setPosts(result.queue || []);
    } catch (err) {
      console.error('Failed to load drafts:', err);
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

  return (
    <View style={styles.container}>
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
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptyText}>No posts waiting for approval.</Text>
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
