import {
  readonlySnapshot,
  type DeepReadonly,
  type RuntimeLease,
  type StateReader,
  type TaskSnapshotV2 as TaskSnapshot,
} from '@qqbot/contracts';
import { createTaskLifeCycleManagerV2 } from '../../src/task/index.js';
import { createPipelineStats } from '../../src/observability/index.js';
import { createRuntimePool } from '../../src/runtime/index.js';
import { createSessionContextView } from '../../src/session/index.js';

export function verifyContextView(
  view: ReturnType<ReturnType<typeof createSessionContextView>['read']>
): void {
  // @ts-expect-error View task lists cannot be extended by a consumer.
  view.tasks.push({});
  // @ts-expect-error Per-lane delivery is a read-only projection.
  view.tasks[0]!.lanes.slow.delivery = 'sent';
  // @ts-expect-error Nested scope belongs to the captured read.
  view.scope.generation = 99;
}

/** Compile-only consumer: each expected error must remain an actual TypeScript rejection. */
export function verifyTaskSnapshots(
  task: DeepReadonly<TaskSnapshot>,
  manager: ReturnType<typeof createTaskLifeCycleManagerV2>
): void {
  // @ts-expect-error Task execution state belongs to its lifecycle owner.
  task.lanes.fast.status = 'completed';
  // @ts-expect-error An input's generation is immutable after admission.
  task.input.generation = 2;
  // @ts-expect-error Reference ownership includes nested original-message fields.
  task.input.reference.messageId = 'replacement';
  // @ts-expect-error Consumers cannot append to the captured observation window.
  task.input.context.window.push({});
  const current = manager.get(task.taskId);
  // @ts-expect-error A task list cannot be rewritten or extended by its consumer.
  manager.list().push(task);
  if (current) {
    // @ts-expect-error The production public factory returns the same deep contract.
    current.input.message.target.key = 'different-session';
    // @ts-expect-error Production manager snapshots expose no execution write capability.
    current.lanes.slow.status = 'failed';
  }
}

export function verifyDelivery(
  queue: import('@qqbot/contracts').MessageQueue,
  actor: import('@qqbot/contracts').SessionActorV2,
  observer: import('@qqbot/contracts').AgentTraceObserver
): void {
  // @ts-expect-error The public message list is immutable, including its array.
  queue.messages().pop();
  // @ts-expect-error Delivery counters are observations, not write capabilities.
  queue.snapshot().sent = 10;
  queue.onDelivery((result) => {
    // @ts-expect-error Delivery status is owned only by the message queue.
    result.status = 'failed';
  });
  // @ts-expect-error Actor snapshots include deep read-only scheduler counters.
  actor.snapshot().fast.running = 10;
  // @ts-expect-error The observer's nested usage snapshot cannot be mutated.
  observer.snapshot().usage.input = 100;
}

export function verifyCollections(): void {
  const snapshot = readonlySnapshot({
    items: [{ nested: { value: 1 } }],
    map: new Map([['id', { value: 1 }]]),
    set: new Set([{ value: 1 }]),
    bytes: new Uint8Array([1, 2, 3]),
  });
  // @ts-expect-error Arrays in deep snapshots have no append capability.
  snapshot.items.push({ nested: { value: 2 } });
  // @ts-expect-error Nested objects are immutable.
  snapshot.items[0]!.nested.value = 3;
  // @ts-expect-error A read-only map has no set capability.
  snapshot.map.set('other', { value: 2 });
  // @ts-expect-error Map entries are deep read-only values.
  snapshot.map.get('id')!.value = 4;
  // @ts-expect-error A read-only set has no add capability.
  snapshot.set.add({ value: 4 });
  // @ts-expect-error Set values are deep read-only.
  [...snapshot.set][0]!.value = 5;
  // @ts-expect-error Byte snapshots do not permit index writes.
  snapshot.bytes[0] = 5;
  // @ts-expect-error Byte snapshots do not expose bulk mutation.
  snapshot.bytes.set([5]);
  // @ts-expect-error Byte snapshots do not expose fill mutation.
  snapshot.bytes.fill(5);
  // @ts-expect-error Byte snapshots do not expose in-place sorting.
  snapshot.bytes.sort();
}

export function verifyStatistics(stats: ReturnType<typeof createPipelineStats>): void {
  stats.record('received');
  stats.recordDistribution('proactiveWaitTickets', 'cancelled');
  // @ts-expect-error Statistics change through record, never a writable getter.
  stats.received++;
  // @ts-expect-error Distribution getters do not expose mutable records.
  stats.proactiveWaitTickets.cancelled = 2;
  const snapshot = stats.snapshot();
  // @ts-expect-error Snapshot counters cannot be written.
  snapshot.received = 10;
  // @ts-expect-error Snapshot distributions remain read-only.
  snapshot.proactiveWaitTickets.cancelled = 10;
}

export function verifyLease(lease: RuntimeLease, pool: ReturnType<typeof createRuntimePool>): void {
  // @ts-expect-error Consumers cannot replace a lease identity.
  lease.leaseId = 'replacement';
  // @ts-expect-error The pool owns busy; a lease has no such write capability.
  lease.busy = false;
  // @ts-expect-error Child-agent sets remain inside the pool.
  lease.activeChildren.clear();
  // @ts-expect-error A lease consumer cannot dispose the underlying runtime.
  lease.runtime.dispose();
  const state = pool.snapshot(lease);
  if (state) {
    // @ts-expect-error Diagnostic busy state is read-only.
    state.busy = false;
    // @ts-expect-error Diagnostic child-agent values are read-only.
    state.activeChildren.push('replacement');
  }
}

export function verifyReadCapability(reader: StateReader<TaskSnapshot>): void {
  reader.load();
  // @ts-expect-error Reading a state namespace does not grant its owner's write capability.
  reader.save([]);
}
