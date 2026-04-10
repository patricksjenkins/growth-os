import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Image,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Dimensions,
  Linking,
  FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, spacing, borderRadius, shadows } from '../constants/theme';
import StatusBadge from '../components/StatusBadge';
import PlatformIcon from '../components/PlatformIcon';
import Card from '../components/Card';
import { fetchQueueItem, approvePost, rejectPost, getImageUrl } from '../services/api';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const IMAGE_SIZE = SCREEN_WIDTH - spacing.lg * 2;

export default function PostDetailScreen({ route, navigation }) {
  const { postId } = route.params;
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [activeSlide, setActiveSlide] = useState(0);
  const carouselRef = useRef(null);

  useEffect(() => {
    loadPost();
  }, [postId]);

  async function loadPost() {
    try {
      const result = await fetchQueueItem(postId);
      setPost(result.item);
    } catch (err) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove() {
    Alert.alert('Approve Post', 'This post will be queued for publishing.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Approve',
        style: 'default',
        onPress: async () => {
          try {
            setActing(true);
            await approvePost(postId);
            await loadPost();
            Alert.alert('Approved', 'Post has been approved and is ready to publish.');
          } catch (err) {
            Alert.alert('Error', err.message);
          } finally {
            setActing(false);
          }
        },
      },
    ]);
  }

  async function handleReject() {
    Alert.alert('Reject Post', 'This post will be moved to rejected.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject',
        style: 'destructive',
        onPress: async () => {
          try {
            setActing(true);
            await rejectPost(postId);
            await loadPost();
            Alert.alert('Rejected', 'Post has been rejected.');
          } catch (err) {
            Alert.alert('Error', err.message);
          } finally {
            setActing(false);
          }
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  if (!post) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Post not found</Text>
      </View>
    );
  }

  // Extract carousel images from campaign_payload
  const campaignPayload = post.campaign_payload || {};
  const carouselImages = campaignPayload.carousel_images || [];
  const slides = campaignPayload.content?.slides || [];

  // Build image list: prefer carousel_images, fallback to single hero
  const imageList = carouselImages.length > 0
    ? carouselImages.map((img, index) => ({
        key: `slide-${index}`,
        url: getImageUrl(img.file_name),
        slideNumber: img.slide_number || index + 1,
        slideRole: img.slide_role || '',
        headline: slides[index]?.headline || '',
        body: slides[index]?.body || '',
      }))
    : post.image_file_name
      ? [{ key: 'hero', url: getImageUrl(post.image_file_name), slideNumber: 1, slideRole: 'hook' }]
      : [];

  const hasCarousel = imageList.length > 1;

  const onScrollEnd = (e) => {
    const contentOffsetX = e.nativeEvent.contentOffset.x;
    const index = Math.round(contentOffsetX / IMAGE_SIZE);
    setActiveSlide(index);
  };

  const renderCarouselImage = ({ item, index }) => (
    <View style={styles.carouselSlide}>
      <Image
        source={{ uri: item.url }}
        style={styles.heroImage}
        resizeMode="cover"
      />
    </View>
  );

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Carousel or Single Image */}
        {imageList.length > 0 && (
          <View style={styles.carouselContainer}>
            {hasCarousel ? (
              <>
                <FlatList
                  ref={carouselRef}
                  data={imageList}
                  renderItem={renderCarouselImage}
                  keyExtractor={(item) => item.key}
                  horizontal
                  pagingEnabled
                  showsHorizontalScrollIndicator={false}
                  onMomentumScrollEnd={onScrollEnd}
                  snapToInterval={IMAGE_SIZE}
                  decelerationRate="fast"
                  getItemLayout={(data, index) => ({
                    length: IMAGE_SIZE,
                    offset: IMAGE_SIZE * index,
                    index,
                  })}
                  style={styles.carouselList}
                />

                {/* Slide Counter */}
                <View style={styles.slideCounter}>
                  <Text style={styles.slideCounterText}>
                    {activeSlide + 1} / {imageList.length}
                  </Text>
                </View>

                {/* Dot Indicators */}
                <View style={styles.dotsContainer}>
                  {imageList.map((_, index) => (
                    <TouchableOpacity
                      key={index}
                      onPress={() => {
                        carouselRef.current?.scrollToIndex({ index, animated: true });
                        setActiveSlide(index);
                      }}
                    >
                      <View
                        style={[
                          styles.dot,
                          index === activeSlide && styles.dotActive,
                        ]}
                      />
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Slide Role Label */}
                {imageList[activeSlide] && (
                  <View style={styles.slideRoleContainer}>
                    <Text style={styles.slideRoleText}>
                      Slide {imageList[activeSlide].slideNumber}
                      {imageList[activeSlide].slideRole ? ` \u2014 ${imageList[activeSlide].slideRole}` : ''}
                    </Text>
                  </View>
                )}
              </>
            ) : (
              <Image
                source={{ uri: imageList[0].url }}
                style={styles.heroImage}
                resizeMode="cover"
              />
            )}
          </View>
        )}

        {/* Status & Platform Row */}
        <View style={styles.metaRow}>
          <PlatformIcon platform={post.platform} size={18} showLabel />
          <StatusBadge status={post.status} />
        </View>

        {/* Headline */}
        {post.headline && (
          <Text style={styles.headline}>{post.headline}</Text>
        )}

        {/* Subtext */}
        {post.subtext && (
          <Text style={styles.subtext}>{post.subtext}</Text>
        )}

        {/* Caption */}
        <Card style={{ marginTop: spacing.lg }}>
          <Text style={styles.sectionLabel}>Caption</Text>
          <Text style={styles.captionText}>{post.post_copy || 'No caption provided'}</Text>
        </Card>

        {/* Carousel Slides Summary */}
        {slides.length > 0 && (
          <Card>
            <Text style={styles.sectionLabel}>Carousel Slides</Text>
            {slides.map((slide, i) => (
              <TouchableOpacity
                key={slide.slide_number}
                style={[styles.slideRow, i > 0 && styles.slideRowBorder]}
                activeOpacity={0.6}
                onPress={() => {
                  if (hasCarousel && carouselRef.current) {
                    carouselRef.current.scrollToIndex({ index: i, animated: true });
                    setActiveSlide(i);
                  }
                }}
              >
                <View style={styles.slideNumberBadge}>
                  <Text style={styles.slideNumberText}>{slide.slide_number}</Text>
                </View>
                <View style={styles.slideInfo}>
                  <Text style={styles.slideRole}>{(slide.role || '').toUpperCase()}</Text>
                  <Text style={styles.slideHeadline} numberOfLines={2}>{slide.headline}</Text>
                  {slide.body ? (
                    <Text style={styles.slideBody} numberOfLines={2}>{slide.body}</Text>
                  ) : null}
                </View>
                <Ionicons name="image-outline" size={16} color={colors.gray300} />
              </TouchableOpacity>
            ))}
          </Card>
        )}

        {/* Hook & CTA */}
        {(post.hook || post.cta) && !slides.length && (
          <Card>
            {post.hook && (
              <View style={styles.detailBlock}>
                <Text style={styles.detailLabel}>Hook</Text>
                <Text style={styles.detailValue}>{post.hook}</Text>
              </View>
            )}
            {post.cta && (
              <View style={[styles.detailBlock, post.hook && styles.detailBlockBorder]}>
                <Text style={styles.detailLabel}>Call to Action</Text>
                <Text style={styles.detailValue}>{post.cta}</Text>
              </View>
            )}
          </Card>
        )}

        {/* Details */}
        <Card>
          <Text style={styles.sectionLabel}>Details</Text>
          {[
            { label: 'Type', value: post.content_type },
            { label: 'Best Time', value: post.best_time },
            { label: 'Goal', value: post.goal },
            { label: 'Created', value: post.created_at && new Date(post.created_at).toLocaleString() },
            { label: 'Approved', value: post.approved_at && new Date(post.approved_at).toLocaleString() },
            { label: 'Posted', value: post.posted_at && new Date(post.posted_at).toLocaleString() },
          ].filter(r => r.value).map((row, i) => (
            <View key={row.label} style={[styles.infoRow, i === 0 && styles.infoRowFirst]}>
              <Text style={styles.infoLabel}>{row.label}</Text>
              <Text style={styles.infoValue}>{row.value}</Text>
            </View>
          ))}
        </Card>

        {/* View Published Post Link */}
        {post.published_url && (
          <TouchableOpacity
            style={styles.viewPostButton}
            activeOpacity={0.7}
            onPress={() => Linking.openURL(post.published_url)}
          >
            <Ionicons name="open-outline" size={18} color={colors.white} />
            <Text style={styles.viewPostText}>View Published Post</Text>
          </TouchableOpacity>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Action Buttons (only for drafts) */}
      {post.status === 'draft' && (
        <View style={[styles.actionBar, shadows.lg]}>
          <TouchableOpacity
            style={styles.rejectButton}
            onPress={handleReject}
            disabled={acting}
            activeOpacity={0.7}
          >
            <Text style={styles.rejectButtonText}>Reject</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.approveButton}
            onPress={handleApprove}
            disabled={acting}
            activeOpacity={0.7}
          >
            {acting ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Text style={styles.approveButtonText}>Approve</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },

  // ─── Carousel ─────────────────────────────
  carouselContainer: {
    marginBottom: spacing.lg,
  },
  carouselList: {
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
  },
  carouselSlide: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
  },
  heroImage: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
    borderRadius: borderRadius.xl,
  },
  slideCounter: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full || 20,
  },
  slideCounterText: {
    color: '#fff',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.5,
  },
  dotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.gray200 || '#D1D5DB',
  },
  dotActive: {
    backgroundColor: colors.brand,
    width: 24,
    borderRadius: 4,
  },
  slideRoleContainer: {
    alignItems: 'center',
    marginTop: spacing.xs + 2,
  },
  slideRoleText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: colors.gray500,
    textTransform: 'capitalize',
  },

  // ─── Content ──────────────────────────────
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  headline: {
    fontSize: fontSize.xl + 2,
    fontWeight: fontWeight.bold,
    color: colors.navy,
    lineHeight: 32,
    letterSpacing: -0.5,
  },
  subtext: {
    fontSize: fontSize.base,
    color: colors.gray600,
    marginTop: spacing.sm,
    lineHeight: 23,
  },
  sectionLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.gray400,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm + 2,
  },
  captionText: {
    fontSize: fontSize.base,
    color: colors.gray700,
    lineHeight: 24,
  },

  // ─── Slide Summary List ───────────────────
  slideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    gap: spacing.sm + 2,
  },
  slideRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray150,
  },
  slideNumberBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.gray100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slideNumberText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.gray600,
  },
  slideInfo: {
    flex: 1,
  },
  slideRole: {
    fontSize: 10,
    fontWeight: fontWeight.semibold,
    color: colors.brand,
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  slideHeadline: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.navy,
    lineHeight: 19,
  },
  slideBody: {
    fontSize: fontSize.xs,
    color: colors.gray500,
    lineHeight: 16,
    marginTop: 2,
  },

  // ─── Detail Blocks ────────────────────────
  detailBlock: {
    paddingVertical: spacing.sm,
  },
  detailBlockBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray150,
    marginTop: spacing.sm,
    paddingTop: spacing.md,
  },
  detailLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.gray400,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.xs + 2,
  },
  detailValue: {
    fontSize: fontSize.base,
    color: colors.gray700,
    lineHeight: 22,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray150,
  },
  infoRowFirst: {
    borderTopWidth: 0,
    paddingTop: 0,
  },
  infoLabel: {
    fontSize: fontSize.sm,
    color: colors.gray500,
    fontWeight: fontWeight.medium,
  },
  infoValue: {
    fontSize: fontSize.sm,
    color: colors.gray800,
    fontWeight: fontWeight.medium,
    textAlign: 'right',
    flex: 1,
    marginLeft: spacing.lg,
  },

  // ─── Action Bar ───────────────────────────
  actionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl + spacing.md,
    backgroundColor: colors.white,
    gap: spacing.md,
  },
  approveButton: {
    flex: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.brand,
  },
  rejectButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.gray100,
  },
  approveButtonText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.2,
  },
  rejectButtonText: {
    color: colors.gray600,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  viewPostButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  viewPostText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  errorText: {
    fontSize: fontSize.base,
    color: colors.gray500,
  },
});
