import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import statsRouter from './routes/stats';
import connectionsRouter from './routes/connections';
import cronRouter from './routes/cron';
import webhooksRouter from './routes/webhooks';

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/stats', statsRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/cron', cronRouter);
app.use('/api/webhooks', webhooksRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

export default app;
