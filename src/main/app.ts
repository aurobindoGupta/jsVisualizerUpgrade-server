import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import pino from 'pino';
import { Worker } from 'worker_threads';
import { launchWorker } from './launchWorker';
import { reduceEvents } from './eventsReducer';

const logger = pino({
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  logger.info('Client connected');
  let currentWorker: Worker | null = null;

  ws.on('message', async (raw: Buffer) => {
    let message: { type: string; payload: unknown };

    try {
      message = JSON.parse(raw.toString()) as { type: string; payload: unknown };
    } catch {
      logger.warn('Received malformed JSON — ignoring');
      return;
    }

    if (message.type !== 'RunCode') {
      logger.warn({ type: message.type }, 'Unknown message type');
      return;
    }

    if (typeof message.payload !== 'string') {
      logger.warn('RunCode payload must be a string');
      return;
    }

    // Terminate any in-progress worker before starting a new one
    if (currentWorker) {
      await currentWorker.terminate();
      currentWorker = null;
    }

    const { promise, worker } = launchWorker(message.payload);
    currentWorker = worker;

    try {
      const events = await promise;
      const reducedEvents = reduceEvents(events);
      logger.info({ eventCount: reducedEvents.length }, 'Sending events to client');
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(reducedEvents));
      }
    } catch (err) {
      logger.error({ err }, 'Worker execution error');
    } finally {
      currentWorker = null;
    }
  });

  ws.on('close', async () => {
    logger.info('Client disconnected');
    if (currentWorker) {
      await currentWorker.terminate();
      currentWorker = null;
    }
  });

  ws.on('error', (err: Error) => {
    logger.error({ err }, 'WebSocket error');
  });
});

const port = process.env.PORT ?? 8080;
server.listen(port, () => {
  logger.info({ port }, 'Server listening');
});
