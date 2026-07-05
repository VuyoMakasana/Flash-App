import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useDriver } from '../../context/DriverContext';
import driverApi from '../../services/api';

const STATUS_INFO = {
  pending_documents: { label: 'Pending Documents', color: '#f59e0b', bg: '#fef3c7' },
  documents_submitted: { label: 'Under Review', color: '#3b82f6', bg: '#eff6ff' },
  under_review: { label: 'Under Review', color: '#8b5cf6', bg: '#f5f3ff' },
  approved: { label: 'Approved ', color: '#16a34a', bg: '#dcfce7' },
  rejected: { label: 'Rejected', color: '#dc2626', bg: '#fee2e2' },
  // Previously missing — a suspended driver's badge fell back to
  // STATUS_INFO.pending_documents, actively telling them the wrong thing.
  suspended: { label: 'Suspended', color: '#dc2626', bg: '#fee2e2' },
};

export default function DriverProfileScreen() {
  const router = useRouter();
  const { driver, refreshProfile, logout } = useDriver();
  const [form, setForm] = useState({ name: '', phone: '', vehicle_type: '', vehicle_plate: '' });
  const [saving, setSaving] = useState(false);
  const [documents, setDocuments] = useState([]);

  useEffect(() => {
    if (driver) {
      setForm({
        name: driver.name || '',
        phone: driver.phone || '',
        vehicle_type: driver.vehicle_type || '',
        vehicle_plate: driver.vehicle_plate || '',
      });
    }
    loadDocs();
  }, [driver]);

  const loadDocs = async () => {
    try {
      const data = await driverApi.driver.getProfile();
      setDocuments(data.documents || []);
    } catch (_e) {}
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await driverApi.driver.updateProfile(form);
      await refreshProfile();
      Alert.alert('Saved', 'Profile updated successfully.');
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const statusInfo = STATUS_INFO[driver?.status] || STATUS_INFO.pending_documents;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} style={styles.back}>
          <Ionicons name="arrow-back" size={20} color="#fff" />
        </Pressable>
        <Text style={styles.title}>Profile</Text>
        <Pressable onPress={logout} style={styles.logoutBtn}>
          <Ionicons name="log-out-outline" size={20} color="#9ca3af" />
        </Pressable>
      </View>

      {/* Avatar + Status */}
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Ionicons name="person" size={36} color="#fff" />
        </View>
        <Text style={styles.driverName}>{driver?.name || 'Driver'}</Text>
        <Text style={styles.driverEmail}>{driver?.email}</Text>
        <View style={[styles.statusBadge, { backgroundColor: statusInfo.bg }]}>
          <Text style={[styles.statusText, { color: statusInfo.color }]}>{statusInfo.label}</Text>
        </View>
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{driver?.rating || '5.0'}</Text>
            <Text style={styles.statLabel}>Rating</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.stat}>
            <Text style={styles.statValue}>{driver?.total_deliveries || '0'}</Text>
            <Text style={styles.statLabel}>Deliveries</Text>
          </View>
        </View>
      </View>

      {/* Edit form */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Personal Info</Text>
        {[
          { label: 'Full Name', key: 'name', icon: 'person-outline', caps: 'words' },
          { label: 'Phone', key: 'phone', icon: 'call-outline', keyboard: 'phone-pad' },
          { label: 'Vehicle Type', key: 'vehicle_type', icon: 'car-outline', caps: 'words' },
          { label: 'Vehicle Plate', key: 'vehicle_plate', icon: 'document-outline', caps: 'characters' },
        ].map(f => (
          <View style={styles.inputGroup} key={f.key}>
            <Text style={styles.inputLabel}>{f.label}</Text>
            <View style={styles.inputRow}>
              <Ionicons name={f.icon} size={16} color="#9ca3af" style={styles.icon} />
              <TextInput
                style={styles.input}
                value={form[f.key]}
                onChangeText={v => setForm(prev => ({ ...prev, [f.key]: v }))}
                placeholderTextColor="#9ca3af"
                keyboardType={f.keyboard || 'default'}
                autoCapitalize={f.caps || 'none'}
              />
            </View>
          </View>
        ))}

        <Pressable style={[styles.saveBtn, saving && styles.saveBtnDisabled]} onPress={handleSave} disabled={saving}>
          {saving
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.saveBtnText}>Save Changes</Text>
          }
        </Pressable>
      </View>

      {/* Documents status */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle}>Documents</Text>
          <Pressable onPress={() => router.push('/auth/onboarding')}>
            <Text style={styles.manageLink}>Manage →</Text>
          </Pressable>
        </View>
        {documents.length === 0
          ? <Text style={styles.noDocsText}>No documents uploaded yet</Text>
          : documents.map(doc => (
            <View key={doc.document_type} style={styles.docRow}>
              <Ionicons
                name={doc.verified ? 'checkmark-circle' : 'time-outline'}
                size={16}
                color={doc.verified ? '#16a34a' : '#f59e0b'}
              />
              <Text style={styles.docName}>{doc.document_type.replace(/_/g, ' ')}</Text>
              <Text style={[styles.docStatus, { color: doc.verified ? '#16a34a' : '#f59e0b' }]}>
                {doc.verified ? 'Verified' : 'Pending'}
              </Text>
            </View>
          ))
        }
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { paddingBottom: 40 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 56, paddingBottom: 16 },
  back: { padding: 4 },
  title: { color: '#fff', fontSize: 18, fontWeight: '800' },
  logoutBtn: { padding: 4 },
  profileCard: { backgroundColor: '#1e293b', margin: 16, borderRadius: 20, padding: 20, alignItems: 'center', gap: 8 },
  avatar: { width: 72, height: 72, borderRadius: 24, backgroundColor: '#334155', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  driverName: { color: '#f1f5f9', fontSize: 20, fontWeight: '800' },
  driverEmail: { color: '#64748b' },
  statusBadge: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, marginTop: 4 },
  statusText: { fontWeight: '700' },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 24, marginTop: 8 },
  stat: { alignItems: 'center' },
  statValue: { color: '#fff', fontSize: 20, fontWeight: '900' },
  statLabel: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  statDivider: { width: 1, height: 30, backgroundColor: '#334155' },
  card: { backgroundColor: '#1e293b', margin: 16, marginTop: 0, borderRadius: 18, padding: 18, gap: 12 },
  cardTitle: { color: '#f1f5f9', fontWeight: '800', fontSize: 16 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  manageLink: { color: '#60a5fa', fontWeight: '600' },
  inputGroup: { gap: 6 },
  inputLabel: { color: '#94a3b8', fontWeight: '600', fontSize: 13 },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0f172a', borderRadius: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: '#334155' },
  icon: { marginRight: 8 },
  input: { flex: 1, paddingVertical: 12, color: '#f1f5f9', fontSize: 15 },
  saveBtn: { backgroundColor: '#3b82f6', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#fff', fontWeight: '800' },
  docRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  docName: { flex: 1, color: '#cbd5e1', fontWeight: '600', textTransform: 'capitalize' },
  docStatus: { fontWeight: '700', fontSize: 12 },
  noDocsText: { color: '#64748b' },
});
