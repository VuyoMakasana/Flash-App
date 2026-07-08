// NEW FILE: Driver bank account setup screen
// WHY: Driver payouts are now real Paystack transfers but drivers had no way to
// enter their bank account details through the app — they would have to contact
// the founder manually, which does not scale.

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, ActivityIndicator, ScrollView, FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import driverApi from '../../services/api';

export default function BankAccountScreen() {
  const router = useRouter();
  const [banks, setBanks] = useState([]);
  const [selectedBank, setSelectedBank] = useState(null);
  const [accountNumber, setAccountNumber] = useState('');
  const [password, setPassword] = useState('');
  const [verifiedName, setVerifiedName] = useState('');
  const [existingAccount, setExistingAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState('form'); // 'form' | 'verified' | 'done'
  const [bankSearch, setBankSearch] = useState('');
  const [showBankList, setShowBankList] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [bankRes, accountRes] = await Promise.allSettled([
        driverApi.bank.getBanks(),
        driverApi.bank.getAccount(),
      ]);
      if (bankRes.status === 'fulfilled') setBanks(bankRes.value.banks || []);
      if (accountRes.status === 'fulfilled' && accountRes.value.account) {
        setExistingAccount(accountRes.value.account);
      }
    } catch (e) {
      Alert.alert('Error', 'Could not load bank data. Check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!selectedBank) { Alert.alert('Select Bank', 'Please select your bank first.'); return; }
    if (accountNumber.length < 6) { Alert.alert('Invalid', 'Please enter a valid account number.'); return; }
    setVerifying(true);
    try {
      const res = await driverApi.bank.verifyAccount(accountNumber, selectedBank.code);
      if (res.verified && res.account_name) {
        setVerifiedName(res.account_name);
        setStep('verified');
      } else {
        Alert.alert('Not Found', 'Could not verify this account. Check the number and bank.');
      }
    } catch (e) {
      Alert.alert('Verification Failed', e.message || 'Could not verify account.');
    } finally {
      setVerifying(false);
    }
  };

  const handleSave = async () => {
    if (!password) { Alert.alert('Password Required', 'Enter your password to confirm this change.'); return; }
    setSaving(true);
    try {
      await driverApi.bank.saveAccount(accountNumber, selectedBank.code, verifiedName, password);
      setPassword('');
      setStep('done');
      setExistingAccount({ account_name: verifiedName, bank_name: selectedBank.name, account_number: accountNumber });
      Alert.alert('Bank Account Saved', 'You can now request payouts to this account.');
    } catch (e) {
      Alert.alert('Save Failed', e.message || 'Could not save bank account.');
    } finally {
      setSaving(false);
    }
  };

  const filteredBanks = banks.filter(b =>
    b.name.toLowerCase().includes(bankSearch.toLowerCase())
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#f59e0b" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Payout Account</Text>
        <View style={{ width: 36 }} />
      </View>

      {existingAccount && (
        <View style={styles.existingCard}>
          <Ionicons name="checkmark-circle" size={20} color="#10b981" />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.existingName}>{existingAccount.account_name}</Text>
            <Text style={styles.existingMeta}>{existingAccount.bank_name} • {existingAccount.account_number}</Text>
          </View>
          <Text style={styles.existingLabel}>Active</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.label}>Select Your Bank</Text>
        <TouchableOpacity style={styles.bankPicker} onPress={() => setShowBankList(!showBankList)}>
          <Text style={selectedBank ? styles.bankSelected : styles.bankPlaceholder}>
            {selectedBank ? selectedBank.name : 'Tap to select bank...'}
          </Text>
          <Ionicons name={showBankList ? 'chevron-up' : 'chevron-down'} size={18} color="#9ca3af" />
        </TouchableOpacity>

        {showBankList && (
          <View style={styles.bankListContainer}>
            <TextInput
              style={styles.bankSearch}
              placeholder="Search banks..."
              placeholderTextColor="#6b7280"
              value={bankSearch}
              onChangeText={setBankSearch}
            />
            <FlatList
              data={filteredBanks}
              keyExtractor={b => b.code}
              style={{ maxHeight: 200 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.bankItem}
                  onPress={() => { setSelectedBank(item); setShowBankList(false); setBankSearch(''); }}
                >
                  <Text style={styles.bankItemText}>{item.name}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        )}

        <Text style={[styles.label, { marginTop: 16 }]}>Account Number</Text>
        <TextInput
          style={styles.input}
          placeholder="Enter account number"
          placeholderTextColor="#6b7280"
          keyboardType="number-pad"
          value={accountNumber}
          onChangeText={setAccountNumber}
          maxLength={20}
        />

        {step === 'verified' && (
          <View style={styles.verifiedBox}>
            <Ionicons name="checkmark-circle" size={18} color="#10b981" />
            <Text style={styles.verifiedName}>{verifiedName}</Text>
          </View>
        )}

        {step === 'verified' && (
          <>
            <Text style={[styles.label, { marginTop: 16 }]}>Confirm Password</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your account password"
              placeholderTextColor="#6b7280"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
          </>
        )}

        {step === 'form' && (
          <TouchableOpacity
            style={[styles.btn, verifying && { opacity: 0.6 }]}
            onPress={handleVerify}
            disabled={verifying}
          >
            {verifying
              ? <ActivityIndicator color="#0a0a0a" />
              : <Text style={styles.btnText}>Verify Account</Text>
            }
          </TouchableOpacity>
        )}

        {step === 'verified' && (
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: '#10b981' }, saving && { opacity: 0.6 }]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator color="#fff" />
              : <Text style={[styles.btnText, { color: '#fff' }]}>Save & Activate</Text>
            }
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.note}>
        Your bank details are verified and stored securely. Flash uses Paystack to send payouts directly to your account.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { paddingBottom: 40 },
  center: { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, paddingTop: 60 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  existingCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0d2818', borderRadius: 14, padding: 14, marginHorizontal: 16, marginBottom: 16, borderWidth: 1, borderColor: '#10b981' },
  existingName: { color: '#fff', fontWeight: '700', fontSize: 14 },
  existingMeta: { color: '#9ca3af', fontSize: 12, marginTop: 2 },
  existingLabel: { color: '#10b981', fontWeight: '700', fontSize: 12 },
  card: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 16, marginHorizontal: 16, gap: 8 },
  label: { color: '#9ca3af', fontSize: 13, fontWeight: '600' },
  bankPicker: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#0a0a0a', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#374151' },
  bankSelected: { color: '#fff', fontWeight: '600' },
  bankPlaceholder: { color: '#6b7280' },
  bankListContainer: { backgroundColor: '#0a0a0a', borderRadius: 12, borderWidth: 1, borderColor: '#374151', overflow: 'hidden' },
  bankSearch: { padding: 12, color: '#fff', borderBottomWidth: 0.5, borderBottomColor: '#374151' },
  bankItem: { padding: 14, borderBottomWidth: 0.5, borderBottomColor: '#1a1a1a' },
  bankItemText: { color: '#fff', fontSize: 14 },
  input: { backgroundColor: '#0a0a0a', borderRadius: 12, padding: 14, color: '#fff', borderWidth: 1, borderColor: '#374151', fontSize: 16 },
  verifiedBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#0d2818', padding: 12, borderRadius: 10 },
  verifiedName: { color: '#10b981', fontWeight: '700' },
  btn: { backgroundColor: '#f59e0b', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  btnText: { fontWeight: '800', fontSize: 15, color: '#0a0a0a' },
  note: { color: '#6b7280', fontSize: 12, textAlign: 'center', marginHorizontal: 24, marginTop: 20, lineHeight: 18 },
});
