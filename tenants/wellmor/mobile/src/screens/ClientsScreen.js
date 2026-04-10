import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, spacing, borderRadius, shadows } from '../constants/theme';
import { fetchClients, fetchClientStats } from '../services/api';

const STAGE_CONFIG = {
  prospect:       { color: colors.gray500, label: 'Prospect' },
  enriched:       { color: colors.accent,  label: 'Enriched' },
  sequenced:      { color: colors.amber,   label: 'Sequenced' },
  meeting_booked: { color: colors.green,   label: 'Meeting' },
};

const TIER_CONFIG = {
  A: { color: colors.brand,  bg: colors.brandLight },
  B: { color: colors.accent, bg: colors.accentLight },
  C: { color: colors.gray500, bg: colors.gray100 },
};

export default function ClientsScreen() {
  const navigation = useNavigation();
  const [clients, setClients] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [searchTimeout, setSearchTimeout] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async (searchQuery = '', isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      const [clientsResult, statsResult] = await Promise.all([
        fetchClients({
          search: searchQuery || undefined,
          stage: filter !== 'all' ? filter : undefined,
        }),
        fetchClientStats(),
      ]);
      setClients(clientsResult.clients || []);
      setStats(statsResult.stats || null);
    } catch (err) {
      console.error('Failed to load clients:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  useFocusEffect(
    useCallback(() => {
      load(search);
    }, [load, search])
  );

  function handleSearch(text) {
    setSearch(text);
    if (searchTimeout) clearTimeout(searchTimeout);
    setSearchTimeout(setTimeout(() => {
      setLoading(true);
      load(text);
    }, 400));
  }

  function handleFilterChange(newFilter) {
    setFilter(newFilter);
    setLoading(true);
  }

  const renderClient = ({ item }) => {
    const stage = STAGE_CONFIG[item.lifecycle_stage] || STAGE_CONFIG.prospect;
    const tier = TIER_CONFIG[item.lead_tier];

    return (
      <TouchableOpacity
        style={[styles.clientCard, shadows.sm]}
        activeOpacity={0.6}
        onPress={() => navigation.navigate('ClientDetail', { clientId: item.id, clientName: item.company })}
      >
        <View style={styles.clientHeader}>
          <View style={styles.clientInfo}>
            <Text style={styles.clientName}>{item.company}</Text>
            <Text style={styles.clientIndustry}>{item.industry || 'Unknown industry'}</Text>
          </View>
          <View style={styles.clientTrailing}>
            {tier && (
              <View style={[styles.tierBadge, { backgroundColor: tier.bg }]}>
                <Text style={[styles.tierText, { color: tier.color }]}>
                  {item.lead_tier}
                </Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={16} color={colors.gray300} />
          </View>
        </View>

        <View style={styles.clientMeta}>
          {(item.hq_city || item.hq_state) && (
            <View style={styles.metaItem}>
              <Ionicons name="location-outline" size={12} color={colors.gray400} />
              <Text style={styles.metaText}>
                {[item.hq_city, item.hq_state].filter(Boolean).join(', ')}
              </Text>
            </View>
          )}
          {(item.employee_count_actual || item.size) && (
            <View style={styles.metaItem}>
              <Ionicons name="people-outline" size={12} color={colors.gray400} />
              <Text style={styles.metaText}>
                {item.employee_count_actual ? `${item.employee_count_actual}` : item.size}
              </Text>
            </View>
          )}
          <View style={styles.metaItem}>
            <View style={[styles.stageDot, { backgroundColor: stage.color }]} />
            <Text style={[styles.metaText, { color: stage.color }]}>{stage.label}</Text>
          </View>
        </View>

        {item.lead_score > 0 && (
          <View style={styles.scoreRow}>
            <View style={styles.scoreTrack}>
              <View style={[styles.scoreFill, { width: `${Math.min(item.lead_score, 100)}%` }]} />
            </View>
            <Text style={styles.scoreText}>{item.lead_score}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const stages = ['all', 'prospect', 'enriched', 'sequenced'];

  if (loading && clients.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Search Bar */}
      <View style={[styles.searchContainer, shadows.sm]}>
        <Ionicons name="search-outline" size={18} color={colors.gray400} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search clients..."
          placeholderTextColor={colors.gray400}
          value={search}
          onChangeText={handleSearch}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => { setSearch(''); load(''); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={18} color={colors.gray300} />
          </TouchableOpacity>
        )}
      </View>

      {/* Stage Filters */}
      <View style={styles.filterRow}>
        {stages.map((s) => {
          const isActive = filter === s;
          return (
            <TouchableOpacity
              key={s}
              style={[styles.filterChip, isActive && styles.filterChipActive]}
              onPress={() => handleFilterChange(s)}
              activeOpacity={0.7}
            >
              <Text style={[styles.filterText, isActive && styles.filterTextActive]}>
                {s === 'all' ? `All${stats ? ` (${stats.total})` : ''}` :
                  `${s.charAt(0).toUpperCase() + s.slice(1)}${stats?.by_stage?.[s] ? ` (${stats.by_stage[s]})` : ''}`}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Tier Summary */}
      {stats && !search && filter === 'all' && (
        <View style={[styles.statsBar, shadows.sm]}>
          {[
            { label: 'Tier A', value: stats.by_tier?.A || 0, color: colors.brand },
            { label: 'Tier B', value: stats.by_tier?.B || 0, color: colors.accent },
            { label: 'Tier C', value: stats.by_tier?.C || 0, color: colors.gray400 },
            { label: 'Total', value: stats.total, color: colors.navy },
          ].map((s, i) => (
            <View key={s.label} style={styles.miniStat}>
              <Text style={[styles.miniValue, { color: s.color }]}>{s.value}</Text>
              <Text style={styles.miniLabel}>{s.label}</Text>
            </View>
          ))}
        </View>
      )}

      <FlatList
        data={clients}
        keyExtractor={(item) => item.id}
        renderItem={renderClient}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(search, true)} tintColor={colors.brand} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="business-outline" size={40} color={colors.gray300} />
            </View>
            <Text style={styles.emptyTitle}>
              {search ? 'No matching clients' : 'No clients yet'}
            </Text>
            <Text style={styles.emptyText}>
              {search ? 'Try a different search term.' : 'Clients will appear as the prospecting agent finds them.'}
            </Text>
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  // ─── Search ──────────────────────────────────
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    paddingVertical: spacing.md - 2,
    fontSize: fontSize.base,
    fontWeight: fontWeight.regular,
    color: colors.gray800,
  },
  // ─── Filters ─────────────────────────────────
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    gap: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: spacing.md - 2,
    paddingVertical: spacing.sm - 1,
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
    fontSize: fontSize.xs,
    color: colors.gray600,
    fontWeight: fontWeight.medium,
  },
  filterTextActive: {
    color: colors.white,
  },
  // ─── Stats Bar ───────────────────────────────
  statsBar: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm + 2,
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.sm + 4,
    paddingHorizontal: spacing.sm,
  },
  miniStat: {
    flex: 1,
    alignItems: 'center',
  },
  miniValue: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    letterSpacing: -0.3,
  },
  miniLabel: {
    fontSize: 10,
    fontWeight: fontWeight.medium,
    color: colors.gray400,
    marginTop: 2,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  // ─── List ────────────────────────────────────
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
  },
  // ─── Client Card ─────────────────────────────
  clientCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.sm + 2,
  },
  clientHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  clientInfo: {
    flex: 1,
    marginRight: spacing.md,
  },
  clientName: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.navy,
    letterSpacing: -0.2,
  },
  clientIndustry: {
    fontSize: fontSize.sm,
    color: colors.gray500,
    marginTop: 3,
  },
  clientTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  tierBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tierText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  clientMeta: {
    flexDirection: 'row',
    marginTop: spacing.md - 2,
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    fontSize: fontSize.xs,
    color: colors.gray500,
    fontWeight: fontWeight.medium,
  },
  stageDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  // ─── Score Bar ───────────────────────────────
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm + 2,
    gap: spacing.sm,
  },
  scoreTrack: {
    flex: 1,
    height: 4,
    backgroundColor: colors.gray150,
    borderRadius: 2,
    overflow: 'hidden',
  },
  scoreFill: {
    height: '100%',
    backgroundColor: colors.brand,
    borderRadius: 2,
  },
  scoreText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.gray500,
    width: 24,
    textAlign: 'right',
  },
  // ─── Empty ───────────────────────────────────
  empty: {
    alignItems: 'center',
    paddingTop: 100,
    paddingHorizontal: spacing.xl,
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
    marginTop: spacing.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
});
