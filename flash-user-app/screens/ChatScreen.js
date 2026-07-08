import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput,
  Pressable, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRoute } from '@react-navigation/native';
import { io } from 'socket.io-client';
import { BASE_URL, getToken } from '../services/api';
import api from '../services/api';
import { useFlash } from '../context/FlashContext';

export default function ChatScreen() {
  const route          = useRoute();
  const { orderId }    = route.params || {};
  const { user }       = useFlash();

  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState('');
  const [loading, setLoading]     = useState(true);
  const [sending, setSending]     = useState(false);
  const [connected, setConnected] = useState(false);
  const listRef                   = useRef(null);
  const socketRef                 = useRef(null);

  // ── Load history + connect socket ─────────────────────────────────────────
  useEffect(() => {
    if (!orderId) return;

    const init = async () => {
      // 1. Load message history
      try {
        const data = await api.messages.getMessages(orderId);
        setMessages(data.messages || []);
      } catch (e) {
        Alert.alert('Error', 'Could not load messages');
      } finally {
        setLoading(false);
      }

      // 2. Connect Socket.io for real-time messages
      const token = await getToken();
      if (!token) return;

      const socket = io(BASE_URL, { auth: { token }, transports: ['websocket'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        setConnected(true);
        socket.emit('track_order', { orderId }); // join the order room
      });

      socket.on('disconnect', () => setConnected(false));

      // New message arrives from the driver
      socket.on('new_message', (data) => {
        if (data.orderId === orderId) {
          setMessages(prev => {
            // Deduplicate by id
            const exists = prev.some(m => m.id === data.message.id);
            return exists ? prev : [...prev, data.message];
          });
        }
      });
    };

    init();

    return () => {
      if (socketRef.current) {
        socketRef.current.emit('stop_tracking', { orderId });
        socketRef.current.disconnect();
      }
    };
  }, [orderId]);

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

    // Optimistic local add
    const tempMsg = {
      id:          `temp_${Date.now()}`,
      sender_id:   user?.id,
      sender_role: 'user',
      content:     text,
      created_at:  new Date().toISOString(),
      pending:     true,
    };
    setMessages(prev => [...prev, tempMsg]);

    try {
      const data = await api.messages.sendMessage(orderId, text);
      // Replace temp with confirmed message
      setMessages(prev =>
        prev.map(m => m.id === tempMsg.id ? data.message : m)
      );
    } catch (e) {
      // Remove temp message on failure
      setMessages(prev => prev.filter(m => m.id !== tempMsg.id));
      Alert.alert('Failed', 'Message not sent. Please try again.');
      setInput(text); // restore input
    } finally {
      setSending(false);
    }
  }, [input, sending, orderId, user]);

  const renderMessage = ({ item: msg }) => {
    const isMe = msg.sender_role === 'user';
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
              <Ionicons name="time-outline" size={11} color="rgba(255,255,255,0.6)" />
            )}
            {isMe && !msg.pending && (
              <Ionicons name="checkmark-done" size={11} color="rgba(255,255,255,0.8)" />
            )}
          </View>
        </View>
      </View>
    );
  };

  if (loading) {
    return <View style={s.center}><ActivityIndicator size="large" color="#0a0a0a" /></View>;
  }

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      {/* Header info */}
      <View style={s.header}>
        <View style={[s.dot, { backgroundColor: connected ? '#10b981' : '#9ca3af' }]} />
        <Text style={s.headerText}>
          {connected ? 'Connected — messages are live' : 'Connecting...'}
        </Text>
      </View>

      {/* Messages list */}
      {messages.length === 0 ? (
        <View style={s.empty}>
          <Ionicons name="chatbubbles-outline" size={40} color="#d1d5db" />
          <Text style={s.emptyTitle}>No messages yet</Text>
          <Text style={s.emptyText}>Send a message to your driver</Text>
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
          placeholder="Message your driver..."
          placeholderTextColor="#9ca3af"
          value={input}
          onChangeText={setInput}
          multiline
          maxLength={500}
          onSubmitEditing={handleSend}
          returnKeyType="send"
        />
        <Pressable
          style={[s.sendBtn, (!input.trim() || sending) && s.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || sending}
        >
          {sending
            ? <ActivityIndicator size="small" color="#fff" />
            : <Ionicons name="send" size={18} color="#fff" />
          }
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7f7' },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header:    { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, paddingHorizontal: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  dot:       { width: 8, height: 8, borderRadius: 4 },
  headerText:{ color: '#6b7280', fontSize: 12, fontWeight: '500' },
  list:      { padding: 16, gap: 8, paddingBottom: 8 },
  msgRow:    { flexDirection: 'row' },
  msgRowMe:  { justifyContent: 'flex-end' },
  msgRowThem:{ justifyContent: 'flex-start' },
  bubble:    { maxWidth: '78%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, gap: 4 },
  bubbleMe:  { backgroundColor: '#0a0a0a', borderBottomRightRadius: 4 },
  bubbleThem:{ backgroundColor: '#fff', borderBottomLeftRadius: 4, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 1 },
  bubblePending: { opacity: 0.7 },
  msgText:   { fontSize: 15, lineHeight: 21 },
  msgTextMe: { color: '#fff' },
  msgTextThem:{ color: '#111827' },
  msgMeta:   { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end' },
  msgTime:   { fontSize: 10 },
  msgTimeMe: { color: 'rgba(255,255,255,0.6)' },
  msgTimeThem:{ color: '#9ca3af' },
  empty:     { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyTitle:{ fontSize: 16, fontWeight: '600', color: '#374151' },
  emptyText: { fontSize: 13, color: '#9ca3af' },
  inputBar:  { flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: 12, paddingHorizontal: 16, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  textInput: { flex: 1, maxHeight: 100, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: '#111827', backgroundColor: '#f9fafb' },
  sendBtn:   { width: 44, height: 44, borderRadius: 22, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: '#d1d5db' },
});
