import React, { useState } from 'react';
import { ApiClient, useNotice } from 'adminjs';
import { Box, H3, Text, TextArea, Label, Button } from '@adminjs/design-system';

// L0.5b (#98): the "Switch off" / "Switch on" page for a kill switch. The
// reason is required (the handler refuses an empty one too); it goes into
// admin_actions with the old and new value. The customer message is fixed in
// code and shown here only so the admin knows what people will see.

const FeatureSwitchToggle = (props) => {
  const { record, resource, action } = props;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const addNotice = useNotice();
  const key = record?.params?.key;
  const turningOn = action.name === 'switchOn';

  const submit = async (event) => {
    event.preventDefault();
    if (!reason.trim()) {
      addNotice({ message: 'Type a reason first.', type: 'error' });
      return;
    }
    setBusy(true);
    try {
      const data = new FormData();
      data.append('reason', reason.trim());
      const response = await new ApiClient().recordAction({
        resourceId: resource.id,
        recordId: record.id,
        actionName: action.name,
        data,
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (response.data.notice) addNotice(response.data.notice);
      if (response.data.redirectUrl && response.data.notice?.type !== 'error') {
        window.location.href = response.data.redirectUrl;
      }
    } catch (err) {
      addNotice({ message: err.message || 'Could not change the switch.', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box as="form" onSubmit={submit} p="xl" variant="white">
      <H3>{turningOn ? 'Switch on' : 'Switch off'}: {key}</H3>
      <Text mb="lg">
        {turningOn
          ? 'This switches the feature back on for everyone within 15 seconds.'
          : 'This stops the feature for everyone within 15 seconds. Orders already in progress, refunds, webhooks, cash OTP, cancellations and store order handling are never blocked.'}
      </Text>
      {!turningOn && record?.params?.message_when_off ? (
        <Text mb="lg">Customers will see: "{record.params.message_when_off}"</Text>
      ) : null}
      <Label required>Reason (kept in the audit log)</Label>
      <TextArea
        width="100%"
        rows={3}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Box mt="lg">
        <Button type="submit" variant={turningOn ? 'primary' : 'danger'} disabled={busy || !reason.trim()}>
          {busy ? 'Saving…' : (turningOn ? `Switch ${key} on` : `Switch ${key} off`)}
        </Button>
      </Box>
    </Box>
  );
};

export default FeatureSwitchToggle;
