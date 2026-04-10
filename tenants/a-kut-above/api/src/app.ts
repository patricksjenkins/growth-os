import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { errorHandler } from './middleware/errorHandler';

// Routes
import authRoutes from './routes/auth';
import leadRoutes from './routes/leads';
import jobRoutes from './routes/jobs';
import photoRoutes from './routes/photos';
import outreachRoutes from './routes/outreach';
import contentRoutes from './routes/content';
import reportRoutes from './routes/reports';
import automationRoutes from './routes/automations';
import webhookRoutes from './routes/webhooks';
import financeRoutes from './routes/finance';

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
});
app.use('/api/', limiter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'a-kut-above-api' });
});


// Routes
app.use('/api/auth', authRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/photos', photoRoutes);
app.use('/api/outreach', outreachRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/automations', automationRoutes);
app.use('/api/finance', financeRoutes);
app.use('/webhooks', webhookRoutes);

// Error handler
app.use(errorHandler);

export default app;
