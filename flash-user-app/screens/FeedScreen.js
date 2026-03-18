import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Image, TextInput, Alert, ActivityIndicator, RefreshControl,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useFlash } from '../context/FlashContext';

export default function FeedScreen({ navigation }) {
  const { user } = useFlash();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [commentInputs, setCommentInputs] = useState({});
  const [expandedComments, setExpandedComments] = useState({});
  const [comments, setComments] = useState({});

  const loadPosts = useCallback(async (pageNum = 1, append = false) => {
    try {
      const data = await api.feed.getPosts(pageNum);
      if (append) {
        setPosts(prev => [...prev, ...data.posts]);
      } else {
        setPosts(data.posts);
      }
      setHasMore(data.hasMore);
      setPage(pageNum);
    } catch (e) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => { loadPosts(); }, [loadPosts]);

  const onRefresh = () => { setRefreshing(true); loadPosts(1, false); };

  const loadMore = () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    loadPosts(page + 1, true);
  };

  const handleLike = async (postId) => {
    try {
      const data = await api.feed.likePost(postId);
      setPosts(prev => prev.map(p => p.id === postId
        ? { ...p, liked_by_me: data.liked, likes_count: data.liked ? p.likes_count + 1 : p.likes_count - 1 }
        : p
      ));
    } catch (e) {
      console.warn(e.message);
    }
  };

  const toggleComments = async (postId) => {
    const isExpanded = expandedComments[postId];
    setExpandedComments(prev => ({ ...prev, [postId]: !isExpanded }));
    if (!isExpanded && !comments[postId]) {
      try {
        const data = await api.feed.getComments(postId);
        setComments(prev => ({ ...prev, [postId]: data.comments }));
      } catch (e) {}
    }
  };

  const handleComment = async (postId) => {
    const content = commentInputs[postId]?.trim();
    if (!content) return;
    try {
      const data = await api.feed.addComment(postId, content);
      setComments(prev => ({ ...prev, [postId]: [...(prev[postId] || []), data.comment] }));
      setCommentInputs(prev => ({ ...prev, [postId]: '' }));
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, comments_count: p.comments_count + 1 } : p));
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  const handleTaggedProduct = (product) => {
    Alert.alert(
      product.product_name,
      `R${parseFloat(product.price || 0).toFixed(2)}\n\nAdd to cart?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'View Product', onPress: () => navigation.navigate('Home') },
      ]
    );
  };

  const renderPost = ({ item: post }) => (
    <View style={styles.postCard}>
      {/* Author */}
      <View style={styles.postHeader}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{post.user_name?.[0]?.toUpperCase() || '?'}</Text>
        </View>
        <View>
          <Text style={styles.authorName}>{post.user_name}</Text>
          <Text style={styles.postTime}>
            {new Date(post.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}
          </Text>
        </View>
        {post.user_id === user?.id && (
          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={() => Alert.alert('Delete Post', 'Remove this post?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: async () => {
                try {
                  await api.feed.deletePost(post.id);
                  setPosts(prev => prev.filter(p => p.id !== post.id));
                } catch (e) {}
              }},
            ])}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color="#9ca3af" />
          </TouchableOpacity>
        )}
      </View>

      {/* Image */}
      <View style={styles.imageContainer}>
        <Image source={{ uri: post.image_url }} style={styles.postImage} resizeMode="cover" />

        {/* Tagged product dots */}
        {post.tagged_products?.map((product, i) => (
          <TouchableOpacity
            key={i}
            style={[styles.productDot, { left: `${(product.tap_x || 0.5) * 100}%`, top: `${(product.tap_y || 0.5) * 100}%` }]}
            onPress={() => handleTaggedProduct(product)}
          >
            <Ionicons name="bag" size={12} color="#fff" />
          </TouchableOpacity>
        ))}
      </View>

      {/* Caption */}
      {post.caption && <Text style={styles.caption}>{post.caption}</Text>}

      {/* Tagged products list */}
      {post.tagged_products?.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.taggedRow}>
          {post.tagged_products.map((p, i) => (
            <TouchableOpacity key={i} style={styles.taggedChip} onPress={() => handleTaggedProduct(p)}>
              <Ionicons name="bag-outline" size={12} color="#0a0a0a" />
              <Text style={styles.taggedName} numberOfLines={1}>{p.product_name}</Text>
              <Text style={styles.taggedPrice}>R{parseFloat(p.price || 0).toFixed(0)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => handleLike(post.id)}>
          <Ionicons
            name={post.liked_by_me ? 'heart' : 'heart-outline'}
            size={22}
            color={post.liked_by_me ? '#ef4444' : '#374151'}
          />
          <Text style={styles.actionCount}>{post.likes_count}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={() => toggleComments(post.id)}>
          <Ionicons name="chatbubble-outline" size={20} color="#374151" />
          <Text style={styles.actionCount}>{post.comments_count}</Text>
        </TouchableOpacity>
      </View>

      {/* Comments */}
      {expandedComments[post.id] && (
        <View style={styles.commentsSection}>
          {(comments[post.id] || []).map(c => (
            <View key={c.id} style={styles.commentRow}>
              <Text style={styles.commentAuthor}>{c.user_name}</Text>
              <Text style={styles.commentText}>{c.content}</Text>
            </View>
          ))}
          <View style={styles.commentInput}>
            <TextInput
              style={styles.commentField}
              placeholder="Add a comment..."
              placeholderTextColor="#9ca3af"
              value={commentInputs[post.id] || ''}
              onChangeText={t => setCommentInputs(prev => ({ ...prev, [post.id]: t }))}
              onSubmitEditing={() => handleComment(post.id)}
            />
            <TouchableOpacity onPress={() => handleComment(post.id)}>
              <Ionicons name="send" size={18} color="#0a0a0a" />
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );

  if (loading) return <View style={styles.loading}><ActivityIndicator size="large" color="#0a0a0a" /></View>;

  return (
    <View style={styles.container}>
      <FlatList
        data={posts}
        renderItem={renderPost}
        keyExtractor={item => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListHeaderComponent={
          <TouchableOpacity style={styles.createPostBtn} onPress={() => Alert.alert('Coming Soon', 'Post upload will use camera/gallery — implementation requires expo-image-picker')}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{user?.name?.[0]?.toUpperCase() || '?'}</Text></View>
            <Text style={styles.createPostText}>Share your Flash fit...</Text>
            <Ionicons name="image-outline" size={22} color="#9ca3af" />
          </TouchableOpacity>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="images-outline" size={40} color="#d1d5db" />
            <Text style={styles.emptyTitle}>No posts yet</Text>
            <Text style={styles.emptySubtitle}>Be the first to share a Flash fit</Text>
          </View>
        }
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ padding: 16 }} color="#0a0a0a" /> : null}
      />
    </View>
  );
}

// Need ScrollView import for tagged chips
import { ScrollView } from 'react-native';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  createPostBtn: { backgroundColor: '#fff', margin: 12, borderRadius: 16, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, elevation: 2 },
  createPostText: { flex: 1, color: '#9ca3af', fontSize: 14 },
  postCard: { backgroundColor: '#fff', marginHorizontal: 12, marginBottom: 16, borderRadius: 20, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 },
  postHeader: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10 },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  authorName: { color: '#111827', fontWeight: '700', fontSize: 14 },
  postTime: { color: '#9ca3af', fontSize: 11 },
  deleteBtn: { marginLeft: 'auto', padding: 4 },
  imageContainer: { width: '100%', aspectRatio: 1, position: 'relative' },
  postImage: { width: '100%', height: '100%' },
  productDot: { position: 'absolute', width: 28, height: 28, borderRadius: 14, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center', marginLeft: -14, marginTop: -14, borderWidth: 2, borderColor: '#fff' },
  caption: { color: '#374151', fontSize: 14, lineHeight: 20, padding: 14, paddingTop: 10, paddingBottom: 6 },
  taggedRow: { paddingLeft: 14, paddingBottom: 10 },
  taggedChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#f3f4f6', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8 },
  taggedName: { color: '#111827', fontSize: 12, fontWeight: '600', maxWidth: 100 },
  taggedPrice: { color: '#6b7280', fontSize: 11 },
  actions: { flexDirection: 'row', padding: 14, paddingTop: 8, gap: 20 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionCount: { color: '#374151', fontSize: 14, fontWeight: '600' },
  commentsSection: { padding: 14, paddingTop: 0, borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  commentRow: { marginBottom: 8 },
  commentAuthor: { color: '#111827', fontWeight: '700', fontSize: 12 },
  commentText: { color: '#374151', fontSize: 13, marginTop: 2 },
  commentInput: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#f3f4f6', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginTop: 8 },
  commentField: { flex: 1, fontSize: 14, color: '#111827' },
  empty: { alignItems: 'center', padding: 40, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#374151' },
  emptySubtitle: { fontSize: 13, color: '#9ca3af' },
});
