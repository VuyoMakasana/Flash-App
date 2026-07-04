import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView,
  Alert, ActivityIndicator
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import driverApi from '../../services/api';
import { useDriver } from '../../context/DriverContext';

const REQUIRED_DOCS = [
  {
    id: 'government_id',
    label: 'Government ID / Passport',
    description: 'Clear photo of your ID or passport',
    icon: 'id-card-outline',
  },
  {
    id: 'drivers_license',
    label: "Driver's License",
    description: 'Valid South African driver\'s license',
    icon: 'car-outline',
  },
  {
    id: 'police_certified',
    label: 'Police Certified Documents',
    description: 'Documents stamped and certified at a police station',
    icon: 'shield-outline',
    important: true,
  },
  {
    id: 'profile_photo',
    label: 'Profile Photo',
    description: 'Clear photo of your face (no sunglasses)',
    icon: 'camera-outline',
  },
  {
    id: 'vehicle_registration',
    label: 'Vehicle Registration',
    description: 'Current vehicle registration papers',
    icon: 'document-outline',
  },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const { driver, refreshProfile } = useDriver();
  const [uploadedDocs, setUploadedDocs] = useState([]);
  const [uploading, setUploading] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDocumentStatus();
  }, []);

  const loadDocumentStatus = async () => {
    try {
      const data = await driverApi.driver.getProfile();
      setUploadedDocs(data.documents?.map(d => d.document_type) || []);
    } catch (_e) {
      // Use local state if API fails
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async (docType) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.length) return;

      const file = result.assets[0];
      setUploading(docType);

      const formData = new FormData();
      formData.append('document_type', docType);
      formData.append('document', {
        uri:  file.uri,
        name: file.name,
        type: file.mimeType || 'application/pdf',
      });
      await driverApi.driver.uploadDocument(formData);

      setUploadedDocs(prev => [...prev.filter(d => d !== docType), docType]);

      const allDone = REQUIRED_DOCS.every(d =>
        [...uploadedDocs.filter(ud => ud !== docType), docType].includes(d.id)
      );

      if (allDone) {
        Alert.alert(
          ' All Documents Uploaded!',
          'Your application is now under review. You will receive a notification once approved. This usually takes 1-2 business days.',
          [{ text: 'OK' }]
        );
        await refreshProfile();
      } else {
        Alert.alert('Uploaded!', `${REQUIRED_DOCS.find(d => d.id === docType)?.label} uploaded successfully.`);
      }
    } catch (err) {
      Alert.alert('Upload Failed', err.message || 'Could not upload document.');
    } finally {
      setUploading(null);
    }
  };

  const allUploaded = REQUIRED_DOCS.every(d => uploadedDocs.includes(d.id));
  const progress = REQUIRED_DOCS.filter(d => uploadedDocs.includes(d.id)).length;

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#fff" size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.headerCard}>
        <Ionicons name="shield-checkmark" size={32} color="#fff" />
        <Text style={styles.headerTitle}>Driver Verification</Text>
        <Text style={styles.headerSubtitle}>
          Upload all required documents to activate your account.
          All documents are securely stored and encrypted.
        </Text>

        {/* Progress */}
        <View style={styles.progressRow}>
          <Text style={styles.progressLabel}>{progress} of {REQUIRED_DOCS.length} uploaded</Text>
          <Text style={styles.progressPct}>{Math.round((progress / REQUIRED_DOCS.length) * 100)}%</Text>
        </View>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${(progress / REQUIRED_DOCS.length) * 100}%` }]} />
        </View>
      </View>

      {/* Status banner */}
      {driver?.status && driver.status !== 'pending_documents' && (
        <View style={[styles.statusBanner, {
          backgroundColor: driver.status === 'approved' ? '#dcfce7' : '#fef3c7'
        }]}>
          <Ionicons
            name={driver.status === 'approved' ? 'checkmark-circle' : 'time-outline'}
            size={18}
            color={driver.status === 'approved' ? '#16a34a' : '#d97706'}
          />
          <Text style={[styles.statusText, { color: driver.status === 'approved' ? '#15803d' : '#92400e' }]}>
            {driver.status === 'approved' && 'Account approved! You can now accept deliveries.'}
            {driver.status === 'documents_submitted' && 'Documents submitted. Under review (1-2 business days).'}
            {driver.status === 'under_review' && 'Your application is being reviewed by our team.'}
            {driver.status === 'rejected' && 'Application not approved. Contact support@flash.co.za'}
          </Text>
        </View>
      )}

      {/* Police certified notice */}
      <View style={styles.policeNotice}>
        <Ionicons name="information-circle-outline" size={18} color="#3b82f6" />
        <Text style={styles.policeNoticeText}>
          <Text style={{ fontWeight: '800' }}>Important: </Text>
          Your documents must be certified and stamped at a police station. Uncertified documents will be rejected.
        </Text>
      </View>

      {/* Documents list */}
      {REQUIRED_DOCS.map(doc => {
        const uploaded = uploadedDocs.includes(doc.id);
        const isUploading = uploading === doc.id;

        return (
          <View key={doc.id} style={[styles.docCard, uploaded && styles.docCardDone]}>
            <View style={[styles.docIcon, uploaded && styles.docIconDone]}>
              <Ionicons name={uploaded ? 'checkmark' : doc.icon} size={22} color={uploaded ? '#16a34a' : '#374151'} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.docHeader}>
                <Text style={[styles.docLabel, uploaded && styles.docLabelDone]}>{doc.label}</Text>
                {doc.important && <View style={styles.importantBadge}><Text style={styles.importantText}>Required</Text></View>}
              </View>
              <Text style={styles.docDesc}>{doc.description}</Text>
            </View>
            <Pressable
              style={[styles.uploadBtn, uploaded && styles.uploadBtnDone, isUploading && styles.uploadBtnLoading]}
              onPress={() => handleUpload(doc.id)}
              disabled={isUploading}
            >
              {isUploading
                ? <ActivityIndicator color="#fff" size="small" />
                : <Ionicons name={uploaded ? 'refresh-outline' : 'cloud-upload-outline'} size={18} color="#fff" />
              }
            </Pressable>
          </View>
        );
      })}

      {allUploaded && (
        <View style={styles.allDoneCard}>
          <Ionicons name="checkmark-circle" size={28} color="#16a34a" />
          <Text style={styles.allDoneTitle}>All documents submitted!</Text>
          <Text style={styles.allDoneText}>Our team will review your application within 1-2 business days.</Text>
        </View>
      )}

      <Pressable onPress={() => router.replace('/auth/login')} style={styles.backLink}>
        <Text style={styles.backLinkText}>← Back to Sign In</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 16, gap: 14, paddingTop: 56, paddingBottom: 40 },
  loadingContainer: { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
  headerCard: { backgroundColor: '#111827', borderRadius: 20, padding: 20, gap: 10 },
  headerTitle: { color: '#fff', fontSize: 22, fontWeight: '900' },
  headerSubtitle: { color: '#9ca3af', lineHeight: 20 },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progressLabel: { color: '#d1d5db', fontWeight: '600' },
  progressPct: { color: '#60a5fa', fontWeight: '700' },
  progressBar: { height: 6, backgroundColor: '#374151', borderRadius: 3 },
  progressFill: { height: 6, backgroundColor: '#60a5fa', borderRadius: 3 },
  statusBanner: { borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  statusText: { flex: 1, fontWeight: '600', lineHeight: 18 },
  policeNotice: { backgroundColor: '#eff6ff', borderRadius: 14, padding: 14, flexDirection: 'row', gap: 10 },
  policeNoticeText: { color: '#1d4ed8', flex: 1, lineHeight: 18, fontSize: 13 },
  docCard: { backgroundColor: '#1f2937', borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#374151' },
  docCardDone: { borderColor: '#166534', backgroundColor: '#052e16' },
  docIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#374151', alignItems: 'center', justifyContent: 'center' },
  docIconDone: { backgroundColor: '#14532d' },
  docHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  docLabel: { color: '#f9fafb', fontWeight: '700' },
  docLabelDone: { color: '#86efac' },
  docDesc: { color: '#9ca3af', fontSize: 12 },
  importantBadge: { backgroundColor: '#7c3aed', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  importantText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  uploadBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#3b82f6', alignItems: 'center', justifyContent: 'center' },
  uploadBtnDone: { backgroundColor: '#16a34a' },
  uploadBtnLoading: { backgroundColor: '#6b7280' },
  allDoneCard: { backgroundColor: '#dcfce7', borderRadius: 16, padding: 20, alignItems: 'center', gap: 8 },
  allDoneTitle: { color: '#15803d', fontWeight: '800', fontSize: 16 },
  allDoneText: { color: '#166534', textAlign: 'center' },
  backLink: { alignItems: 'center', paddingVertical: 8 },
  backLinkText: { color: '#9ca3af', fontWeight: '600' },
});
