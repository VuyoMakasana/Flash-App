// ADDED: PM2 process configuration
// WHY: The backend was started with plain 'node server.js' — if it crashed at any
// point (unhandled error, memory issue, anything) it would stay dead until someone
// manually restarted it. PM2 provides auto-restart, crash logging, and memory limits.
module.exports = {
  apps: [{
    name: 'flash-backend',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 3000,
    max_restarts: 10,
    min_uptime: '10s',
  }],
};
