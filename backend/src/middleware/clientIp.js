'use strict';

// Admin hardening A0 (#87): the real client address, for every rate limiter
// and log line.
//
// Production requests reach this app as: client -> Cloudflare edge -> Render
// proxies -> app. They arrive with a 3-entry X-Forwarded-For
// (client, Cloudflare edge, Render internal) plus CF-Connecting-IP and
// True-Client-IP. With `trust proxy 1` (server.js), Express's req.ip is the
// RIGHT-MOST X-Forwarded-For entry: a Render-internal proxy address. Every
// client arriving through the same proxy shared one rate-limit counter, and
// one client got a different counter per Cloudflare edge.
//
// Which header is trusted, and why it can't be forged on Render:
//   CF-Connecting-IP, and only when RENDER=true. Cloudflare sets it on every
//   request it proxies to the client address it saw, replacing any value the
//   client sent. A Render web service has no public origin address: it is
//   only reachable through Render's edge, which is behind Cloudflare. So on
//   Render a client cannot reach the app without passing Cloudflare, and
//   cannot choose this header.
//   X-Forwarded-For is never used for the key: a client can prepend anything
//   to it. True-Client-IP carries the same value but is not needed.
//   Off Render (local, CI) nothing sets CF-Connecting-IP, so it is NOT
//   trusted there: anyone could send it. The proxy-derived address is used.
//   A missing or malformed CF-Connecting-IP also falls back to that address,
//   so the key is never empty.

const net = require('net');
const express = require('express');

// Express's own req.ip getter (trust-proxy aware), kept as the fallback.
const expressIpGetter = Object.getOwnPropertyDescriptor(express.request, 'ip').get;

function clientIpFrom(req, { onRender = process.env.RENDER === 'true' } = {}) {
  const fallback = req.ip;
  if (!onRender) return fallback;
  const raw = req.headers && req.headers['cf-connecting-ip'];
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  return net.isIP(value) ? value : fallback;
}

// Mounted first in createApp(): makes req.ip the real client for everything
// after it (every express-rate-limit limiter keys on req.ip by default; the
// error handler logs it; AdminJS's own login retry guard reads it).
function realClientIp(req, res, next) {
  const resolved = clientIpFrom({ headers: req.headers, ip: expressIpGetter.call(req) });
  Object.defineProperty(req, 'ip', { value: resolved, configurable: true, enumerable: true, writable: false });
  next();
}

module.exports = { clientIpFrom, realClientIp };
