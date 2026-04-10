import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, spacing, borderRadius, shadows } from '../constants/theme';
import StatCard from '../components/StatCard';
import Card from '../components/Card';
import SectionHeader from '../components/SectionHeader';
import StatusBadge from '../components/StatusBadge';
import PlatformIcon from '../components/PlatformIcon';
import { fetchDashboard } from '../services/api';

export default function DashboardScreen({ navigation }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      setError(null);
      const result = await fetchDashboard();
      setData(result.dashboard);
    } catch (err) {
      setError(err.message);
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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <View style={styles.errorIcon}>
          <Ionicons name="cloud-offline-outline" size={36} color={colors.gray400} />
        </View>
        <Text style={styles.errorTitle}>Unable to Connect</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => { setLoading(true); load(); }}>
          <Text style={styles.retryText}>Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const d = data || {};
  const today = new Date();
  const greeting = today.getHours() < 12 ? 'Good morning' : today.getHours() < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.brand} />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Image
          source={require('../../assets/logo.png')}
          style={styles.logo}
          resizeMode="contain"
        />
        <View style={styles.greetingRow}>
          <Text style={styles.greeting}>{greeting}</Text>
          <Text style={styles.dateText}>
            {today.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          </Text>
        </View>
      </View>

      {/* Stats Row */}
      <View style={styles.statsRow}>
        <StatCard
          icon="document-text-outline"
          label="Pending"
          value={d.pending_count || 0}
          color={colors.amber}
        />
        <StatCard
          icon="checkmark-circle-outline"
          label="Approved"
          value={d.approved_count || 0}
          color={colors.green}
        />
        <StatCard
          icon="send-outline"
          label="Posted"
          value={d.posted_count || 0}
          color={colors.accent}
        />
      </View>

      {/* Pending Approvals */}
      {d.pending_approvals && d.pending_approvals.length > 0 && (
        <View style={styles.section}>
          <SectionHeader
            title="Needs Attention"
            action="View All"
            onAction={() => navigation.navigate('PendingPosts')}
          />
          <Card>
            {d.pending_approvals.map((item, index) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.listItem, index === 0 && styles.listItemFirst]}
                activeOpacity={0.6}
                onPress={() => navigation.navigate('PostDetail', { postId: item.id })}
              >
                <PlatformIcon platform={item.platform} size={16} />
                <View style={styles.listItemContent}>
                  <Text style={styles.listItemTitle} numberOfLines={1}>
                    {item.headline || 'Untitled post'}
                  </Text>
                  <Text style={styles.listItemMeta}>
                    {new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.gray300} />
              </TouchableOpacity>
            ))}
          </Card>
        </View>
      )}

      {/* Recent Posts */}
      {d.recent_posts && d.recent_posts.length > 0 && (
        <View style={styles.section}>
          <SectionHeader
            title="Recently Posted"
            action="View All"
            onAction={() => navigation.navigate('PostedHistory')}
          />
          <Card>
            {d.recent_posts.map((item, index) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.listItem, index === 0 && styles.listItemFirst]}
                activeOpacity={0.6}
                onPress={() => navigation.navigate('PostDetail', { postId: item.id })}
              >
                <PlatformIcon platform={item.platform} size={16} />
                <View style={styles.listItemContent}>
                  <Text style={styles.listItemTitle} numberOfLines={1}>
                    {item.headline || 'Untitled post'}
                  </Text>
                </View>
                <StatusBadge status={item.status} size="small" />
              </TouchableOpacity>
            ))}
          </Card>
        </View>
      )}

      {/* Client Pipeline */}
      <View style={styles.section}>
        <SectionHeader title="Client Pipeline" />
        <Card>
          <View style={styles.pipelineRow}>
            {[
              { value: d.total_clients || 0, label: 'Total', color: colors.navy },
              { value: d.prospects || 0, label: 'Prospects', color: colors.gray500 },
              { value: d.enriched || 0, label: 'Enriched', color: colors.accent },
              { value: d.sequenced || 0, label: 'Sequenced', color: colors.brand },
            ].map((stat, i) => (
              <View key={stat.label} style={styles.pipelineStat}>
                <Text style={[styles.pipelineValue, { color: stat.color }]}>{stat.value}</Text>
                <Text style={styles.pipelineLabel}>{stat.label}</Text>
              </View>
            ))}
          </View>
        </Card>
      </View>

      <View style={{ height: spacing.xl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: spacing.xl,
  },
  // ─── Header ──────────────────────────────────
  header: {
    paddingTop: 17,
    marginBottom: spacing.lg,
  },
  logo: {
    width: 750,
    height: 173,
    alignSelf: 'center',
    marginBottom: -28,
  },
  greetingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  greeting: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.navy,
    letterSpacing: -0.5,
  },
  dateText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.gray400,
  },
  // ─── Stats ───────────────────────────────────
  statsRow: {
    flexDirection: 'row',
    gap: spacing.sm + 2,
    marginBottom: spacing.lg,
  },
  // ─── Sections ────────────────────────────────
  section: {
    marginBottom: spacing.sm,
  },
  // ─── List Items ──────────────────────────────
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md - 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray150,
    gap: spacing.md - 4,
  },
  listItemFirst: {
    borderTopWidth: 0,
    paddingTop: 0,
  },
  listItemContent: {
    flex: 1,
  },
  listItemTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.medium,
    color: colors.gray800,
    letterSpacing: -0.1,
  },
  listItemMeta: {
    fontSize: fontSize.xs,
    color: colors.gray400,
    marginTop: 3,
  },
  // ─── Pipeline ────────────────────────────────
  pipelineRow: {
    flexDirection: 'row',
  },
  pipelineStat: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  pipelineValue: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    letterSpacing: -0.5,
  },
  pipelineLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: colors.gray400,
    marginTop: spacing.xs,
    letterSpacing: 0.2,
  },
  // ─── Error ───────────────────────────────────
  errorIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.gray100,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  errorTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.gray800,
  },
  errorText: {
    fontSize: fontSize.sm,
    color: colors.gray500,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  retryButton: {
    marginTop: spacing.lg,
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md - 2,
    borderRadius: borderRadius.full,
  },
  retryText: {
    color: colors.white,
    fontWeight: fontWeight.semibold,
    fontSize: fontSize.base,
  },
});
