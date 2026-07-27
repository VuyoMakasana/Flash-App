import React, { useState } from 'react';
import { ApiClient } from 'adminjs';
import { Box, H2, H4, Text, Input, Button, Table, TableRow, TableCell, TableHead, TableBody } from '@adminjs/design-system';

// Phase 4 (individual user lookup). users still can't be a real AdminJS
// resource (schema collision -- see adminPanel.js's suppressReference
// comment), and "find one specific customer and see their full profile" is
// a different real need than "browse every user" anyway -- so this is a
// dedicated search-then-view AdminJS page, not a resource. Real data,
// fetched via Admin.searchUsers/getUserProfile (adminPanel.js's userLookup
// page handler) -- no separate reimplementation of those queries here.

function money(value) {
  const n = Number(value || 0);
  return `R${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const UserLookup = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const runSearch = async (e) => {
    e.preventDefault();
    setError(null);
    setProfile(null);
    setLoading(true);
    try {
      const response = await new ApiClient().getPage({ pageName: 'userLookup', params: { q: query } });
      setResults(response.data.results || []);
    } catch (err) {
      setError(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const viewProfile = async (userId) => {
    setError(null);
    setLoading(true);
    try {
      const response = await new ApiClient().getPage({ pageName: 'userLookup', params: { userId } });
      setProfile(response.data.profile);
    } catch (err) {
      setError(err.message || 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box p="xxl">
      <H2 mb="xl">User Lookup</H2>

      <Box as="form" onSubmit={runSearch} flex flexDirection="row" mb="xl">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, email, or phone"
          mr="default"
          width={320}
        />
        <Button type="submit" variant="contained" disabled={loading}>Search</Button>
      </Box>

      {error && <Text color="danger" mb="lg">{error}</Text>}
      {loading && <Text mb="lg">Loading...</Text>}

      {results && !profile && (
        <Box mb="xl">
          <Text color="grey60" mb="default">{results.length} match{results.length === 1 ? '' : 'es'}</Text>
          {results.map((u) => (
            <Box key={u.id} variant="grey" p="default" mb="default" flex flexDirection="row" justifyContent="space-between" alignItems="center">
              <Box>
                <Text fontWeight="bold">{u.name}</Text>
                <Text fontSize="sm" color="grey60">{u.email} — {u.phone || 'no phone'}</Text>
              </Box>
              <Button size="sm" onClick={() => viewProfile(u.id)}>View profile</Button>
            </Box>
          ))}
        </Box>
      )}

      {profile && (
        <Box>
          <Button size="sm" mb="lg" onClick={() => setProfile(null)}>&larr; Back to results</Button>

          <Box variant="grey" p="lg" mb="xl">
            <H4>{profile.user.name}</H4>
            <Text>{profile.user.email} — {profile.user.phone || 'no phone'}</Text>
            <Text fontSize="sm" color="grey60">Joined {new Date(profile.user.created_at).toLocaleDateString()}</Text>
            {profile.user.flagged_for_cash_abuse && (
              <Text color="danger" fontWeight="bold" mt="default">
                ⚠ Flagged for cash abuse — {profile.user.cash_refusal_count} refusal(s)
              </Text>
            )}
          </Box>

          <H4 mb="default">Recent orders ({profile.orders.length})</H4>
          {profile.orders.length === 0 ? <Text mb="xl">No orders yet.</Text> : (
            <Table mb="xl">
              <TableHead>
                <TableRow>
                  <TableCell>Order</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Total</TableCell>
                  <TableCell>Date</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {profile.orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>{o.order_number}</TableCell>
                    <TableCell>{o.status}</TableCell>
                    <TableCell>{money(o.total)}</TableCell>
                    <TableCell>{new Date(o.created_at).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <H4 mb="default">Saved addresses ({profile.addresses.length})</H4>
          {profile.addresses.length === 0 ? <Text mb="xl">No saved addresses.</Text> : (
            <Box mb="xl">
              {profile.addresses.map((a) => (
                <Text key={a.id} mb="sm">
                  {a.is_default ? '★ ' : ''}{a.label}: {a.street}{a.suburb ? `, ${a.suburb}` : ''}{a.city ? `, ${a.city}` : ''}
                </Text>
              ))}
            </Box>
          )}

          <H4 mb="default">Trusted drivers ({profile.trustedDrivers.length})</H4>
          {profile.trustedDrivers.length === 0 ? <Text>None.</Text> : (
            profile.trustedDrivers.map((td) => (
              <Text key={td.id} mb="sm">{td.driver_name} ({td.driver_phone || 'no phone'}) — {td.status}</Text>
            ))
          )}
        </Box>
      )}
    </Box>
  );
};

export default UserLookup;
