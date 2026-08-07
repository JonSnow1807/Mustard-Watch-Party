import { Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Server-side half of every future load graph. Label cardinality is
 * deliberately tiny (event names only, never room codes). instance_id
 * label lets multi-instance lab scrapes join cleanly.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly wsConnectedClients = new Gauge({
    name: 'ws_connected_clients',
    help: 'currently connected sockets',
    labelNames: ['namespace'],
    registers: [this.registry],
  });

  readonly wsRoomsActive = new Gauge({
    name: 'ws_rooms_active',
    help: 'rooms with at least one connected socket',
    registers: [this.registry],
  });

  readonly wsEventsReceived = new Counter({
    name: 'ws_events_received_total',
    help: 'client->server events received',
    labelNames: ['event'],
    registers: [this.registry],
  });

  readonly wsHandlerDuration = new Histogram({
    name: 'ws_event_handler_duration_seconds',
    help: 'handler wall time incl. store/db awaits',
    labelNames: ['event'],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [this.registry],
  });

  readonly wsBroadcastFanout = new Histogram({
    name: 'ws_broadcast_fanout_size',
    help: 'recipients per timeline broadcast',
    buckets: [1, 2, 5, 10, 25, 50, 100, 250],
    registers: [this.registry],
  });

  readonly controlEvents = new Counter({
    name: 'control_events_total',
    help: 'sync:control outcomes',
    labelNames: ['type', 'result'],
    registers: [this.registry],
  });

  // no cmdId label on purpose: client-controlled strings in label values
  // are an unbounded-cardinality DoS
  readonly controlDedupHits = new Counter({
    name: 'control_dedup_hits_total',
    help: 'control commands answered from the idempotency record',
    labelNames: ['type'],
    registers: [this.registry],
  });

  readonly redisOpDuration = new Histogram({
    name: 'redis_op_duration_seconds',
    help: 'state-store operation latency',
    labelNames: ['op'],
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
    registers: [this.registry],
  });

  constructor() {
    this.registry.setDefaultLabels({
      instance_id: process.env.INSTANCE_ID ?? hostname(),
    });
    collectDefaultMetrics({ register: this.registry });
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }
}
