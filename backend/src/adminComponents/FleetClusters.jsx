import React, { useEffect, useState } from 'react';
import { ApiClient } from 'adminjs';
import { Box, H2, Text, Table, TableHead, TableBody, TableRow, TableCell, Button } from '@adminjs/design-system';

// Phase 4 -- Flash Fleet demand-cluster view (backend already fully built:
// Fleet.getClusters(), the same real query fleetController.js's own
// GET /api/fleet/clusters uses). A real AdminJS page, not a resource --
// this isn't backed by one browsable table, it's a computed aggregate over
// browsing_events in the last 20 minutes. Loads once on page visit, plus a
// manual refresh button -- no auto-polling, matching the same "periodic
// pull, not a live socket feed" reasoning already applied to the dashboard
// (Addendum 2 §5) -- this data changes on the same timescale, and nothing
// here needs sub-minute freshness for how an admin would actually use it.

const FleetClusters = () => {
  const [clusters, setClusters] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError(null);
    new ApiClient().getPage({ pageName: 'fleetClusters' })
      .then((response) => setClusters(response.data.clusters || []))
      .catch((err) => setError(err.message || 'Failed to load clusters'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <Box p="xxl">
      <Box flex flexDirection="row" justifyContent="space-between" alignItems="center" mb="xl">
        <H2>Flash Fleet — Demand Clusters</H2>
        <Button onClick={load} disabled={loading}>Refresh</Button>
      </Box>
      <Text color="grey60" mb="lg">
        Categories with 2 or more people browsing nearby in the last 20 minutes — informational only, never pushed to drivers directly.
      </Text>

      {error && <Text color="danger">{error}</Text>}
      {loading && <Text>Loading...</Text>}

      {clusters && !loading && (
        clusters.length === 0 ? (
          <Text>No active demand clusters right now.</Text>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Category</TableCell>
                <TableCell>City</TableCell>
                <TableCell>Center (lat, lng)</TableCell>
                <TableCell>Users browsing</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {clusters.map((c, i) => (
                <TableRow key={i}>
                  <TableCell>{c.category}</TableCell>
                  <TableCell>{c.city || '(unknown)'}</TableCell>
                  <TableCell>{c.center_lat}, {c.center_lng}</TableCell>
                  <TableCell>{c.user_count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      )}
    </Box>
  );
};

export default FleetClusters;
