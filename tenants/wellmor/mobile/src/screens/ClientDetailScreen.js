import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, spacing, borderRadius, shadows } from '../constants/theme';
import { fetchClientDetail } from '../services/api';

const STAGE_CONFIG = {
  prospect:       { color: colors.gray500, label: 'Prospect' },
  enriched:       { color: colors.accent,  label: 'Enriched' },
  sequenced:      { color: colors.amber,   label: 'Sequenced' },
  meeting_booked: { color: colors.green,   label: 'Meeting Booked' },
};

const TIER_CONFIG = {
  A: { color: colors.brand,  bg: colors.brandLight },
  B: { color: colors.accent, bg: colors.accentLight },
  C: { color: colors.gray500, bg: colors.gray100 },
};

function InfoRow({ icon, label, value, onPress, isLast }) {
  if (!value) return null;
  const content = (
    <View style={[styles.infoRow, isLast && styles.infoRowLast]}>
      <View style={styles.infoIconWrap}>
        <Ionicons name={icon} size={16} color={colors.gray400} />
      </View>
      <View style={styles.infoContent}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={[styles.infoValue, onPress && styles.infoLink]}>{value}</Text>
      </View>
    </View>
  );
  if (onPress) {
    return <TouchableOpacity onPress={onPress} activeOpacity={0.6}>{content}</TouchableOpacity>;
  }
  return content;
}

function ContactCard({ contact }) {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Unknown';
  return (
    <View style={[styles.contactCard, shadows.sm]}>
      <View style={styles.contactHeader}>
        <View style={styles.contactAvatar}>
          <Text style={styles.contactInitial}>
            {(contact.first_name || contact.last_name || '?')[0].toUpperCase()}
          </Text>
        </View>
        <View style={styles.contactInfo}>
          <View style={styles.contactNameRow}>
            <Text style={styles.contactName}>{name}</Text>
            {contact.is_primary_contact && (
              <View style={styles.primaryBadge}>
                <Text style={styles.primaryText}>Primary</Text>
              </View>
            )}
          </View>
          {contact.title && <Text style={styles.contactTitle}>{contact.title}</Text>}
          {contact.role_in_buying && (
            <Text style={styles.contactRole}>{contact.role_in_buying}</Text>
          )}
        </View>
      </View>
      <View style={styles.contactActions}>
        {contact.email && (
          <TouchableOpacity
            style={styles.contactAction}
            onPress={() => Linking.openURL(`mailto:${contact.email}`)}
            activeOpacity={0.6}
          >
            <View style={styles.contactActionIcon}>
              <Ionicons name="mail-outline" size={14} color={colors.accent} />
            </View>
            <Text style={styles.contactActionText} numberOfLines={1}>{contact.email}</Text>
          </TouchableOpacity>
        )}
        {contact.phone && (
          <TouchableOpacity
            style={styles.contactAction}
            onPress={() => Linking.openURL(`tel:${contact.phone}`)}
            activeOpacity={0.6}
          >
            <View style={styles.contactActionIcon}>
              <Ionicons name="call-outline" size={14} color={colors.accent} />
            </View>
            <Text style={styles.contactActionText}>{contact.phone}</Text>
          </TouchableOpacity>
        )}
        {contact.linkedin_url && (
          <TouchableOpacity
            style={styles.contactAction}
            onPress={() => Linking.openURL(contact.linkedin_url)}
            activeOpacity={0.6}
          >
            <View style={styles.contactActionIcon}>
              <Ionicons name="logo-linkedin" size={14} color={colors.accent} />
            </View>
            <Text style={styles.contactActionText}>LinkedIn Profile</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

export default function ClientDetailScreen({ route }) {
  const { clientId } = route.params;
  const [client, setClient] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadClient();
  }, [clientId]);

  async function loadClient() {
    try {
      setLoading(true);
      const result = await fetchClientDetail(clientId);
      setClient(result.client);
      setContacts(result.contacts || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  if (error || !client) {
    return (
      <View style={styles.center}>
        <View style={styles.errorIconWrap}>
          <Ionicons name="alert-circle-outline" size={36} color={colors.gray300} />
        </View>
        <Text style={styles.errorText}>{error || 'Client not found'}</Text>
      </View>
    );
  }

  const location = [client.hq_city, client.hq_state].filter(Boolean).join(', ');
  const stage = STAGE_CONFIG[client.lifecycle_stage] || STAGE_CONFIG.prospect;
  const tier = TIER_CONFIG[client.lead_tier];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.companyName}>{client.company}</Text>
        <View style={styles.badges}>
          {tier && (
            <View style={[styles.badge, { backgroundColor: tier.bg }]}>
              <Text style={[styles.badgeText, { color: tier.color }]}>Tier {client.lead_tier}</Text>
            </View>
          )}
          <View style={[styles.badge, { backgroundColor: stage.color + '14' }]}>
            <View style={[styles.badgeDot, { backgroundColor: stage.color }]} />
            <Text style={[styles.badgeText, { color: stage.color }]}>
              {stage.label}
            </Text>
          </View>
        </View>
      </View>

      {/* Lead Score */}
      {client.lead_score > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Lead Score</Text>
          <View style={[styles.scoreCard, shadows.sm]}>
            <View style={styles.scoreTrack}>
              <View style={[styles.scoreFill, { width: `${Math.min(client.lead_score, 100)}%` }]} />
            </View>
            <Text style={styles.scoreValue}>{client.lead_score}</Text>
          </View>
        </View>
      )}

      {/* Company Details */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Company Details</Text>
        <View style={[styles.infoCard, shadows.sm]}>
          <InfoRow icon="business-outline" label="Industry" value={client.industry} />
          <InfoRow icon="location-outline" label="Location" value={location} />
          <InfoRow
            icon="people-outline"
            label="Employees"
            value={client.employee_count_actual ? `${client.employee_count_actual}` : client.size}
          />
          <InfoRow
            icon="globe-outline"
            label="Website"
            value={client.website || client.domain}
            onPress={
              (client.website || client.domain)
                ? () => {
                    const url = client.website || `https://${client.domain}`;
                    Linking.openURL(url.startsWith('http') ? url : `https://${url}`);
                  }
                : undefined
            }
          />
          <InfoRow icon="git-branch-outline" label="Source" value={client.source} />
          <InfoRow icon="flask-outline" label="Enrichment" value={client.enrichment_status} />
          {client.enriched_at && (
            <InfoRow
              icon="time-outline"
              label="Enriched"
              value={new Date(client.enriched_at).toLocaleDateString()}
              isLast
            />
          )}
        </View>
      </View>

      {/* Outreach */}
      {(client.outreach_ready !== undefined || client.outreach_recommendation) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Outreach</Text>
          <View style={[styles.infoCard, shadows.sm]}>
            {client.outreach_ready !== undefined && (
              <InfoRow
                icon={client.outreach_ready ? 'checkmark-circle-outline' : 'close-circle-outline'}
                label="Ready"
                value={client.outreach_ready ? 'Yes' : 'No'}
              />
            )}
            <InfoRow
              icon="bulb-outline"
              label="Recommendation"
              value={client.outreach_recommendation}
              isLast
            />
          </View>
        </View>
      )}

      {/* Morgan's Notes */}
      {client.morgan_notes && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <View style={[styles.notesCard, shadows.sm]}>
            <Text style={styles.notesText}>{client.morgan_notes}</Text>
          </View>
        </View>
      )}

      {/* Contacts */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Contacts{contacts.length > 0 ? ` (${contacts.length})` : ''}
        </Text>
        {contacts.length > 0 ? (
          contacts.map((contact) => <ContactCard key={contact.id} contact={contact} />)
        ) : (
          <View style={[styles.emptyContacts, shadows.sm]}>
            <Ionicons name="person-outline" size={28} color={colors.gray300} />
            <Text style={styles.emptyText}>No contacts yet</Text>
          </View>
        )}
      </View>

      {/* Footer Meta */}
      <Text style={styles.footerDate}>
        Added {new Date(client.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        {client.updated_at && ` · Updated ${new Date(client.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
      </Text>
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
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  errorIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.gray100,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  errorText: {
    fontSize: fontSize.base,
    color: colors.gray500,
  },
  // ─── Header ──────────────────────────────────
  header: {
    marginBottom: spacing.lg,
  },
  companyName: {
    fontSize: fontSize.xl + 2,
    fontWeight: fontWeight.bold,
    color: colors.navy,
    letterSpacing: -0.5,
    marginBottom: spacing.sm + 2,
  },
  badges: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.full,
    gap: 6,
  },
  badgeText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  badgeDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  // ─── Sections ────────────────────────────────
  section: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.gray400,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm + 2,
  },
  // ─── Info Card ───────────────────────────────
  infoCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.md - 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray150,
  },
  infoRowLast: {
    borderBottomWidth: 0,
  },
  infoIconWrap: {
    width: 28,
    marginTop: 2,
  },
  infoContent: {
    flex: 1,
  },
  infoLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: colors.gray400,
    marginBottom: 2,
  },
  infoValue: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.medium,
    color: colors.gray800,
  },
  infoLink: {
    color: colors.accent,
  },
  // ─── Score ───────────────────────────────────
  scoreCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    gap: spacing.md,
  },
  scoreTrack: {
    flex: 1,
    height: 6,
    backgroundColor: colors.gray150,
    borderRadius: 3,
    overflow: 'hidden',
  },
  scoreFill: {
    height: '100%',
    backgroundColor: colors.brand,
    borderRadius: 3,
  },
  scoreValue: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.navy,
    width: 40,
    textAlign: 'right',
    letterSpacing: -0.5,
  },
  // ─── Notes ───────────────────────────────────
  notesCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
  },
  notesText: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.regular,
    color: colors.gray700,
    lineHeight: 23,
  },
  // ─── Contacts ────────────────────────────────
  contactCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.sm + 2,
  },
  contactHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  contactAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brandLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  contactInitial: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.brand,
  },
  contactInfo: {
    flex: 1,
  },
  contactNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  contactName: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.navy,
  },
  primaryBadge: {
    backgroundColor: colors.brandLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  primaryText: {
    fontSize: 10,
    fontWeight: fontWeight.semibold,
    color: colors.brand,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  contactTitle: {
    fontSize: fontSize.sm,
    color: colors.gray500,
    marginTop: 2,
  },
  contactRole: {
    fontSize: fontSize.xs,
    color: colors.gray400,
    marginTop: 1,
  },
  contactActions: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray150,
    gap: spacing.sm,
  },
  contactAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 3,
  },
  contactActionIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accentLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactActionText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.accent,
    flex: 1,
  },
  emptyContacts: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
  },
  emptyText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.gray400,
    marginTop: spacing.sm,
  },
  footerDate: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: colors.gray400,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
});
