/**
 * flash-driver-app/app/driver/chat.js
 *
 * Order chat, driver side. Mirrors flash-user-app/screens/ChatScreen.js
 * against the same backend (real `messages` table + Socket.IO room —
 * see backend/src/models/Message.js, backend/src/socket/socketServer.js).
 *
 * Joins via 'join_order_chat', not 'track_order' — 'track_order' is
 * hard-restricted to socket.userRole === 'user' server-side
 * (socketServer.js:162-171) and would silently no-op for a driver.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { io } from 'socket.io-client';
import driverApi, { BASE_URL } from '../../services/api';
import { useDriver } from '../../context/DriverContext';

export default function DriverChat() {
  const router          = useRouter();
  const { orderId }     = useLocalSearchParams();
  const { driver, token } = useDriver();

  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState('');
  const [loading, setLoading]     = useState(true);
  const [sending, setSending]     = useState(false);
  const [connected, setConnected] = useState(false);
  const listRef   = useRef(null);
  const socketRef = useRef(null);

  // ── Load history + connect socket ─────────────────────────────────────────
  useEffect(() => {
    if (!orderId || !token) return;

    let cancelled = false;

    const init = async () => {
      try {
        const data = await driverApi.messages.getMessages(orderId);
        if (!cancelled) setMessages(data.messages || []);
      } catch (_e) {
        if (!cancelled) Alert.alert('Error', 'Could not load messages');
      } finally {
        if (!cancelled) setLoading(false);
      }

      const socket = io(BASE_URL, { auth: { token }, transports: ['websocket'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        setConnected(true);
        socket.emit('join_order_chat', { orderId });
      });

      socket.on('disconnect', () => setConnected(false));

      socket.on('new_message', (data) => {
        if (data.orderId === orderId) {
          setMessages(prev => {
            const exists = prev.some(m => m.id === data.message.id);
            return exists ? prev : [...prev, data.message];
          });
        }
      });
    };

    init();

    return () => {
      cancelled = true;
      if (socketRef.current) {
        socketRef.current.emit('leave_order_chat', { orderId });
        socketRef.current.disconnect();
      }
    };
  }, [orderId, token]);

  // ── Auto-scroll to latest ──────────────────────────────────────────────────
  useEffect(() => {
    if (messages.length && listRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setInput('');

    const tempMsg = {
      id:          `temp_${Date.now()}`,
      sender_id:   driver?.id,
      sender_role: 'driver',
      content:     text,
      created_at:  new Date().toISOString(),
      pending:     true,
    };
    setMessages(prev => [...prev, tempMsg]);

    try {
      const data = await driverApi.messages.sendMessage(orderId, text);
      setMessages(prev =>
        prev.map(m => m.id === tempMsg.id ? data.message : m)
      );
    } catch (_e) {
      setMessages(prev => prev.filter(m => m.id !== tempMsg.id));
      Alert.alert('Failed', 'Message not sent. Please try again.');
      setInput(text);
    } finally {
      setSending(false);
    }
  }, [input, sending, orderId, driver]);

  const renderMessage = ({ item: msg }) => {
    const isMe = msg.sender_role === 'driver';
    return (
      <View style={[s.msgRow, isMe ? s.msgRowMe : s.msgRowThem]}>
        <View style={[s.bubble, isMe ? s.bubbleMe : s.bubbleThem, msg.pending && s.bubblePending]}>
          <Text style={[s.msgText, isMe ? s.msgTextMe : s.msgTextThem]}>
            {msg.content}
          </Text>
          <View style={s.msgMeta}>
            <Text style={[s.msgTime, isMe ? s.msgTimeMe : s.msgTimeThem]}>
              {new Date(msg.created_at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}
            </Text>
            {isMe && msg.pending && (
              <Ionicons name="time-outline" size={11} color="rgba(10,10,10,0.6)" />
            )}
            {isMe && !msg.pending && (
              <Ionicons name="checkmark-done" size={11} color="rgba(10,10,10,0.6)" />
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle}>Message Customer</Text>
          <View style={s.connectionRow}>
            <View style={[s.dot, { backgroundColor: connected ? '#10b981' : '#6b7280' }]} />
            <Text style={s.connectionText}>
              {connected ? 'Connected — messages are live' : 'Connecting...'}
            </Text>
          </View>
        </View>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color="#f59e0b" /></View>
      ) : messages.length === 0 ? (
        <View style={s.empty}>
          <Ionicons name="chatbubbles-outline" size={40} color="#374151" />
          <Text style={s.emptyTitle}>No messages yet</Text>
          <Text style={s.emptyText}>Send a message to your customer</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={m => m.id}
          renderItem={renderMessage}
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Input bar */}
      <View style={s.inputBar}>
        <TextInput
          style={s.textInput}
          placeholder="Message your customer..."
          placeholderTextColor="#6b7280"
          value={input}
          onChangeText={setInput}
          multiline
          maxLength={500}
          onSubmitEditing={handleSend}
          returnKeyType="send"
        />
        <TouchableOpacity
          style={[s.sendBtn, (!input.trim() || sending) && s.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || sending}
        >
          {sending
            ? <ActivityIndicator size="small" color="#0a0a0a" />
            : <Ionicons name="send" size={18} color="#0a0a0a" />
          }
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container:  { flex: 1, backgroundColor: '#0a0a0a' },
  center:     { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, paddingTop: 60, borderBottomWidth: 1, borderBottomColor: '#1f2937' },
  backBtn:    { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { alignItems: 'center', gap: 4 },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  connectionRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot:        { width: 7, height: 7, borderRadius: 3.5 },
  connectionText: { color: '#9ca3af', fontSize: 11, fontWeight: '500' },
  list:       { padding: 16, gap: 8, paddingBottom: 8 },
  msgRow:     { flexDirection: 'row' },
  msgRowMe:   { justifyContent: 'flex-end' },
  msgRowThem: { justifyContent: 'flex-start' },
  bubble:     { maxWidth: '78%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, gap: 4 },
  bubbleMe:   { backgroundColor: '#f59e0b', borderBottomRightRadius: 4 },
  bubbleThem: { backgroundColor: '#1a1a1a', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#262626' },
  bubblePending: { opacity: 0.7 },
  msgText:    { fontSize: 15, lineHeight: 21 },
  msgTextMe:  { color: '#0a0a0a' },
  msgTextThem:{ color: '#f3f4f6' },
  msgMeta:    { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end' },
  msgTime:    { fontSize: 10 },
  msgTimeMe:  { color: 'rgba(10,10,10,0.6)' },
  msgTimeThem:{ color: '#6b7280' },
  empty:      { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#e5e7eb' },
  emptyText:  { fontSize: 13, color: '#6b7280' },
  inputBar:   { flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: 12, paddingHorizontal: 16, backgroundColor: '#0a0a0a', borderTopWidth: 1, borderTopColor: '#1f2937' },
  textInput:  { flex: 1, maxHeight: 100, borderWidth: 1, borderColor: '#374151', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: '#fff', backgroundColor: '#1a1a1a' },
  sendBtn:    { width: 44, height: 44, borderRadius: 22, backgroundColor: '#f59e0b', alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: '#374151' },
});
